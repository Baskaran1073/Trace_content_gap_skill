-- ============================================================================
--  Content Gap Voice — dedicated READ-ONLY database role
-- ============================================================================
--  Run ONCE in the Supabase SQL editor for the `content_database` project.
--  This creates a least-privilege role the skill connects as. It can ONLY read,
--  and ONLY the 16 allowlisted tables — everything else (ai_logs, oauth states,
--  api-cost logs, user profiles, etc.) stays invisible to it.
--
--  Security properties:
--    • No INSERT/UPDATE/DELETE/DDL granted          → writes impossible
--    • default_transaction_read_only = on           → every tx is read-only
--    • statement_timeout = 5s                        → no runaway queries
--    • SELECT + permissive RLS policy on 16 tables   → reads those, nothing else
--
--  After running: build the connection string with this role + its password and
--  put it in .env as CONTENT_GAP_DB_URL. ROTATE the password by re-running
--  ALTER ROLE ... PASSWORD '...'.
-- ============================================================================

-- 1) Create the login role. CHANGE THE PASSWORD to a strong random value.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'content_gap_ro') THEN
    CREATE ROLE content_gap_ro LOGIN PASSWORD 'CHANGE_ME_to_a_strong_password';
  END IF;
END $$;

-- 2) Harden the role: read-only transactions by default + a query timeout.
ALTER ROLE content_gap_ro SET default_transaction_read_only = on;
ALTER ROLE content_gap_ro SET statement_timeout = '5s';

-- 3) Allow it to connect and use the public schema (read metadata only).
GRANT CONNECT ON DATABASE postgres TO content_gap_ro;
GRANT USAGE ON SCHEMA public TO content_gap_ro;

-- 4) Grant SELECT + a permissive read policy on EXACTLY the allowlisted tables.
--    RLS is enabled on every table, so SELECT privilege alone is not enough — a
--    policy is required for the role to actually see rows. USING (true) is fine
--    here because this is single-user, personal data.
DO $$
DECLARE
  t text;
  allowlist text[] := ARRAY[
    'content','content_statuses','content_priorities','content_types','platforms',
    'content_scripts','content_assets','content_final_videos','content_status_history',
    'x_daily_tweets','x_tweet_summaries','x_followed_accounts','x_tweet_bookmarks',
    'topics','topic_categories','projects'
  ];
BEGIN
  FOREACH t IN ARRAY allowlist LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO content_gap_ro', t);
    EXECUTE format('DROP POLICY IF EXISTS content_gap_ro_read ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY content_gap_ro_read ON public.%I FOR SELECT TO content_gap_ro USING (true)',
      t
    );
  END LOOP;
END $$;

-- 5) (Optional, defensive) Make sure no broad privileges leak in from PUBLIC on
--    other tables. By default new roles get nothing extra; we add nothing here.

-- ── Verify (run as a check; should list only the 16 tables) ──────────────────
-- SELECT table_name FROM information_schema.role_table_grants
--   WHERE grantee = 'content_gap_ro' AND privilege_type = 'SELECT'
--   ORDER BY table_name;

-- ── Prove it cannot write (run while connected AS content_gap_ro) ────────────
-- INSERT INTO content (title) VALUES ('nope');   -- expect: permission denied / read-only tx
