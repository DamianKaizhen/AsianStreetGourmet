// GET /api/hours — public read of the weekly opening hours
// Returns: { hours: [{ day_of_week, is_open, opens, closes }, ...] }
// day_of_week: 0=Sun .. 6=Sat (matches JS Date.getDay()).

import { sql } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const rows = await sql`
      SELECT day_of_week, is_open, opens, closes, updated_at
      FROM hours
      ORDER BY day_of_week
    `;
    return res.status(200).json({ hours: rows });
  } catch (err) {
    console.error('[hours] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
