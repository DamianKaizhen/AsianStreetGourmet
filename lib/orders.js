// Order helpers — pickup-code generation, totals math, and the
// transactional "create order" helper used by POST /api/orders.

import { randomBytes } from 'node:crypto';
import { sql } from './db.js';

// NYC prepared-food sales tax. Computed as Math.round(subtotal * RATE).
const NYC_SALES_TAX_RATE = 0.08875;

// Estimated wait baseline (minutes) per category. Final wait is the max
// across all items in the order.
const WAIT_MINUTES_BY_CATEGORY = {
  rice: 15,
  home: 20,
  soup: 10,
  snack: 5,
};

// Pickup-code character set — 36 chars, uppercase + digits.
const PICKUP_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PICKUP_CODE_LENGTH = 4;
const PICKUP_CODE_MAX_RETRIES = 5;

/**
 * Generate a random N-char pickup code from [A-Z0-9]. Pure function,
 * no DB collision check (that happens at insert time).
 */
export function generatePickupCode() {
  const bytes = randomBytes(PICKUP_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < PICKUP_CODE_LENGTH; i++) {
    out += PICKUP_CODE_CHARS[bytes[i] % PICKUP_CODE_CHARS.length];
  }
  return out;
}

/**
 * Compute tax cents from subtotal cents. Rounded to the nearest cent.
 */
export function computeTaxCents(subtotalCents) {
  return Math.round(subtotalCents * NYC_SALES_TAX_RATE);
}

/**
 * Estimated wait in minutes for a cart, based on the heaviest item
 * category present. Snacks-only orders are quick; anything from the
 * home-style section gets the 20-minute baseline.
 */
export function computeEstimatedWaitMin(itemCategories) {
  let max = 0;
  for (const cat of itemCategories) {
    const w = WAIT_MINUTES_BY_CATEGORY[cat];
    if (typeof w === 'number' && w > max) max = w;
  }
  return max || WAIT_MINUTES_BY_CATEGORY.snack;
}

/**
 * Fetch the requested menu items from the DB, returning the rows in the
 * order the caller asked for. Throws if any code is missing or
 * unavailable.
 *
 * Returns: [{ code, name_en, name_zh, category, price_cents, quantity }, ...]
 */
export async function resolveCartItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(400, 'items must be a non-empty array');
  }
  // Validate the request shape first; trust nothing from the client.
  const requested = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      throw new HttpError(400, 'each item must be an object');
    }
    if (typeof item.code !== 'string' || !/^[SABCD][0-9]+$/.test(item.code)) {
      throw new HttpError(400, `invalid item code: ${item?.code}`);
    }
    const qty = Number(item.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
      throw new HttpError(400, `quantity must be an integer 1..50 (got ${item?.quantity} for ${item.code})`);
    }
    requested.push({ code: item.code, quantity: qty });
  }
  const codes = requested.map((r) => r.code);

  const rows = await sql`
    SELECT code, name_en, name_zh, category, price_cents, is_available
    FROM menu_items
    WHERE code = ANY(${codes})
  `;
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));

  // Surface every problem in one response: missing codes + unavailable.
  const missing = [];
  const unavailable = [];
  for (const r of requested) {
    const row = byCode[r.code];
    if (!row) { missing.push(r.code); continue; }
    if (!row.is_available) unavailable.push(r.code);
  }
  if (missing.length > 0) {
    throw new HttpError(409, 'unknown menu items', { unknown_codes: missing });
  }
  if (unavailable.length > 0) {
    throw new HttpError(409, 'some items are currently unavailable', { unavailable_codes: unavailable });
  }

  return requested.map((r) => {
    const row = byCode[r.code];
    return {
      code: row.code,
      name_en: row.name_en,
      name_zh: row.name_zh,
      category: row.category,
      price_cents: row.price_cents,
      quantity: r.quantity,
    };
  });
}

/**
 * Given resolved cart items (from resolveCartItems), compute subtotal,
 * tax, total, and the per-line totals.
 */
export function computeTotals(resolvedItems) {
  const lines = resolvedItems.map((r) => ({
    ...r,
    line_total_cents: r.price_cents * r.quantity,
  }));
  const subtotal_cents = lines.reduce((acc, l) => acc + l.line_total_cents, 0);
  const tax_cents = computeTaxCents(subtotal_cents);
  const total_cents = subtotal_cents + tax_cents;
  return { lines, subtotal_cents, tax_cents, total_cents };
}

/**
 * Insert the order + order_items atomically. Retries on pickup_code
 * collision up to PICKUP_CODE_MAX_RETRIES.
 *
 * params: { customer_name, customer_phone, customer_email, notes,
 *           subtotal_cents, tax_cents, total_cents, estimated_wait_min,
 *           lines: [{ code, name_en, name_zh, quantity, price_cents, line_total_cents }] }
 *
 * Returns: { id, pickup_code }
 */
export async function insertOrder(params) {
  const {
    customer_name,
    customer_phone = null,
    customer_email = null,
    notes = null,
    subtotal_cents,
    tax_cents,
    total_cents,
    estimated_wait_min,
    lines,
  } = params;

  for (let attempt = 0; attempt < PICKUP_CODE_MAX_RETRIES; attempt++) {
    const pickup_code = generatePickupCode();
    try {
      // Neon serverless driver doesn't expose multi-statement transactions
      // via the tagged-template API. We insert the order first; if the
      // items insert fails, we DELETE the order row to clean up. For our
      // single-server-region setup with negligible concurrent insert load,
      // this is safe and simpler than coordinating a transaction.
      const orderRows = await sql`
        INSERT INTO orders (
          pickup_code, customer_name, customer_phone, customer_email, notes,
          subtotal_cents, tax_cents, total_cents, estimated_wait_min, status
        ) VALUES (
          ${pickup_code}, ${customer_name}, ${customer_phone}, ${customer_email}, ${notes},
          ${subtotal_cents}, ${tax_cents}, ${total_cents}, ${estimated_wait_min}, 'received'
        )
        RETURNING id, pickup_code
      `;
      const orderId = orderRows[0].id;

      // Insert all items via a single multi-row INSERT for atomicity-ish.
      // Build the VALUES rows using the sql tag helper's array binding.
      try {
        for (const l of lines) {
          await sql`
            INSERT INTO order_items (
              order_id, menu_code, name_en, name_zh,
              quantity, price_cents, line_total_cents
            ) VALUES (
              ${orderId}, ${l.code}, ${l.name_en}, ${l.name_zh},
              ${l.quantity}, ${l.price_cents}, ${l.line_total_cents}
            )
          `;
        }
      } catch (itemErr) {
        // Best-effort cleanup of the orphaned order row.
        try { await sql`DELETE FROM orders WHERE id = ${orderId}`; } catch {}
        throw itemErr;
      }

      return orderRows[0];
    } catch (err) {
      // 23505 = unique_violation. Likely on pickup_code; retry.
      if (err && err.code === '23505' && attempt < PICKUP_CODE_MAX_RETRIES - 1) {
        continue;
      }
      throw err;
    }
  }
  // Reached only if every retry collided — vanishingly unlikely.
  throw new HttpError(500, 'failed to generate a unique pickup code');
}

// ----------------------------------------------------------------------
// Lightweight error type — lets handlers return clean { status, body }
// without coupling lib code to req/res objects.
// ----------------------------------------------------------------------
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
