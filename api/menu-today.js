// GET /api/menu-today
// Public endpoint. Returns today's available menu codes + (for admin debugging)
// a map of unavailable items with their reasons.
//
// Response:
//   {
//     as_of: "2026-05-13T19:42:00Z",            // server time
//     date_local: "2026-05-13",                  // YYYY-MM-DD in NY tz
//     available_codes: ["S1","S3","C1",...],
//     unavailable_with_reason: {
//       "S2": { reason: "missing", missing: ["chicken"] },
//       "C6": { reason: "rotation_off" }
//     }
//   }

import { sql } from '../lib/db.js';
import { todayDateString, pickRotation } from '../lib/rotation.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ----- Query 1: items + which non-pantry ingredients are unavailable -----
    const itemRows = await sql`
      SELECT
        m.code,
        m.category,
        m.rotation_mode,
        m.display_order,
        ARRAY_REMOVE(
          ARRAY_AGG(CASE
            WHEN i.is_available = FALSE AND i.is_pantry = FALSE
            THEN i.slug
            ELSE NULL
          END),
          NULL
        ) AS missing
      FROM menu_items m
      LEFT JOIN menu_item_ingredients mii ON mii.menu_item_id = m.id
      LEFT JOIN ingredients i ON i.id = mii.ingredient_id
      GROUP BY m.code, m.category, m.rotation_mode, m.display_order
      ORDER BY m.display_order
    `;

    // ----- Query 2: rotation pool sizes per category -----
    const rotationRows = await sql`SELECT category, pool_size FROM rotation_settings`;
    const poolByCat = Object.fromEntries(
      rotationRows.map((r) => [r.category, r.pool_size])
    );

    const dateStr = todayDateString();
    const availableSet = new Set();
    const unavailable = {};

    // ----- Pass 1: items whose ingredients are all OK -----
    // Bucket by category to apply rotation logic next.
    const rotationCandidates = {}; // category → [codes]
    for (const row of itemRows) {
      const missing = row.missing || [];
      if (missing.length > 0) {
        unavailable[row.code] = { reason: 'missing', missing };
        continue;
      }
      if (row.rotation_mode === 'always') {
        availableSet.add(row.code);
      } else {
        // 'rotation' mode → goes through the per-category picker
        (rotationCandidates[row.category] ||= []).push(row.code);
      }
    }

    // ----- Pass 2: pick N from each category's rotation pool -----
    for (const [category, codes] of Object.entries(rotationCandidates)) {
      const poolSize = poolByCat[category] ?? 0;
      const picked = new Set(pickRotation(codes, poolSize, dateStr));
      for (const code of codes) {
        if (picked.has(code)) {
          availableSet.add(code);
        } else {
          unavailable[code] = { reason: 'rotation_off' };
        }
      }
    }

    // Preserve display_order in the available_codes array
    const available_codes = itemRows
      .map((r) => r.code)
      .filter((code) => availableSet.has(code));

    return res.status(200).json({
      as_of: new Date().toISOString(),
      date_local: dateStr,
      available_codes,
      unavailable_with_reason: unavailable,
    });
  } catch (err) {
    console.error('[menu-today] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
