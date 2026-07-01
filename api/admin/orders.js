// /api/admin/orders — admin-only. Lists & status updates for online orders,
// plus POS ring-up (POST).
//
// GET   /api/admin/orders                          → all orders from last 24h, newest first
// GET   /api/admin/orders?status=received,preparing → filter by one or more statuses (comma-sep)
// GET   /api/admin/orders?channel=online|pos       → filter by order source
// GET   /api/admin/orders?since=<ISO>              → orders created after the given timestamp
// PATCH /api/admin/orders   { id, status }         → update one order's status
// POST  /api/admin/orders   { items, dining_option, ... } → ring up a POS order
//
// Combined into one file to keep us under Vercel Hobby's 12-function limit.
// Same auth wrapper (requireAdmin) covers all three verbs — POS ring-up is
// a privileged action.

import { sql } from '../../lib/db.js';
import { requireAdmin, readSession } from '../../lib/auth.js';
import {
  resolveCartItems,
  computeTotals,
  computeEstimatedWaitMin,
  insertOrder,
  HttpError,
} from '../../lib/orders.js';

const VALID_STATUSES = ['received', 'preparing', 'ready', 'picked_up', 'cancelled'];
const VALID_CHANNELS = ['online', 'pos'];
const VALID_DINING   = ['dine_in', 'takeout'];
const LOOKBACK_MS_DEFAULT = 24 * 60 * 60 * 1000; // 24h

async function handler(req, res) {
  if (req.method === 'GET')   return listOrders(req, res);
  if (req.method === 'PATCH') return updateOrderStatus(req, res);
  if (req.method === 'POST')  return ringPosOrder(req, res);
  res.setHeader('Allow', 'GET, PATCH, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}

async function listOrders(req, res) {
  // Status filter (default: all valid statuses)
  let statuses = VALID_STATUSES;
  if (typeof req.query.status === 'string' && req.query.status.length > 0) {
    const requested = req.query.status.split(',').map((s) => s.trim());
    statuses = requested.filter((s) => VALID_STATUSES.includes(s));
    if (statuses.length === 0) {
      return res.status(400).json({ error: 'no valid statuses in filter; allowed: ' + VALID_STATUSES.join(', ') });
    }
  }

  // Channel filter (default: all channels — the admin UI does its own
  // client-side filter via tabs, but a server-side hint saves bandwidth
  // when the caller already knows which stream it wants).
  let channels = VALID_CHANNELS;
  if (typeof req.query.channel === 'string' && req.query.channel.length > 0) {
    const requested = req.query.channel.split(',').map((s) => s.trim());
    channels = requested.filter((c) => VALID_CHANNELS.includes(c));
    if (channels.length === 0) {
      return res.status(400).json({ error: 'no valid channels in filter; allowed: ' + VALID_CHANNELS.join(', ') });
    }
  }

  // Time floor (default: last 24h)
  let sinceDate;
  if (typeof req.query.since === 'string' && req.query.since.length > 0) {
    sinceDate = new Date(req.query.since);
    if (isNaN(sinceDate.getTime())) {
      return res.status(400).json({ error: 'invalid since timestamp; expected ISO 8601' });
    }
  } else {
    sinceDate = new Date(Date.now() - LOOKBACK_MS_DEFAULT);
  }

  const rows = await sql`
    SELECT
      o.id, o.pickup_code, o.customer_name, o.customer_phone, o.customer_email,
      o.notes, o.subtotal_cents, o.tax_cents, o.total_cents, o.estimated_wait_min,
      o.status, o.created_at, o.updated_at,
      o.order_channel, o.dining_option, o.discount_cents, o.discount_pct,
      o.discount_reason, o.cash_tendered_cents, o.cashier_name,
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'menu_code',         oi.menu_code,
            'name_en',           oi.name_en,
            'name_zh',           oi.name_zh,
            'quantity',          oi.quantity,
            'price_cents',       oi.price_cents,
            'line_total_cents',  oi.line_total_cents
          ) ORDER BY oi.id
        ) FILTER (WHERE oi.id IS NOT NULL),
        '[]'::json
      ) AS items
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.status = ANY(${statuses})
      AND o.order_channel = ANY(${channels})
      AND o.created_at >= ${sinceDate.toISOString()}
    GROUP BY o.id
    ORDER BY o.created_at DESC
  `;

  return res.status(200).json({ orders: rows });
}

async function updateOrderStatus(req, res) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  const id = Number.parseInt(body.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'invalid or missing order id' });
  }
  if (!VALID_STATUSES.includes(body.status)) {
    return res.status(400).json({ error: 'status must be one of ' + VALID_STATUSES.join(', ') });
  }

  const rows = await sql`
    UPDATE orders SET
      status     = ${body.status},
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, pickup_code, status, updated_at
  `;
  if (rows.length === 0) return res.status(404).json({ error: 'order not found' });
  return res.status(200).json({ order: rows[0] });
}

// ----------------------------------------------------------------------
// POST /api/admin/orders — POS ring-up
// ----------------------------------------------------------------------
// Mirrors the public POST /api/orders flow but skips the two public gates
// (cart_enabled feature flag + hours check) — the register is always open
// to the cashier — and layers in the POS-only fields.
async function ringPosOrder(req, res) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  // ----- Body shape validation -----
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }
  if (!VALID_DINING.includes(body.dining_option)) {
    return res.status(400).json({ error: 'dining_option must be one of ' + VALID_DINING.join(', ') });
  }
  // Optional customer info — server-defaults blank name to 'Walk-in'
  // because orders.customer_name is NOT NULL and the POS makes it optional.
  const customer_name  = (typeof body.customer_name  === 'string' && body.customer_name.trim())  || 'Walk-in';
  const customer_phone = (typeof body.customer_phone === 'string' && body.customer_phone.trim()) || null;
  const notes          = (typeof body.notes          === 'string' && body.notes.trim())          || null;
  if (customer_name.length > 80)  return res.status(400).json({ error: 'customer_name too long (>80 chars)' });
  if (customer_phone && customer_phone.length > 30) return res.status(400).json({ error: 'customer_phone too long (>30 chars)' });
  if (notes && notes.length > 200) return res.status(400).json({ error: 'notes too long (>200 chars)' });

  // Discount: at most one form allowed. Percentage is converted to cents
  // after subtotal is computed; ambiguity is a bug source so reject both.
  if (body.discount_pct != null && body.discount_cents != null) {
    return res.status(400).json({ error: 'send either discount_pct or discount_cents, not both' });
  }
  let discount_pct = null;
  if (body.discount_pct != null) {
    const pct = Number(body.discount_pct);
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ error: 'discount_pct must be integer 0..100' });
    }
    discount_pct = pct;
  }
  let discount_cents_in = 0;
  if (body.discount_cents != null) {
    const c = Number(body.discount_cents);
    if (!Number.isInteger(c) || c < 0 || c > 100000) {
      return res.status(400).json({ error: 'discount_cents must be integer 0..100000' });
    }
    discount_cents_in = c;
  }
  const discount_reason = (typeof body.discount_reason === 'string' && body.discount_reason.trim()) || null;
  if (discount_reason && discount_reason.length > 80) {
    return res.status(400).json({ error: 'discount_reason too long (>80 chars)' });
  }

  // Cash tendered — optional, dollars-and-cents integer. Change is computed
  // server-side from total, not trusted from the client.
  let cash_tendered_cents = null;
  if (body.cash_tendered_cents != null) {
    const c = Number(body.cash_tendered_cents);
    if (!Number.isInteger(c) || c < 0 || c > 1000000) {
      return res.status(400).json({ error: 'cash_tendered_cents must be integer 0..1000000' });
    }
    cash_tendered_cents = c;
  }

  const allowUnavailable = body.allow_unavailable === true;

  try {
    // ----- Resolve cart items (POS may override the availability toggle) -----
    const resolved = await resolveCartItems(body.items, { allowUnavailable });

    // If the cashier didn't opt-in to allow_unavailable but items came back
    // flagged, return the same 409 shape as the online path.
    const flagged = resolved.filter((r) => r._unavailable_at_ring).map((r) => r.code);
    if (!allowUnavailable && flagged.length > 0) {
      return res.status(409).json({
        error: 'some items are currently unavailable',
        unavailable_codes: flagged,
      });
    }

    // ----- Compute totals (with discount applied pre-tax) -----
    // Percentage: applied AFTER the subtotal is computed, using the raw
    // subtotal — that's what customers see on the printed ticket.
    let requested_discount_cents = discount_cents_in;
    if (discount_pct != null) {
      // Compute against the raw subtotal, THEN pass to computeTotals which
      // will clamp again (never > subtotal).
      const subtotal_preview = resolved.reduce(
        (acc, r) => acc + r.price_cents * r.quantity, 0
      );
      requested_discount_cents = Math.round(subtotal_preview * discount_pct / 100);
    }
    const totals = computeTotals(resolved, { discount_cents: requested_discount_cents });

    const estimated_wait_min = computeEstimatedWaitMin(resolved.map((r) => r.category));

    // ----- Cashier identity from the admin session -----
    const session = readSession(req);
    const cashier_name = (session && typeof session.user === 'string' && session.user) || 'admin';

    // ----- Insert the order -----
    const inserted = await insertOrder({
      customer_name,
      customer_phone,
      customer_email: null,
      notes,
      subtotal_cents: totals.subtotal_cents,
      tax_cents:      totals.tax_cents,
      total_cents:    totals.total_cents,
      estimated_wait_min,
      lines: totals.lines,
      // POS-specific fields
      order_channel:       'pos',
      dining_option:       body.dining_option,
      discount_cents:      totals.discount_cents,
      discount_pct,
      discount_reason,
      cash_tendered_cents,
      cashier_name,
    });

    const change_cents = cash_tendered_cents == null
      ? null
      : Math.max(0, cash_tendered_cents - totals.total_cents);

    // Return the full ticket payload — POS client feeds this straight into
    // buildPrintSlip() with no extra fetches.
    return res.status(200).json({
      order_id:            inserted.id,
      pickup_code:         inserted.pickup_code,
      order_channel:       'pos',
      dining_option:       body.dining_option,
      cashier_name,
      customer_name,
      customer_phone,
      notes,
      items: totals.lines.map((l) => ({
        menu_code:        l.code,
        name_en:          l.name_en,
        name_zh:          l.name_zh,
        quantity:         l.quantity,
        price_cents:      l.price_cents,
        line_total_cents: l.line_total_cents,
        was_unavailable:  !!l._unavailable_at_ring,
      })),
      subtotal_cents:      totals.subtotal_cents,
      discount_cents:      totals.discount_cents,
      discount_pct,
      discount_reason,
      tax_cents:           totals.tax_cents,
      total_cents:         totals.total_cents,
      cash_tendered_cents,
      change_cents,
      estimated_wait_min,
      created_at:          new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    console.error('[admin/orders POST] unexpected error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

export default requireAdmin(handler);
