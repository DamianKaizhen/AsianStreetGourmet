// /api/admin/menu — admin-only menu queries + full CRUD on items.
//
// GET    /api/admin/menu                                                    → list active (non-archived) items
// POST   /api/admin/menu   { code, name_zh, name_en, category, price_cents } → create new item
// PATCH  /api/admin/menu   { id, code?, name_en?, name_zh?, price_cents?, is_available?, rotation_mode? } → update one item
// PATCH  /api/admin/menu   { schedule_day, soup_code }                      → upsert daily soup assignment
// PATCH  /api/admin/menu   { specials: [...] | [] }                         → replace today's specials list
// DELETE /api/admin/menu   { id }                                           → soft-delete (archive + suffix the code)
//
// PATCH uses body-shape discriminators so the daily-soup + today's-specials
// writes can share this endpoint with the per-item updates — keeps the
// Vercel function count at 11/12 (no new file per write type).

import { sql } from '../../lib/db.js';
import { requireAdmin } from '../../lib/auth.js';
import { setSetting } from '../../lib/settings.js';

const ALLOWED_MODES = ['always', 'rotation'];
// Category names that the admin UI can create new items in. The soup
// category is technically allowed but only items with codes prefixed with C
// would render on the public site, so we don't restrict it server-side —
// the UI guides the family toward the right shapes.
const ALLOWED_CATEGORIES = ['steam', 'soup', 'snack'];
// Item codes are `<single uppercase letter><digits>`. Wider than the old
// [ABCD] regex so admins can add an "E1" or "F2" without collisions.
const CODE_REGEX = /^[A-Z][0-9]+$/;

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

    // ----- Branch S: today's specials replace-all -----
    // Body shape: { specials: [ { code, name_zh, name_en, price_cents }, ... ] }
    // An empty array clears all specials. Validates every row; any failure
    // returns 400 and writes nothing (atomic-ish — settings table is a single
    // INSERT/UPDATE so a JSON-array column lets us replace the whole list).
    if ('specials' in body) {
      const raw = body.specials;
      if (!Array.isArray(raw)) {
        return res.status(400).json({ error: 'specials must be an array' });
      }
      if (raw.length > 20) {
        return res.status(400).json({ error: 'too many specials (max 20)' });
      }
      const cleaned = [];
      for (let i = 0; i < raw.length; i++) {
        const sp = raw[i];
        if (!sp || typeof sp !== 'object') {
          return res.status(400).json({ error: `specials[${i}] must be an object` });
        }
        const code    = typeof sp.code === 'string' ? sp.code.trim().toUpperCase() : '';
        const name_zh = typeof sp.name_zh === 'string' ? sp.name_zh.trim() : '';
        const name_en = typeof sp.name_en === 'string' ? sp.name_en.trim() : '';
        const price_cents = Number(sp.price_cents);
        if (!code || code.length > 8 || !/^[A-Z0-9]+$/.test(code)) {
          return res.status(400).json({ error: `specials[${i}].code must be 1–8 alphanumeric chars` });
        }
        if (!name_zh || name_zh.length > 60) {
          return res.status(400).json({ error: `specials[${i}].name_zh required (≤60 chars)` });
        }
        if (!name_en || name_en.length > 80) {
          return res.status(400).json({ error: `specials[${i}].name_en required (≤80 chars)` });
        }
        if (!Number.isInteger(price_cents) || price_cents < 0 || price_cents > 100000) {
          return res.status(400).json({ error: `specials[${i}].price_cents must be integer 0..100000` });
        }
        cleaned.push({ code, name_zh, name_en, price_cents });
      }
      // Reject duplicate codes within the same batch (would confuse the
      // cart's per-code lookup at order time).
      const dupInBatch = cleaned.map((s) => s.code).filter((c, i, a) => a.indexOf(c) !== i);
      if (dupInBatch.length > 0) {
        return res.status(400).json({ error: 'duplicate code within specials', duplicate_codes: dupInBatch });
      }
      // Reject codes that also exist as active menu items. Same code in
      // both places makes cart resolution ambiguous — the customer would
      // see one price on the menu row and a different one on the special
      // card, but the order would silently pick whichever the server
      // resolves first. Force the admin to use unique codes for specials
      // (e.g. `T1`, `TS1`) so the two lists never overlap.
      if (cleaned.length > 0) {
        const codes = cleaned.map((s) => s.code);
        const conflicts = await sql`
          SELECT code FROM menu_items
          WHERE code = ANY(${codes}) AND is_archived = FALSE
        `;
        if (conflicts.length > 0) {
          return res.status(409).json({
            error: 'special code already used by an active menu item',
            conflict_codes: conflicts.map((c) => c.code),
          });
        }
      }
      // Stored as a JSON string in the single key-value settings row. Empty
      // array still gets written ('[]') as the explicit "no specials" state.
      await setSetting('specials_json', JSON.stringify(cleaned));
      return res.status(200).json({ specials: cleaned });
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

    // ----- Branch C: per-item update -----
    // Body shape (lookup-by-id):
    //   { id, code?, name_en?, name_zh?, price_cents?, is_available?, rotation_mode? }
    // Backward-compat: if `id` is absent but `code` is present, treat the
    // `code` field as a lookup key (legacy single-toggle pattern) and only
    // accept `is_available` / `rotation_mode`.
    const lookupId = Number.parseInt(body.id, 10);
    const hasId = Number.isInteger(lookupId) && lookupId > 0;
    const lookupCode = !hasId && typeof body.code === 'string'
      ? String(body.code).trim().toUpperCase()
      : null;

    if (!hasId && !lookupCode) {
      return res.status(400).json({ error: 'id or code required for update' });
    }
    if (lookupCode && !CODE_REGEX.test(lookupCode)) {
      return res.status(400).json({ error: 'invalid code lookup' });
    }

    // Build the set of updatable fields. `id`-based PATCH allows all six;
    // `code`-based PATCH (legacy) is intentionally limited to the toggles.
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
    if (hasId && 'code' in body) {
      const newCode = String(body.code || '').trim().toUpperCase();
      if (!CODE_REGEX.test(newCode)) {
        return res.status(400).json({ error: 'code must be uppercase letter + digits (e.g. A8)' });
      }
      // Reject if the new code is already in use by a different active item.
      const dup = await sql`
        SELECT id FROM menu_items
        WHERE code = ${newCode} AND id <> ${lookupId} AND is_archived = FALSE
      `;
      if (dup.length > 0) {
        return res.status(409).json({ error: 'code already in use by another active item' });
      }
      updates.code = newCode;
    }
    if (hasId && 'name_en' in body) {
      const v = typeof body.name_en === 'string' ? body.name_en.trim() : '';
      if (!v || v.length > 120) return res.status(400).json({ error: 'name_en required (≤120 chars)' });
      updates.name_en = v;
    }
    if (hasId && 'name_zh' in body) {
      const v = typeof body.name_zh === 'string' ? body.name_zh.trim() : '';
      if (!v || v.length > 60) return res.status(400).json({ error: 'name_zh required (≤60 chars)' });
      updates.name_zh = v;
    }
    if (hasId && 'price_cents' in body) {
      const v = Number(body.price_cents);
      if (!Number.isInteger(v) || v < 0 || v > 100000) {
        return res.status(400).json({ error: 'price_cents must be integer 0..100000' });
      }
      updates.price_cents = v;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no updatable fields provided' });
    }

    const u = {
      is_available:  'is_available'  in updates ? updates.is_available  : null,
      rotation_mode: 'rotation_mode' in updates ? updates.rotation_mode : null,
      code:          'code'          in updates ? updates.code          : null,
      name_en:       'name_en'       in updates ? updates.name_en       : null,
      name_zh:       'name_zh'       in updates ? updates.name_zh       : null,
      price_cents:   'price_cents'   in updates ? updates.price_cents   : null,
    };

    const rows = hasId
      ? await sql`
          UPDATE menu_items SET
            is_available  = COALESCE(${u.is_available}::boolean,  is_available),
            rotation_mode = COALESCE(${u.rotation_mode},          rotation_mode),
            code          = COALESCE(${u.code},                   code),
            name_en       = COALESCE(${u.name_en},                name_en),
            name_zh       = COALESCE(${u.name_zh},                name_zh),
            price_cents   = COALESCE(${u.price_cents}::integer,   price_cents),
            updated_at    = NOW()
          WHERE id = ${lookupId} AND is_archived = FALSE
          RETURNING id, code, name_en, name_zh, category, price_cents, is_available, rotation_mode, updated_at
        `
      : await sql`
          UPDATE menu_items SET
            is_available  = COALESCE(${u.is_available}::boolean, is_available),
            rotation_mode = COALESCE(${u.rotation_mode},         rotation_mode),
            updated_at    = NOW()
          WHERE code = ${lookupCode} AND is_archived = FALSE
          RETURNING id, code, is_available, rotation_mode, updated_at
        `;

    if (rows.length === 0) return res.status(404).json({ error: 'menu item not found' });
    return res.status(200).json({ menu_item: rows[0] });
  }

  // =========================================================
  // POST — create a new menu item
  // =========================================================
  if (req.method === 'POST') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const code     = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    const name_en  = typeof body.name_en === 'string' ? body.name_en.trim() : '';
    const name_zh  = typeof body.name_zh === 'string' ? body.name_zh.trim() : '';
    const category = typeof body.category === 'string' ? body.category.trim().toLowerCase() : '';
    const price_cents = Number(body.price_cents);

    if (!CODE_REGEX.test(code)) {
      return res.status(400).json({ error: 'code must be uppercase letter + digits (e.g. A8)' });
    }
    if (!ALLOWED_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of ${ALLOWED_CATEGORIES.join(', ')}` });
    }
    if (!name_en || name_en.length > 120) return res.status(400).json({ error: 'name_en required (≤120 chars)' });
    if (!name_zh || name_zh.length > 60)  return res.status(400).json({ error: 'name_zh required (≤60 chars)' });
    if (!Number.isInteger(price_cents) || price_cents < 0 || price_cents > 100000) {
      return res.status(400).json({ error: 'price_cents must be integer 0..100000' });
    }

    // Reject duplicate codes among ACTIVE items. Archived rows with the same
    // base name (renamed with `_archived_<id>`) won't collide because their
    // code carries the suffix.
    const dup = await sql`SELECT 1 FROM menu_items WHERE code = ${code} AND is_archived = FALSE`;
    if (dup.length > 0) return res.status(409).json({ error: 'code already exists' });

    // Pick a display_order one higher than the current max in the same
    // category so the new item lands at the bottom of its section.
    const maxRow = await sql`
      SELECT COALESCE(MAX(display_order), 0) AS max FROM menu_items WHERE category = ${category}
    `;
    const display_order = (maxRow[0]?.max || 0) + 1;

    const rows = await sql`
      INSERT INTO menu_items (code, name_en, name_zh, category, price_cents, display_order, is_available)
      VALUES (${code}, ${name_en}, ${name_zh}, ${category}, ${price_cents}, ${display_order}, TRUE)
      RETURNING id, code, name_en, name_zh, category, price_cents, is_available, display_order, updated_at
    `;
    return res.status(201).json({ menu_item: rows[0] });
  }

  // =========================================================
  // DELETE — soft delete (archive + rename code to free the slot)
  // =========================================================
  if (req.method === 'DELETE') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const id = Number.parseInt(body.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'id required' });
    }
    // Suffix the code with `_archived_<id>` so the original slot is free
    // for a future create. The id is unique, so repeated archives of items
    // sharing the original code never collide.
    const rows = await sql`
      UPDATE menu_items
         SET is_archived = TRUE,
             code        = code || '_archived_' || id::text,
             updated_at  = NOW()
       WHERE id = ${id} AND is_archived = FALSE
       RETURNING id, code
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'menu item not found' });
    return res.status(200).json({ archived: rows[0] });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}

export default requireAdmin(handler);
