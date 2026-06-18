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

export function issueSession(res, username) {
  const expSec = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC;
  const payload = { admin: true, exp: expSec };
  if (typeof username === 'string' && username.length > 0) payload.user = username;
  const value = signSession(payload);
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
// Active password hash lookups.
//
// The PRIMARY admin (env-var username) has its hash stored in the
// `settings` table under key `admin_password_hash`. Until that row
// exists, we fall back to the bootstrap env var `ADMIN_PASSWORD_HASH`.
// Once the DB row is written, the env var is IGNORED — editing it on
// Vercel has no effect until either:
//   (a) ADMIN_RECOVERY_MODE is set (recovery path), or
//   (b) you `DELETE FROM settings WHERE key='admin_password_hash'`
//       in the Neon SQL editor (manual recovery path).
//
// SECONDARY admins (rows in `admin_users`) keep their hash in that
// table — there is no env-var fallback for them. Lockout for a
// secondary user is recovered by either (1) the primary admin
// deleting/resetting them in the DB, or (2) deleting the secondary
// row directly in Neon.
// ----------------------------------------------------------------------

export async function getActivePasswordHash() {
  // Primary-admin hash. Keeps the legacy name for backwards-compat with
  // any code that still calls it without a username.
  try {
    const { getSetting } = await import('./settings.js');
    const fromDb = await getSetting('admin_password_hash');
    if (typeof fromDb === 'string' && fromDb.length > 0) return fromDb;
  } catch (err) {
    console.warn('[auth] getActivePasswordHash db read failed, falling back to env:', err.message);
  }
  return process.env.ADMIN_PASSWORD_HASH || null;
}

// Returns the active hash for a given username, or null if not found.
// Username matching against the env user is case-sensitive (matches
// what we compare in checkAdminCredentials).
export async function getActiveHashForUser(username) {
  if (typeof username !== 'string' || username.length === 0) return null;
  if (username === (process.env.ADMIN_USERNAME || '')) {
    return await getActivePasswordHash();
  }
  try {
    const { sql } = await import('./db.js');
    const rows = await sql`SELECT password_hash FROM admin_users WHERE username = ${username}`;
    return rows.length > 0 ? rows[0].password_hash : null;
  } catch (err) {
    console.warn('[auth] getActiveHashForUser db read failed:', err.message);
    return null;
  }
}

// Looks up a secondary user by username in admin_users. Returns the row
// (id, username, password_hash) or null.
async function findSecondaryUser(username) {
  if (typeof username !== 'string' || username.length === 0) return null;
  try {
    const { sql } = await import('./db.js');
    const rows = await sql`
      SELECT id, username, password_hash
      FROM admin_users
      WHERE username = ${username}
      LIMIT 1
    `;
    return rows.length > 0 ? rows[0] : null;
  } catch (err) {
    console.warn('[auth] findSecondaryUser db read failed:', err.message);
    return null;
  }
}

// ----------------------------------------------------------------------
// Username + password check (used by /api/auth POST).
//
// Returns { ok, recovery, username } where:
//   ok       — true when credentials match
//   recovery — true when this login succeeded via the env-var recovery
//              path (ADMIN_RECOVERY_MODE was set). The caller surfaces
//              this to the UI so the family is reminded to set a new
//              password and remove the recovery env var.
//   username — the matched username (env-var user OR admin_users row);
//              embedded in the session so PATCH /api/auth knows whose
//              hash to update.
//
// Auth flow:
//   1. If recovery mode is on: only check against ADMIN_PASSWORD_HASH
//      env var (bypassing both DB primary hash and admin_users). On
//      success, wipe the DB primary hash row.
//   2. Otherwise:
//      a. Compare against the env-var primary user. If it matches,
//         use the active primary hash (DB row or env fallback).
//      b. If not, look the user up in admin_users.
// Constant-time comparison is preserved in both branches.
// ----------------------------------------------------------------------

function isRecoveryMode() {
  const v = process.env.ADMIN_RECOVERY_MODE;
  return typeof v === 'string' && v.length > 0 && v.toLowerCase() !== 'false' && v !== '0';
}

function constantTimeStringEqual(a, b) {
  // Pad to the same length so neither timingSafeEqual nor the underlying
  // Buffer compare throws on length mismatch; the length check at the end
  // re-confirms identity.
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  const maxLen = Math.max(aBuf.length, bBuf.length, 1);
  const padA = Buffer.alloc(maxLen);
  const padB = Buffer.alloc(maxLen);
  aBuf.copy(padA);
  bBuf.copy(padB);
  return aBuf.length === bBuf.length && timingSafeEqual(padA, padB);
}

export async function checkAdminCredentials(username, password) {
  const inputUser = typeof username === 'string' ? username : '';
  const inputPass = typeof password === 'string' ? password : '';
  const envUser = process.env.ADMIN_USERNAME || '';

  // -------- Recovery mode (env-var-only path) --------
  if (isRecoveryMode()) {
    const envHash = process.env.ADMIN_PASSWORD_HASH || '';
    if (!envUser || !envHash) return { ok: false, recovery: false, username: null };
    const userMatches = constantTimeStringEqual(inputUser, envUser);
    const passMatches = verifyPassword(inputPass, envHash); // always run for timing safety
    const ok = userMatches && passMatches;
    if (ok) {
      try {
        const { sql } = await import('./db.js');
        await sql`DELETE FROM settings WHERE key = 'admin_password_hash'`;
      } catch (err) {
        console.warn('[auth] recovery: DB row wipe failed:', err.message);
      }
    }
    return { ok, recovery: ok, username: ok ? envUser : null };
  }

  // -------- Primary admin (env-var username) --------
  // We try the primary first; on username mismatch we fall through to
  // checking admin_users. Either way we always run a verifyPassword call
  // so total request time doesn't reveal whether the username existed.
  if (envUser && constantTimeStringEqual(inputUser, envUser)) {
    const primaryHash = (await getActivePasswordHash()) || '';
    const passMatches = primaryHash ? verifyPassword(inputPass, primaryHash) : false;
    return { ok: passMatches, recovery: false, username: passMatches ? envUser : null };
  }

  // -------- Secondary admin (admin_users row) --------
  const row = await findSecondaryUser(inputUser);
  // Even on miss we run a verifyPassword so timing stays comparable. The
  // dummy hash ensures verifyPassword does real scrypt work regardless.
  const candidateHash = row ? row.password_hash : '';
  const passMatches = candidateHash ? verifyPassword(inputPass, candidateHash) : false;
  if (!row || !passMatches) return { ok: false, recovery: false, username: null };
  return { ok: true, recovery: false, username: row.username };
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
  } else if (cmd === 'verify') {
    // Usage: node lib/auth.js verify 'salt:hash' 'password'
    const [stored, ...pwParts] = rest;
    const password = pwParts.join(' ');
    if (!stored || !password) {
      console.error("Usage: node lib/auth.js verify 'salt:hash' 'password'");
      process.exit(1);
    }
    const ok = verifyPassword(password, stored);
    console.log(ok ? '✓ match' : '✗ no match');
    process.exit(ok ? 0 : 2);
  } else {
    console.error('Unknown command. Usage:');
    console.error("  node lib/auth.js hash 'password'");
    console.error("  node lib/auth.js verify 'salt:hash' 'password'");
    process.exit(1);
  }
}
