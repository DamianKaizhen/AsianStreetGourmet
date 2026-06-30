// /api/admin/menu — admin-only menu queries and per-item updates.
//
// GET   /api/admin/menu                                                   → list with ingredients (archived hidden)
// PATCH /api/admin/menu  { code, is_available?, rotation_mode? }          → update one menu item
// PATCH /api/admin/menu  { schedule_day, soup_code }                      → upsert daily soup assignment
// PATCH /api/admin/menu  { special: {code,name_zh,name_en,price_cents} }  → set today's special
// PATCH /api/admin/menu  { special: null }                                → clear today's special
//
// PATCH takes a body-shape discriminator (presence of `schedule_day` or
// `special` key) so the daily-soup + today's-special writes can share this
// endpoint with the per-item updates and keep the Vercel function count at
// 11/12.

import { sql } from '../../lib/db.js';
import { requireAdmin } from '../../lib/auth.js';
import { setSetting } from '../../lib/settings.js';

const ALLOWED_MODES = ['always', 'rotation'];

async function handler(req, res) {
  if (req.method === 'GET') {
    // Archived rows are excluded so the admin sees only the current menu.
    const rows = await sql`
      SELECT
        m.id, m.code, m.name_en, m.name_zh, m.category, m.price_cents,
        m.rotation_mode, m.is_available, m.display_order, m.updated_at,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id',           i.id,
              'slug',         i.slug,
              'name_en',      i.name_en,
              'name_zh',      i.name_zh,
              'category',     i.category,
              'is_pantry',    i.is_pantry,
              'is_available', i.is_available
            ) ORDER BY i.category, i.name_en
          ) FILTER (WHERE i.id IS NOT NULL),
          '[]'::json
        ) AS ingredients
      FROM menu_items m
      LEFT JOIN menu_item_ingredients mii ON mii.menu_item_id = m.id
      LEFT JOIN ingredients i ON i.id = mii.ingredient_id
      WHERE m.is_archived = FALSE
      GROUP BY m.id
      ORDER BY m.display_order
    `;
    return res.status(200).json({ menu_items: rows });
  }

  if (req.method === 'PATCH') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    // ----- Branch S: today's special set/clear -----
    // Body shape: { special: { code, name_zh, name_en, price_cents } | null }
    if ('special' in body) {
      const sp = body.special;
      if (sp === null) {
        // Clear by writing empty strings (a simple sentinel; cheaper than
        // deleting rows, and lets the GET path remain a plain lookup).
        await setSetting('special_code', '');
        await setSetting('special_name_zh', '');
        await setSetting('special_name_en', '');
        await setSetting('special_price_cents', '');
        return res.status(200).json({ special: null });
      }
      if (typeof sp !== 'object') {
        return res.status(400).json({ error: 'special must be object or null' });
      }
      const code    = typeof sp.code === 'string' ? sp.code.trim().toUpperCase() : '';
      const name_zh = typeof sp.name_zh === 'string' ? sp.name_zh.trim() : '';
      const name_en = typeof sp.name_en === 'string' ? sp.name_en.trim() : '';
      const price_cents = Number(sp.price_cents);
      if (!code || code.length > 8 || !/^[A-Z0-9]+$/.test(code)) {
        return res.status(400).json({ error: 'special.code must be 1–8 alphanumeric chars' });
      }
      if (!name_zh || name_zh.length > 60) {
        return res.status(400).json({ error: 'special.name_zh required (≤60 chars)' });
      }
      if (!name_en || name_en.length > 80) {
        return res.status(400).json({ error: 'special.name_en required (≤80 chars)' });
      }
      if (!Number.isInteger(price_cents) || price_cents < 0 || price_cents > 100000) {
        return res.status(400).json({ error: 'special.price_cents must be integer 0..100000' });
      }
      await setSetting('special_code', code);
      await setSetting('special_name_zh', name_zh);
      await setSetting('special_name_en', name_en);
      await setSetting('special_price_cents', String(price_cents));
      return res.status(200).json({ special: { code, name_zh, name_en, price_cents } });
    }

    // ----- Branch A: daily-soup schedule write -----
    // Body shape: { schedule_day: 0..6, soup_code: 'C2' | null }
    if ('schedule_day' in body) {
      const day = Number(body.schedule_day);
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        return res.status(400).json({ error: 'schedule_day must be integer 0..6' });
      }
      let soupCode = body.soup_code;
      if (soupCode === undefined) {
        return res.status(400).json({ error: 'soup_code is required (use null to clear)' });
      }
      if (soupCode !== null) {
        soupCode = String(soupCode).toUpperCase();
        if (!/^C[0-9]+$/.test(soupCode)) {
          return res.status(400).json({ error: 'soup_code must be a C-prefixed menu code or null' });
        }
        // Confirm the code exists and is actually a soup (and isn't archived).
        const check = await sql`
          SELECT 1 FROM menu_items
          WHERE code = ${soupCode} AND category = 'soup' AND is_archived = FALSE
        `;
        if (check.length === 0) {
          return res.status(404).json({ error: 'soup_code not found among active soups' });
        }
      }
      const rows = await sql`
        INSERT INTO soup_schedule (day_of_week, soup_code, updated_at)
        VALUES (${day}, ${soupCode}, NOW())
        ON CONFLICT (day_of_week) DO UPDATE
          SET soup_code = EXCLUDED.soup_code,
              updated_at = NOW()
        RETURNING day_of_week, soup_code, updated_at
      `;
      return res.status(200).json({ schedule: rows[0] });
    }

    // ----- Branch B: per-item update (existing behaviour) -----
    const code = String(body.code || '').toUpperCase();
    if (!/^[ABCD][0-9]+$/.test(code)) {
      return res.status(400).json({ error: 'invalid or missing menu code' });
    }

    const updates = {};
    if ('is_available' in body) {
      if (typeof body.is_available !== 'boolean') return res.status(400).json({ error: 'is_available must be boolean' });
      updates.is_available = body.is_available;
    }
    if ('rotation_mode' in body) {
      if (!ALLOWED_MODES.includes(body.rotation_mode)) {
        return res.status(400).json({ error: `rotation_mode must be one of ${ALLOWED_MODES.join(', ')}` });
      }
      updates.rotation_mode = body.rotation_mode;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no updatable fields provided' });
    }

    const u = {
      is_available:  'is_available'  in updates ? updates.is_available  : null,
      rotation_mode: 'rotation_mode' in updates ? updates.rotation_mode : null,
    };

    const rows = await sql`
      UPDATE menu_items SET
        is_available  = COALESCE(${u.is_available}::boolean, is_available),
        rotation_mode = COALESCE(${u.rotation_mode},         rotation_mode),
        updated_at    = NOW()
      WHERE code = ${code} AND is_archived = FALSE
      RETURNING id, code, is_available, rotation_mode, updated_at
    `;

    if (rows.length === 0) return res.status(404).json({ error: 'menu item not found' });
    return res.status(200).json({ menu_item: rows[0] });
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
}

export default requireAdmin(handler);
