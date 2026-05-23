// ─── App-level read-only guard (Layer 3) ─────────────────────────────────────
//
// This is the LAST line of defense, not the primary one. Writes are already made
// impossible by (1) the SELECT-only Postgres role and (2) the READ ONLY
// transaction in db.ts. This guard rejects obviously non-read input early and
// keeps a single statement, so a clear error is returned instead of a DB abort.

// Data-modifying and DDL verbs. We strip string/identifier literals before
// testing so legitimate content like a tweet containing the word "update" does
// not trip the guard. NOTE: `select`/`with` are allowed; transaction/SET verbs
// are unreachable because we forbid multiple statements.
const FORBIDDEN =
  /\b(insert|update|delete|merge|upsert|drop|alter|truncate|create|grant|revoke|comment|copy|call|do|vacuum|reindex|refresh|cluster|listen|notify|prepare|deallocate|lock)\b/i;

/**
 * Validate that `sql` is a single read-only SELECT/WITH statement.
 * Returns the cleaned statement (comments + trailing semicolon stripped).
 * Throws with a user-safe message otherwise.
 */
export function assertReadOnly(sql: string): string {
  if (!sql || typeof sql !== 'string') throw new Error('Empty query.');

  // Strip block and line comments, collapse whitespace.
  let s = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();

  // Allow exactly one optional trailing semicolon, then forbid any other.
  s = s.replace(/;\s*$/, '');
  if (s.includes(';')) throw new Error('Only a single statement is allowed.');

  // Must be a read query.
  if (!/^(select|with)\b/i.test(s)) {
    throw new Error('Only SELECT / WITH queries are allowed.');
  }

  // Remove string and double-quoted identifier literals before keyword scan to
  // avoid false positives on content text (e.g. "how to create X" in a tweet).
  const stripped = s
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');

  if (FORBIDDEN.test(stripped)) {
    throw new Error('Query contains a disallowed (write/DDL) keyword.');
  }

  return s;
}
