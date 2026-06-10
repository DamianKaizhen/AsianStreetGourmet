// PATCH /api/admin/settings/cart-enabled
// Admin-only. Toggles the online-ordering cart feature on or off.
//
// Body: { enabled: boolean }
// Returns: { cart_enabled: boolean, updated_at: string }

import { setSetting } from '../../../lib/settings.js';
import { requireAdmin } from '../../../lib/auth.js';

async function handler(req, res) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const { enabled } = body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be boolean' });
  }

  try {
    const row = await setSetting('cart_enabled', enabled ? 'true' : 'false');
    return res.status(200).json({
      cart_enabled: row.value === 'true',
      updated_at: row.updated_at,
    });
  } catch (err) {
    console.error('[settings/cart-enabled] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

export default requireAdmin(handler);
