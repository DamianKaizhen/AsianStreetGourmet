// PATCH /api/admin/ingredients/[id] — update mutable fields on one ingredient
//
// Body: any subset of { is_available, is_pantry, name_en, name_zh, notes, category }
// Returns the updated row.

import { sql } from '../../../lib/db.js';
import { requireAdmin } from '../../../lib/auth.js';

const ALLOWED_CATEGORIES = ['meat', 'seafood', 'vegetable', 'preserved', 'pantry'];

async function handler(req, res) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = Number.parseInt(req.query.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  // Each field is optional; type-check whatever was provided.
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

  // The Neon serverless driver doesn't accept dynamic column lists via tagged
  // template, so build the SET clause as a single COALESCE update — passing
  // NULL for fields we don't want to change.
  const u = {
    is_available: 'is_available' in updates ? updates.is_available : null,
    is_pantry:    'is_pantry'    in updates ? updates.is_pantry    : null,
    name_en:      'name_en'      in updates ? updates.name_en      : null,
    name_zh:      'name_zh'      in updates ? updates.name_zh      : null,
    notes:        'notes'        in updates ? updates.notes        : null,
    category:     'category'     in updates ? updates.category     : null,
  };
  // Distinguish "set to null" from "leave alone" for nullable fields (notes):
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

export default requireAdmin(handler);
