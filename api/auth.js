// /api/auth — replaces /api/login and /api/logout.
//
// POST   /api/auth  { username, password }  → set session cookie
// DELETE /api/auth                          → clear session cookie

import { checkAdminCredentials, issueSession, clearSession } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const { username, password } = (req.body && typeof req.body === 'object') ? req.body : {};
      if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'username and password required' });
      }
      if (!checkAdminCredentials(username, password)) {
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

  res.setHeader('Allow', 'POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
