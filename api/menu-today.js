// GET /api/menu-today
// Public endpoint. Returns today's available menu codes + (for admin debugging)
// a map of unavailable items with their reasons + the daily soup schedule.
//
// Response:
//   {
//     as_of: "2026-05-13T19:42:00Z",            // server time
//     date_local: "2026-05-13",                  // YYYY-MM-DD in NY tz
//     day_of_week: 2,                            // 0=Sun..6=Sat in NY tz
//     available_codes: ["A1","A3","C2",...],
//     unavailable_with_reason: {
//       "A2": { reason: "missing", missing: ["chicken"] }
//     },
//     soup_today: { code: "C2", name_en: "...", name_zh: "..." } | null,
//     soup_week:  [{ day_of_week: 0..6, code, name_en, name_zh } | { day_of_week, code: null }, ...],
//     todays_specials: [{ code, name_zh, name_en, price_cents }, ...],  // empty array if none
//     menu_items: [{ code, name_en, name_zh, category, price_cents, display_order }, ...]  // non-archived
//   }

import { sql } from '../lib/db.js';
import { todayDateString, pickRotation } from '../lib/rotation.js';
import { getSetting } from '../lib/settings.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ----- Query 1: items + per-item flag + which non-pantry ingredients are out -----
    // Archived items (replaced by the new menu) are excluded so they
    // never surface on the public site or in admin lists.
    const itemRows = await sql`
      SELECT
        m.code,
        m.name_en,
        m.name_zh,
        m.category,
        m.price_cents,
        m.rotation_mode,
        m.is_available AS item_is_available,
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
      WHERE m.is_archived = FALSE
      GROUP BY m.code, m.category, m.rotation_mode, m.is_available, m.display_order
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

    // ----- Pass 1: filter by per-item flag, then by ingredients -----
    // Reasons ranked by user-visible weight: the admin's explicit "off today"
    // toggle takes priority over derived ingredient/rotation reasons.
    const rotationCandidates = {}; // category → [codes]
    for (const row of itemRows) {
      if (row.item_is_available === false) {
        unavailable[row.code] = { reason: 'unavailable_today' };
        continue;
      }
      const missing = row.missing || [];
      if (missing.length > 0) {
        unavailable[row.code] = { reason: 'missing', missing };
        continue;
      }
      if (row.rotation_mode === 'always') {
        availableSet.add(row.code);
      } else {
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

    // ----- Query 3: full week's soup schedule, joined to soup item names -----
    // Empty days (no row in soup_schedule) come back as { day_of_week, code: null }
    // so the public "this week" strip can show all 7 days consistently.
    const scheduleRows = await sql`
      SELECT
        s.day_of_week,
        s.soup_code AS code,
        m.name_en,
        m.name_zh
      FROM soup_schedule s
      LEFT JOIN menu_items m ON m.code = s.soup_code
      ORDER BY s.day_of_week
    `;
    const soupByDow = {};
    for (const r of scheduleRows) {
      soupByDow[r.day_of_week] = (r.code && availableSet.has(r.code))
        ? { code: r.code, name_en: r.name_en, name_zh: r.name_zh }
        : null;
    }
    const soup_week = [];
    for (let d = 0; d < 7; d++) {
      soup_week.push({ day_of_week: d, ...(soupByDow[d] || { code: null }) });
    }

    // "Today" in NY time — compute via Intl so it matches what the kitchen
    // (and the public hero "today's soup" card) actually means.
    const dowFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
    });
    const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day_of_week = dowMap[dowFmt.format(new Date())] ?? 0;
    const soup_today = soup_week[day_of_week]?.code
      ? soup_week[day_of_week]
      : null;

    // ----- Today's specials — single JSON-encoded array in `specials_json` -----
    // Read soft-fails to [] so a settings-read blip doesn't 500 the whole
    // endpoint. Defensive parse + per-row shape check protects the public
    // site from rendering garbage if the column was hand-edited to bad JSON.
    let todays_specials = [];
    try {
      const raw = await getSetting('specials_json');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          todays_specials = parsed.filter((s) =>
            s && typeof s.code === 'string' && s.code.length > 0
              && typeof s.name_zh === 'string' && s.name_zh.length > 0
              && typeof s.name_en === 'string' && s.name_en.length > 0
              && Number.isInteger(s.price_cents) && s.price_cents >= 0
          );
        }
      }
    } catch (err) {
      console.warn('[menu-today] todays_specials read failed:', err.message);
    }

    // ----- Flatten the full item list for the public dynamic render -----
    // Includes archived = false rows only (the SQL filter above). Sorted by
    // display_order so the client doesn't need its own sort.
    const menu_items = itemRows.map((r) => ({
      code: r.code,
      name_en: r.name_en,
      name_zh: r.name_zh,
      category: r.category,
      price_cents: r.price_cents,
      display_order: r.display_order,
    }));

    return res.status(200).json({
      as_of: new Date().toISOString(),
      date_local: dateStr,
      day_of_week,
      available_codes,
      unavailable_with_reason: unavailable,
      soup_today,
      soup_week,
      todays_specials,
      menu_items,
    });
  } catch (err) {
    console.error('[menu-today] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
