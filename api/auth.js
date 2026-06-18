// /api/auth — consolidated login, logout, and password-change.
//
// POST   /api/auth  { username, password }                    → set session cookie
// DELETE /api/auth                                            → clear session cookie
// PATCH  /api/auth  { current_password, new_password }        → change admin password
//                                                              (PATCH path is admin-gated)

import {
  checkAdminCredentials,
  issueSession,
  clearSession,
  hashPassword,
  verifyPassword,
  getActivePasswordHash,
  requireAdmin,
} from '../lib/auth.js';
import { setSetting } from '../lib/settings.js';

const MIN_PASSWORD_LENGTH = 8;

// PATCH path is wrapped in requireAdmin so only an already-logged-in admin
// can change the password. The unwrapped paths (POST login, DELETE logout)
// must stay public for the login form to work.
const patchHandler = requireAdmin(async (req, res) => {
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

    const stored = (await getActivePasswordHash()) || '';
    if (!verifyPassword(current_password, stored)) {
      return res.status(401).json({ error: 'wrong_current' });
    }

    await setSetting('admin_password_hash', hashPassword(new_password));
    // Refresh the 8-hour TTL after a sensitive action so the admin doesn't
    // get bounced to login immediately if their session was near expiry.
    issueSession(res);
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
      if (!(await checkAdminCredentials(username, password))) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      issueSession(res);
      return res.status(200).json({ ok: true });
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
