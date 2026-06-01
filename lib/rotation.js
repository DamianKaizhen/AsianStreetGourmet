// Rotation pick logic — deterministic, no DB writes.
//
// Given:
//   - A list of menu items in 'rotation' mode whose ingredients are all
//     available today.
//   - The category's `pool_size` (how many to feature today).
//   - Today's date string in America/New_York.
//
// Hash (date + code) with SHA-256, interpret first 4 bytes as uint32, sort
// ascending, take top N. Same inputs → same output, every reload.

import { createHash } from 'node:crypto';

const TZ = 'America/New_York';

export function todayDateString(now = new Date()) {
  // en-CA formats as YYYY-MM-DD natively, with the zero-padding we want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function priorityFor(dateStr, code) {
  const buf = createHash('sha256').update(`${dateStr}:${code}`).digest();
  return buf.readUInt32BE(0);
}

export function pickRotation(eligibleCodes, poolSize, dateStr) {
  if (poolSize <= 0) return [];
  if (poolSize >= eligibleCodes.length) return [...eligibleCodes];
  return eligibleCodes
    .map((code) => ({ code, p: priorityFor(dateStr, code) }))
    .sort((a, b) => a.p - b.p)
    .slice(0, poolSize)
    .map((x) => x.code);
}
