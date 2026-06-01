// GET  /api/admin/ingredients — list everything, with which menu codes each ingredient affects
// POST /api/admin/ingredients — create a new ingredient

import { sql } from '../../lib/db.js';
import { requireAdmin } from '../../lib/auth.js';

const ALLOWED_CATEGORIES = ['meat', 'seafood', 'vegetable', 'preserved', 'pantry'];

async function handler(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`
      SELECT
        i.id, i.slug, i.name_en, i.name_zh, i.category,
        i.is_pantry, i.is_available, i.notes, i.updated_at,
        COALESCE(
          ARRAY_AGG(m.code ORDER BY m.display_order) FILTER (WHERE m.id IS NOT NULL),
          '{}'
        ) AS used_by_codes
      FROM ingredients i
      LEFT JOIN menu_item_ingredients mii ON mii.ingredient_id = i.id
      LEFT JOIN menu_items m ON m.id = mii.menu_item_id
      GROUP BY i.id
      ORDER BY i.is_pantry, i.category, i.name_en
    `;
    return res.status(200).json({ ingredients: rows });
  }

  if (req.method === 'POST') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const { slug, name_en, name_zh, category, is_pantry = false, is_available = true, notes = null } = body;

    if (typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'slug required (lowercase letters, digits, hyphens)' });
    }
    if (typeof name_en !== 'string' || !name_en.trim()) return res.status(400).json({ error: 'name_en required' });
    if (typeof name_zh !== 'string' || !name_zh.trim()) return res.status(400).json({ error: 'name_zh required' });
    if (!ALLOWED_CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of ${ALLOWED_CATEGORIES.join(', ')}` });

    try {
      const rows = await sql`
        INSERT INTO ingredients (slug, name_en, name_zh, category, is_pantry, is_available, notes)
        VALUES (${slug}, ${name_en}, ${name_zh}, ${category}, ${is_pantry}, ${is_available}, ${notes})
        RETURNING *
      `;
      return res.status(201).json({ ingredient: rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'slug already exists' });
      throw err;
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}

export default requireAdmin(handler);
