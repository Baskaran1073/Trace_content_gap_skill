// ─── Read-only Postgres access to Content Gap ─────────────────────────────────
//
// Defense in depth (writes are impossible at three independent layers):
//   Layer 1  — connects as a SELECT-only role (sql/create_readonly_role.sql).
//              The role is also ALTER'd to default_transaction_read_only = on.
//   Layer 2  — every query runs inside an explicit READ ONLY transaction with a
//              statement timeout; Postgres aborts any write attempted within it.
//   Layer 3  — assertReadOnly() rejects non-SELECT / multi-statement input.
//
// Results are additionally capped to MAX_ROWS via an outer wrapping LIMIT.

import { Pool } from 'pg';
import { MAX_ROWS, STATEMENT_TIMEOUT_MS } from './config';
import { assertReadOnly } from './sql-guard';

let pool: Pool | null = null;

// Lazily create the pool so .env is guaranteed loaded by first use.
function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.CONTENT_GAP_DB_URL;
  if (!connectionString) throw new Error('CONTENT_GAP_DB_URL is not set.');
  pool = new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 30_000,
    // Supabase requires TLS. We don't pin the CA here; the connection is still
    // encrypted. Pin a CA cert in production if you want to defeat MITM fully.
    ssl: { rejectUnauthorized: false },
  });
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  return pool;
}

/**
 * Execute a single read-only SELECT and return up to MAX_ROWS rows.
 * Throws on validation failure, write attempts, or timeout.
 */
export async function runReadOnlyQuery(sql: string): Promise<any[]> {
  const clean = assertReadOnly(sql);
  // Wrap as a subquery so we always bound row count, even if the inner query
  // omits a LIMIT. (A subquery may legally contain its own WITH/ORDER BY.)
  const wrapped = `SELECT * FROM (${clean}) AS _q LIMIT ${MAX_ROWS}`;

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const res = await client.query(wrapped);
    await client.query('ROLLBACK'); // read-only — nothing to commit
    return res.rows;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback errors */
    }
    throw err;
  } finally {
    client.release();
  }
}
