// PATCH /api/admin/menu/[code] — update mutable fields on one menu item
//
// Body: any subset of { is_available, rotation_mode }
// Returns the updated row.

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

  // Validate any provided fields
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

export default requireAdmin(handler);
