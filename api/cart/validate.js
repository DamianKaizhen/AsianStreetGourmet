// POST /api/cart/validate
// Public. Pre-checkout helper: takes the current cart contents,
// re-resolves them against the live menu (catching items that became
// unavailable since they were added), and returns fresh totals.
//
// Body: { items: [{ code, quantity }, ...] }
// Returns:
//   200 → { lines, subtotal_cents, tax_cents, total_cents, estimated_wait_min }
//   403 → cart feature disabled
//   409 → unavailable / unknown items (with codes)
//
// This is informational; the authoritative recompute happens again
// inside POST /api/orders. The client uses this to keep the cart
// drawer honest if the admin disables an item while the customer
// is browsing.

import { isCartEnabled } from '../../lib/settings.js';
import {
  resolveCartItems,
  computeTotals,
  computeEstimatedWaitMin,
  HttpError,
} from '../../lib/orders.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
    console.error('[cart/validate] unexpected error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
