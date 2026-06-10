// /api/admin/ingredients — admin-only.
//
// GET                                                                  → list with used_by_codes
// POST    { slug, name_en, name_zh, category, is_pantry?, is_available?, notes? }  → create
// PATCH   { id, ...optional fields }                                   → update one
//
// PATCH takes id in the body (rather than a URL segment) so this file
// can be a single Vercel serverless function — keeps us under the Hobby
// tier's 12-function limit.

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

  if (req.method === 'PATCH') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    const id = Number.parseInt(body.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'invalid or missing ingredient id' });
    }

    const updates = {};
    if ('is_available' in body) {
      if (typeof body.is_available !== 'boolean') return res.status(400).json({ error: 'is_available must be boolean' });
      updates.is_available = body.is_available;
    }
    if ('is_pantry' in body) {
      if (typeof body.is_pantry !== 'boolean') return res.status(400).json({ error: 'is_pantry must be boolean' });
      updates.is_pantry = body.is_pantry;
    }
    if ('name_en' in body) {
      if (typeof body.name_en !== 'string' || !body.name_en.trim()) return res.status(400).json({ error: 'name_en must be a non-empty string' });
      updates.name_en = body.name_en.trim();
    }
    if ('name_zh' in body) {
      if (typeof body.name_zh !== 'string' || !body.name_zh.trim()) return res.status(400).json({ error: 'name_zh must be a non-empty string' });
      updates.name_zh = body.name_zh.trim();
    }
    if ('notes' in body) {
      if (body.notes !== null && typeof body.notes !== 'string') return res.status(400).json({ error: 'notes must be string or null' });
      updates.notes = body.notes;
    }
    if ('category' in body) {
      if (!ALLOWED_CATEGORIES.includes(body.category)) return res.status(400).json({ error: `category must be one of ${ALLOWED_CATEGORIES.join(', ')}` });
      updates.category = body.category;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no updatable fields provided' });
    }

    const u = {
      is_available: 'is_available' in updates ? updates.is_available : null,
      is_pantry:    'is_pantry'    in updates ? updates.is_pantry    : null,
      name_en:      'name_en'      in updates ? updates.name_en      : null,
      name_zh:      'name_zh'      in updates ? updates.name_zh      : null,
      notes:        'notes'        in updates ? updates.notes        : null,
      category:     'category'     in updates ? updates.category     : null,
    };
    const setNotesExplicitly = 'notes' in updates;

    const rows = await sql`
      UPDATE ingredients SET
        is_available = COALESCE(${u.is_available}::boolean, is_available),
        is_pantry    = COALESCE(${u.is_pantry}::boolean,    is_pantry),
        name_en      = COALESCE(${u.name_en},               name_en),
        name_zh      = COALESCE(${u.name_zh},               name_zh),
        notes        = CASE WHEN ${setNotesExplicitly} THEN ${u.notes} ELSE notes END,
        category     = COALESCE(${u.category},              category),
        updated_at   = NOW()
      WHERE id = ${id}
      RETURNING *
    `;

    if (rows.length === 0) return res.status(404).json({ error: 'ingredient not found' });
    return res.status(200).json({ ingredient: rows[0] });
  }

  res.setHeader('Allow', 'GET, POST, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
}

export default requireAdmin(handler);
