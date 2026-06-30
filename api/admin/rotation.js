// GET   /api/admin/rotation — list pool sizes per category
// PATCH /api/admin/rotation — update one category's pool size
//
// PATCH body: { category: 'steam'|'soup'|'snack', pool_size: integer ≥ 0 }

import { sql } from '../../lib/db.js';
import { requireAdmin } from '../../lib/auth.js';

const ALLOWED_CATEGORIES = ['steam', 'soup', 'snack'];

async function handler(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`SELECT category, pool_size FROM rotation_settings ORDER BY category`;
    return res.status(200).json({ rotation: rows });
  }

  if (req.method === 'PATCH') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const { category, pool_size } = body;

    if (!ALLOWED_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of ${ALLOWED_CATEGORIES.join(', ')}` });
    }
    if (!Number.isInteger(pool_size) || pool_size < 0 || pool_size > 100) {
      return res.status(400).json({ error: 'pool_size must be a non-negative integer' });
    }

    const rows = await sql`
      INSERT INTO rotation_settings (category, pool_size)
      VALUES (${category}, ${pool_size})
      ON CONFLICT (category) DO UPDATE SET pool_size = EXCLUDED.pool_size
      RETURNING category, pool_size
    `;
    return res.status(200).json({ rotation: rows[0] });
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
}

export default requireAdmin(handler);
