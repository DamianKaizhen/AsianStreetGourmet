// POST /api/logout
// Clears the session cookie. No body needed.

import { clearSession } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  clearSession(res);
  return res.status(200).json({ ok: true });
}
