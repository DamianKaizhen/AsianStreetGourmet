// POST /api/orders
// Public, unauthenticated. Submits a new online order.
//
// Body:
//   {
//     items: [{ code: 'S1', quantity: 2 }, ...],
//     customer_name: string (required, 1..80 chars),
//     customer_phone: string (optional, US-ish digits/punctuation),
//     customer_email: string (optional, looks like an email),
//     notes: string (optional, <= 200 chars)
//   }
//
// Returns:
//   200 → { pickup_code, estimated_wait_min, total_cents, order_id }
//   400 → bad request (validation)
//   403 → cart feature disabled
//   409 → unavailable item, restaurant closed, etc.
//   500 → server error

import { sql } from '../lib/db.js';
import { isCartEnabled } from '../lib/settings.js';
import {
  resolveCartItems,
  computeTotals,
  computeEstimatedWaitMin,
  insertOrder,
  HttpError,
} from '../lib/orders.js';

const PHONE_RE = /^[\d\s()+-]{7,20}$/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // -------- Feature flag --------
    if (!(await isCartEnabled())) {
      return res.status(403).json({ error: 'Online ordering is currently disabled. Please call 917-723-6262 to place an order.' });
    }

    // -------- Body validation --------
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const { items, customer_name, customer_phone, customer_email, notes } = body;

    if (typeof customer_name !== 'string' || !customer_name.trim()) {
      return res.status(400).json({ error: 'customer_name is required' });
    }
    if (customer_name.trim().length > 80) {
      return res.status(400).json({ error: 'customer_name is too long (max 80 chars)' });
    }

    if (customer_phone != null && customer_phone !== '') {
      if (typeof customer_phone !== 'string' || !PHONE_RE.test(customer_phone)) {
        return res.status(400).json({ error: 'customer_phone format invalid' });
      }
    }

    if (customer_email != null && customer_email !== '') {
      if (typeof customer_email !== 'string' || !EMAIL_RE.test(customer_email)) {
        return res.status(400).json({ error: 'customer_email format invalid' });
      }
    }

    if (notes != null && notes !== '') {
      if (typeof notes !== 'string' || notes.length > 200) {
        return res.status(400).json({ error: 'notes must be a string up to 200 chars' });
      }
    }

    // -------- Hours check (block ordering when closed in NY time) --------
    if (await isCurrentlyClosed()) {
      return res.status(409).json({ error: 'The restaurant is currently closed. Please try again during our open hours.' });
    }

    // -------- Resolve cart items + compute totals (throws on bad codes) --------
    const resolved = await resolveCartItems(items);
    const totals = computeTotals(resolved);
    const estimated_wait_min = computeEstimatedWaitMin(resolved.map((r) => r.category));

    // -------- Insert --------
    const inserted = await insertOrder({
      customer_name: customer_name.trim(),
      customer_phone: customer_phone || null,
      customer_email: customer_email || null,
      notes: notes || null,
      subtotal_cents: totals.subtotal_cents,
      tax_cents: totals.tax_cents,
      total_cents: totals.total_cents,
      estimated_wait_min,
      lines: totals.lines,
    });

    return res.status(200).json({
      order_id: inserted.id,
      pickup_code: inserted.pickup_code,
      estimated_wait_min,
      subtotal_cents: totals.subtotal_cents,
      tax_cents: totals.tax_cents,
      total_cents: totals.total_cents,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    console.error('[orders] unexpected error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ----------------------------------------------------------------------
// Hours check — duplicates logic from the public /api/hours endpoint
// but reads directly from the DB rather than self-fetching the Vercel
// function (which would add cold-start latency + a network hop).
// ----------------------------------------------------------------------
async function isCurrentlyClosed() {
  const rows = await sql`SELECT day_of_week, is_open, opens, closes FROM hours`;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = {};
  fmt.formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = map[parts.weekday] ?? 0;
  let h = parseInt(parts.hour, 10);
  if (h === 24) h = 0;
  const nowMins = h * 60 + parseInt(parts.minute, 10);

  const today = rows.find((r) => r.day_of_week === day);
  if (!today || !today.is_open || !today.opens || !today.closes) return true;
  const opensMin = timeMins(today.opens);
  const closesMin = timeMins(today.closes);
  return nowMins < opensMin || nowMins >= closesMin;
}

function timeMins(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
