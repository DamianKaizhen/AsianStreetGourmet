// GET /api/cart-status
// Public, unauthenticated. Returns whether the online-ordering cart
// feature is currently enabled. Fetched on every page load so the
// public site knows whether to render cart UI at all.
//
// Returns: { cart_enabled: boolean }
//
// Failure mode: if the DB read fails, we return cart_enabled=false
// (fail-safe — better to silently hide cart UI than to render a broken
// cart that can't submit).

import { isCartEnabled } from '../lib/settings.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const enabled = await isCartEnabled();
    return res.status(200).json({ cart_enabled: enabled });
  } catch (err) {
    console.error('[cart-status] error:', err);
    return res.status(200).json({ cart_enabled: false });
  }
}
