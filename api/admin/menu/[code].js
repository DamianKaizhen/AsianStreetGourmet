// PATCH /api/admin/menu/[code] — change rotation_mode for one menu item
//
// Body: { rotation_mode: 'always' | 'rotation' }

import { sql } from '../../../lib/db.js';
import { requireAdmin } from '../../../lib/auth.js';

const ALLOWED_MODES = ['always', 'rotation'];

async function handler(req, res) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const code = String(req.query.code || '').toUpperCase();
  if (!/^[SABCD][0-9]+$/.test(code)) {
    return res.status(400).json({ error: 'invalid code' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const { rotation_mode } = body;

  if (!ALLOWED_MODES.includes(rotation_mode)) {
    return res.status(400).json({ error: `rotation_mode must be one of ${ALLOWED_MODES.join(', ')}` });
  }

  const rows = await sql`
    UPDATE menu_items
    SET rotation_mode = ${rotation_mode}, updated_at = NOW()
    WHERE code = ${code}
    RETURNING id, code, rotation_mode, updated_at
  `;

  if (rows.length === 0) return res.status(404).json({ error: 'menu item not found' });
  return res.status(200).json({ menu_item: rows[0] });
}

export default requireAdmin(handler);
