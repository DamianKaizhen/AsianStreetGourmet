// /api/auth — consolidated login, logout, and password-change.
//
// POST   /api/auth  { username, password }                    → set session cookie
// DELETE /api/auth                                            → clear session cookie
// PATCH  /api/auth  { current_password, new_password }        → change THIS USER'S password
//                                                              (PATCH path is admin-gated;
//                                                               session.user picks the hash row)

import {
  checkAdminCredentials,
  issueSession,
  clearSession,
  hashPassword,
  verifyPassword,
  getActiveHashForUser,
  requireAdmin,
} from '../lib/auth.js';
import { setSetting } from '../lib/settings.js';
import { sql } from '../lib/db.js';

const MIN_PASSWORD_LENGTH = 8;

// PATCH path is wrapped in requireAdmin so only an already-logged-in admin
// can change a password. The session payload carries `user` — we update
// whichever storage row backs that user (settings row for the primary
// env-var user, admin_users row for everyone else).
const patchHandler = requireAdmin(async (req, res, session) => {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const { current_password, new_password } = body;

    if (typeof current_password !== 'string' || typeof new_password !== 'string') {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (new_password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'too_short' });
    }
    if (current_password === new_password) {
      return res.status(400).json({ error: 'same_password' });
    }

    // Username comes from the signed session. If the cookie predates this
    // feature it won't have `user` — fall back to the env-var primary so
    // existing logged-in sessions keep working without a re-login.
    const username = (typeof session.user === 'string' && session.user)
      ? session.user
      : (process.env.ADMIN_USERNAME || '');
    if (!username) return res.status(400).json({ error: 'invalid_body' });

    const stored = (await getActiveHashForUser(username)) || '';
    if (!verifyPassword(current_password, stored)) {
      return res.status(401).json({ error: 'wrong_current' });
    }

    const newHash = hashPassword(new_password);
    if (username === (process.env.ADMIN_USERNAME || '')) {
      // Primary admin: hash lives in the key-value settings table.
      await setSetting('admin_password_hash', newHash);
    } else {
      // Secondary admin: hash lives in their admin_users row.
      const updated = await sql`
        UPDATE admin_users
        SET password_hash = ${newHash}, updated_at = NOW()
        WHERE username = ${username}
        RETURNING id
      `;
      if (updated.length === 0) {
        // The user vanished between login and now (unlikely but possible).
        return res.status(401).json({ error: 'wrong_current' });
      }
    }

    // Refresh the 8-hour TTL after a sensitive action so the admin
    // doesn't get bounced to login immediately if their session was
    // near expiry.
    issueSession(res, username);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[auth PATCH] error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

export default async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const { username, password } = (req.body && typeof req.body === 'object') ? req.body : {};
      if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'username and password required' });
      }
      const result = await checkAdminCredentials(username, password);
      if (!result.ok) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      // Embed the matched username in the session so PATCH knows whose
      // hash to update later.
      issueSession(res, result.username);
      return res.status(200).json({
        ok: true,
        recovery_used: result.recovery === true,
        username: result.username,
      });
    } catch (err) {
      console.error('[auth POST] error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  if (req.method === 'DELETE') {
    clearSession(res);
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'PATCH') {
    return patchHandler(req, res);
  }

  res.setHeader('Allow', 'POST, DELETE, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
}
