// Live read-only probe against Content Gap. Run: npx ts-node -T scripts/test-db.ts
// Proves: allowed reads work, disallowed tables are denied, writes are blocked.
import '../src/env';
import { Pool } from 'pg';

async function main() {
  const url = process.env.CONTENT_GAP_DB_URL;
  if (!url) throw new Error('CONTENT_GAP_DB_URL not set');

  const pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 8000,
  });

  const client = await pool.connect();
  const check = async (label: string, sql: string, expectFail: boolean) => {
    try {
      const r = await client.query(sql);
      const mark = expectFail ? '✗ UNEXPECTED SUCCESS' : '✓';
      console.log(`  ${mark} ${label}: ${JSON.stringify(r.rows)}`);
    } catch (e: any) {
      const mark = expectFail ? '✓ blocked' : '✗ FAILED';
      console.log(`  ${mark} ${label}: ${e.message}`);
    }
  };

  console.log('READ — allowed tables (expect success):');
  await check('content in editing', "SELECT count(*)::int n FROM content WHERE status='editing'", false);
  await check('latest tweet summary date', 'SELECT max(summary_date) FROM x_tweet_summaries', false);

  console.log('READ — disallowed table (expect denied):');
  await check('ai_logs', 'SELECT count(*) FROM ai_logs', true);
  await check('x_oauth_states', 'SELECT count(*) FROM x_oauth_states', true);

  console.log('WRITE — (expect blocked by role + read-only tx):');
  await check('insert', "INSERT INTO content (title) VALUES ('skill-test-should-fail')", true);
  await check('update', 'UPDATE content SET title = title WHERE false', true);

  client.release();
  await pool.end();
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
