// /api/admin/orders — admin-only. Lists & status updates for online orders.
//
// GET   /api/admin/orders                         → all orders from last 24h, newest first
// GET   /api/admin/orders?status=received,preparing → filter by one or more statuses (comma-sep)
// GET   /api/admin/orders?since=<ISO>             → orders created after the given timestamp
// PATCH /api/admin/orders   { id, status }        → update one order's status
//
// Combined into one file to keep us under Vercel Hobby's 12-function limit.

import { sql } from '../../lib/db.js';
import { requireAdmin } from '../../lib/auth.js';

const VALID_STATUSES = ['received', 'preparing', 'ready', 'picked_up', 'cancelled'];
const LOOKBACK_MS_DEFAULT = 24 * 60 * 60 * 1000; // 24h

async function handler(req, res) {
  if (req.method === 'GET') return listOrders(req, res);
  if (req.method === 'PATCH') return updateOrderStatus(req, res);
  res.setHeader('Allow', 'GET, PATCH');
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

export default requireAdmin(handler);
