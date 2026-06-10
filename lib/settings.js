// Tiny helpers for the key-value `settings` table.
// Currently used only for `cart_enabled`; future feature flags slot in here.

import { sql } from './db.js';

/**
 * Read a setting by key. Returns the raw text value, or null if missing.
 */
export async function getSetting(key) {
  const rows = await sql`SELECT value FROM settings WHERE key = ${key}`;
  return rows.length > 0 ? rows[0].value : null;
}

/**
 * Upsert a setting.
 */
export async function setSetting(key, value) {
  const rows = await sql`
    INSERT INTO settings (key, value)
    VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = NOW()
    RETURNING key, value, updated_at
  `;
  return rows[0];
}

/**
 * Convenience: is the cart feature enabled?
 * Defaults to false if the setting is missing or unrecognized — fail-safe.
 */
export async function isCartEnabled() {
  const v = await getSetting('cart_enabled');
  return v === 'true';
}
