// /api/admin/menu — admin-only menu queries and per-item updates.
//
// GET   /api/admin/menu                                  → list with ingredients
// PATCH /api/admin/menu  { code, is_available?, rotation_mode? }  → update one item
//
// PATCH takes the menu code in the body (rather than a URL segment) so this
// file can be a single Vercel serverless function — keeps us under the
// Hobby tier's 12-function limit.

import { sql } from '../../lib/db.js';
import { requireAdmin } from '../../lib/auth.js';

const ALLOWED_MODES = ['always', 'rotation'];

async function handler(req, res) {
  if (req.method === 'GET') {
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
      GROUP BY m.id
      ORDER BY m.display_order
    `;
    return res.status(200).json({ menu_items: rows });
  }

  if (req.method === 'PATCH') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    const code = String(body.code || '').toUpperCase();
    if (!/^[SABCD][0-9]+$/.test(code)) {
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
      WHERE code = ${code}
      RETURNING id, code, is_available, rotation_mode, updated_at
    `;

    if (rows.length === 0) return res.status(404).json({ error: 'menu item not found' });
    return res.status(200).json({ menu_item: rows[0] });
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
}

export default requireAdmin(handler);
