// Database client (Neon serverless Postgres).
//
// The Vercel ↔ Neon marketplace integration injects DATABASE_URL automatically
// when the function runs. Neon's serverless driver uses HTTP fetch under the
// hood (not TCP), so it works in both Node and Edge runtimes without warm
// connection pools to worry about.
//
// Usage in functions:
//
//   import { sql } from '../lib/db.js';
//   const rows = await sql`SELECT * FROM ingredients WHERE id = ${id}`;
//
// Returns an array of row objects directly (no .rows wrapper).

import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  // Defer the throw to first use rather than at module-import time so the
  // file still loads in environments where the env var isn't set yet (e.g.,
  // during deploy build, or running the auth.js CLI locally).
  console.warn('[db] DATABASE_URL not set — queries will fail until it is.');
}

export const sql = neon(process.env.DATABASE_URL || '');
