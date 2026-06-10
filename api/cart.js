// /api/cart — replaces /api/cart-status and /api/cart/validate.
//
// GET  /api/cart   →  { cart_enabled: boolean }                 (was /api/cart-status)
// POST /api/cart   {items}  →  { lines, totals, wait_min }     (was /api/cart/validate)

import { isCartEnabled } from '../lib/settings.js';
import {
  resolveCartItems,
  computeTotals,
  computeEstimatedWaitMin,
  HttpError,
} from '../lib/orders.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const enabled = await isCartEnabled();
      return res.status(200).json({ cart_enabled: enabled });
    } catch (err) {
      console.error('[cart GET] error:', err);
      // Fail-safe: never leave the cart UI rendered if we can't confirm the flag.
      return res.status(200).json({ cart_enabled: false });
    }
  }

  if (req.method === 'POST') {
    try {
      if (!(await isCartEnabled())) {
        return res.status(403).json({ error: 'Online ordering is currently disabled' });
      }
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const resolved = await resolveCartItems(body.items);
      const totals = computeTotals(resolved);
      const estimated_wait_min = computeEstimatedWaitMin(resolved.map((r) => r.category));
      return res.status(200).json({
        lines: totals.lines.map((l) => ({
          code: l.code, name_en: l.name_en, name_zh: l.name_zh,
          quantity: l.quantity, price_cents: l.price_cents,
          line_total_cents: l.line_total_cents,
        })),
        subtotal_cents: totals.subtotal_cents,
        tax_cents: totals.tax_cents,
        total_cents: totals.total_cents,
        estimated_wait_min,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message, ...err.extra });
      }
      console.error('[cart POST] unexpected error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
