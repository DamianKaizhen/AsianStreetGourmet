// PATCH /api/admin/hours/[day] — update one day's opening hours
//
// URL param: day = 0..6 (0=Sun, 6=Sat to match JS Date.getDay())
// Body: { is_open: boolean, opens?: "HH:MM", closes?: "HH:MM" }
//   - When is_open=true, opens and closes are required.
//   - When is_open=false, opens and closes are stored as NULL.

import { sql } from '../../../lib/db.js';
import { requireAdmin } from '../../../lib/auth.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // "HH:MM" 24h

async function handler(req, res) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const day = Number.parseInt(req.query.day, 10);
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    return res.status(400).json({ error: 'invalid day; must be 0..6' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const { is_open, opens, closes } = body;

  if (typeof is_open !== 'boolean') {
    return res.status(400).json({ error: 'is_open must be boolean' });
  }

  if (is_open) {
    if (typeof opens !== 'string' || !TIME_RE.test(opens)) {
      return res.status(400).json({ error: 'opens must be "HH:MM" 24-hour' });
    }
    if (typeof closes !== 'string' || !TIME_RE.test(closes)) {
      return res.status(400).json({ error: 'closes must be "HH:MM" 24-hour' });
    }
    // Sanity: closes should be after opens. Allow same-day only — no
    // late-night-into-next-day support in v1 since the restaurant closes
    // at 21:00/22:00.
    if (opens >= closes) {
      return res.status(400).json({ error: 'closes must be later than opens' });
    }
  }

  const opensVal = is_open ? opens : null;
  const closesVal = is_open ? closes : null;

  const rows = await sql`
    UPDATE hours SET
      is_open    = ${is_open},
      opens      = ${opensVal},
      closes     = ${closesVal},
      updated_at = NOW()
    WHERE day_of_week = ${day}
    RETURNING day_of_week, is_open, opens, closes, updated_at
  `;

  if (rows.length === 0) return res.status(404).json({ error: 'day row not found' });
  return res.status(200).json({ hours: rows[0] });
}

export default requireAdmin(handler);
