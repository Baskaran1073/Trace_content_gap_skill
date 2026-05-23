// ─── Content Gap Voice — configuration ───────────────────────────────────────
//
// The read-only DB role is granted SELECT on EXACTLY these tables (see
// sql/create_readonly_role.sql). Schema introspection and text-to-SQL are both
// restricted to this set, so nothing outside it is ever exposed to the LLM or
// spoken back. Sensitive tables (ai_logs, *_oauth_states, *_api_cost_log,
// user_main/user_profile, feedback, notifications, prompts, project_members…)
// are intentionally NOT granted to the role and never appear here.

export const ALLOWED_TABLES = [
  // content pipeline
  'content',
  'content_statuses',
  'content_priorities',
  'content_types',
  'platforms',
  'content_scripts',
  'content_assets',
  'content_final_videos',
  'content_status_history',
  // X / tweets
  'x_daily_tweets',
  'x_tweet_summaries',
  'x_followed_accounts',
  'x_tweet_bookmarks',
  // topics & projects (for naming/filtering)
  'topics',
  'topic_categories',
  'projects',
] as const;

// Hard cap on rows returned by any query — bounds what is sent to OpenAI and
// spoken aloud. "How many" questions should use COUNT(*) (see agent prompt) so
// counts stay exact regardless of this cap.
export const MAX_ROWS = 50;

// Per-statement timeout (ms) enforced in the read-only transaction.
export const STATEMENT_TIMEOUT_MS = 5000;

// Only this Trace user.id may invoke the skill. Read at request time from
// process.env.OWNER_USER_ID (printed to logs on each call so you can discover
// your id). Empty = allow all — do not ship empty for a private skill.
export function getOwnerUserId(): string {
  return process.env.OWNER_USER_ID || '';
}
