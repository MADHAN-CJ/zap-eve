import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

/**
 * Lazy singleton Postgres client. Cached on globalThis so Next.js dev HMR and
 * the eve runtime (which may load this module through a separate bundle) don't
 * leak connection pools. Callers that must never crash the agent loop (the
 * persist hook) catch errors themselves; API routes let a missing DATABASE_URL
 * surface as a 500 with a clear message.
 */

export type Db = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as {
  __zapEveDb?: { pool: Pool; db: Db };
};

export function db(): Db {
  if (globalForDb.__zapEveDb) return globalForDb.__zapEveDb.db;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set — chat persistence is unavailable.');
  }

  const pool = new Pool({ connectionString: url, max: 10 });
  const client = drizzle(pool, { schema });
  globalForDb.__zapEveDb = { pool, db: client };
  return client;
}
