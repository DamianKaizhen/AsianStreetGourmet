// GET /api/admin/menu — every menu item with the ingredients it depends on

import { sql } from '../../lib/db.js';
import { requireAdmin } from '../../lib/auth.js';

async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

export default requireAdmin(handler);
