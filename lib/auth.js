// Authentication & session management.
//
// Single hardcoded admin: ADMIN_USERNAME and ADMIN_PASSWORD_HASH live in env vars.
// Sessions are HMAC-signed cookies (no server-side session store).
//
// Includes a tiny CLI for generating the password hash one-time, locally:
//
//   node lib/auth.js hash 'your-chosen-password'
//   → prints  salt_b64:hash_b64
//
// Paste that into the ADMIN_PASSWORD_HASH env var on Vercel. The plaintext
// password never leaves your machine.

import {
  randomBytes,
  scryptSync,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ----------------------------------------------------------------------
// Tuning constants
// ----------------------------------------------------------------------

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;
const SALT_BYTES = 16;

const COOKIE_NAME = '__asg_session';
const SESSION_MAX_AGE_SEC = 8 * 60 * 60; // 8 hours

// ----------------------------------------------------------------------
// Password hashing (scrypt)
// ----------------------------------------------------------------------

export function hashPassword(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length < 1) {
    throw new Error('Password must be a non-empty string');
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plaintext, salt, KEY_LEN, SCRYPT_PARAMS);
  return `${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(plaintext, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltB64, hashB64] = stored.split(':');
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const candidate = scryptSync(plaintext, salt, expected.length, SCRYPT_PARAMS);
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------
// Session cookies (HMAC-signed, stateless)
// ----------------------------------------------------------------------

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('SESSION_SECRET env var missing or shorter than 16 chars');
  }
  return secret;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64urlDecode(str) {
  return Buffer.from(str, 'base64url');
}

export function signSession(payload) {
  const value = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', getSecret()).update(value).digest());
  return `${value}.${sig}`;
}

export function verifySession(cookieValue) {
  if (typeof cookieValue !== 'string' || !cookieValue.includes('.')) return null;
  const [value, providedSig] = cookieValue.split('.');
  const expectedSig = b64url(createHmac('sha256', getSecret()).update(value).digest());

  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(b64urlDecode(value).toString('utf8'));
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < nowSec) return null;
    return payload;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------
// Cookie I/O helpers for Vercel Node functions
// ----------------------------------------------------------------------

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function readSession(req) {
  const cookies = parseCookies(req.headers?.cookie);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  return verifySession(raw);
}

function buildCookieString(value, maxAge) {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  // On Vercel, every URL is HTTPS — safe to require Secure. Locally we drop it
  // so `vercel dev` over http://localhost works without cookies being rejected.
  if (process.env.VERCEL) parts.push('Secure');
  return parts.join('; ');
}

export function issueSession(res) {
  const expSec = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC;
  const value = signSession({ admin: true, exp: expSec });
  res.setHeader('Set-Cookie', buildCookieString(value, SESSION_MAX_AGE_SEC));
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', buildCookieString('', 0));
}

// ----------------------------------------------------------------------
// requireAdmin: wrap a function handler so it 401s if there's no valid session
// ----------------------------------------------------------------------

export function requireAdmin(handler) {
  return async (req, res) => {
    const session = readSession(req);
    if (!session || !session.admin) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    return handler(req, res, session);
  };
}

// ----------------------------------------------------------------------
// Username + password check (used by /api/login)
// ----------------------------------------------------------------------

export function checkAdminCredentials(username, password) {
  const expectedUser = process.env.ADMIN_USERNAME || '';
  const expectedHash = process.env.ADMIN_PASSWORD_HASH || '';
  if (!expectedUser || !expectedHash) return false;

  // Constant-time username compare (pad the shorter side to avoid leaking length)
  const a = Buffer.from(username || '', 'utf8');
  const b = Buffer.from(expectedUser, 'utf8');
  const maxLen = Math.max(a.length, b.length);
  const padA = Buffer.alloc(maxLen);
  const padB = Buffer.alloc(maxLen);
  a.copy(padA);
  b.copy(padB);
  const userMatches = a.length === b.length && timingSafeEqual(padA, padB);

  // Always run the password check (even on bad username) so request timing
  // doesn't reveal whether the username existed.
  const passMatches = verifyPassword(password || '', expectedHash);

  return userMatches && passMatches;
}

// ----------------------------------------------------------------------
// CLI: node lib/auth.js hash 'password here'
// ----------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'hash') {
    const password = rest.join(' ');
    if (!password) {
      console.error("Usage: node lib/auth.js hash 'your password here'");
      process.exit(1);
    }
    console.log(hashPassword(password));
  } else {
    console.error('Unknown command. Usage:');
    console.error("  node lib/auth.js hash 'password'");
    process.exit(1);
  }
}
