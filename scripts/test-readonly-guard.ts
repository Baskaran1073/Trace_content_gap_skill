// Unit test for the Layer-3 read-only guard. Run: npm run test:guard
// (No database needed — this tests assertReadOnly() in isolation.)
import { assertReadOnly } from '../src/sql-guard';

let pass = 0;
let fail = 0;

function ok(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    fail++;
    console.error(`  ✗ ${name} — ${e.message}`);
  }
}

function shouldAccept(sql: string) {
  assertReadOnly(sql); // throws on reject
}

function shouldReject(sql: string) {
  let threw = false;
  try {
    assertReadOnly(sql);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('expected rejection but it was accepted');
}

console.log('Accepted (valid read-only queries):');
ok('simple select', () => shouldAccept("SELECT title FROM content WHERE status = 'editing' LIMIT 10"));
ok('count', () => shouldAccept('SELECT COUNT(*) FROM content WHERE status = $1'));
ok('CTE select', () =>
  shouldAccept('WITH e AS (SELECT * FROM content WHERE status = \'editing\') SELECT count(*) FROM e'));
ok('trailing semicolon', () => shouldAccept('SELECT 1;'));
ok('write-word inside a string literal is fine', () =>
  shouldAccept("SELECT * FROM x_daily_tweets WHERE tweet_text ILIKE '%how to delete files%' LIMIT 5"));
ok('column named like a keyword via quotes', () =>
  shouldAccept('SELECT title AS "update" FROM content LIMIT 1'));

console.log('\nRejected (writes / DDL / multi-statement / injection):');
ok('DELETE', () => shouldReject('DELETE FROM content'));
ok('UPDATE', () => shouldReject("UPDATE content SET status = 'published'"));
ok('INSERT', () => shouldReject("INSERT INTO content (title) VALUES ('x')"));
ok('DROP', () => shouldReject('DROP TABLE content'));
ok('stacked statements', () => shouldReject("SELECT 1; DROP TABLE content"));
ok('data-modifying CTE', () => shouldReject('WITH d AS (DELETE FROM content RETURNING *) SELECT * FROM d'));
ok('comment-hidden stack', () => shouldReject('SELECT 1 /* x */; DELETE FROM content'));
ok('line-comment trick', () => shouldReject('SELECT 1 -- foo\n; DROP TABLE content'));
ok('TRUNCATE', () => shouldReject('TRUNCATE content'));
ok('GRANT', () => shouldReject('GRANT ALL ON content TO public'));
ok('non-select start', () => shouldReject('EXPLAIN ANALYZE SELECT 1'));
ok('empty', () => shouldReject('   '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
