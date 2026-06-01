// POST /api/login
// Body: { username, password }
// On success: sets the session cookie + returns { ok: true }.
// On failure: 401 { error }.

import { checkAdminCredentials, issueSession } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Vercel Node functions auto-parse JSON bodies when the content-type matches.
    const { username, password } = (req.body && typeof req.body === 'object') ? req.body : {};

    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'username and password required' });
    }

    if (!checkAdminCredentials(username, password)) {
      // Don't disclose whether it was the username or password that was wrong.
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    issueSession(res);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[login] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
