// ─── Runtime schema introspection (allowlisted tables only) ───────────────────
//
// Builds a compact schema description + live lookup/enum values that are fed to
// the text-to-SQL prompt, so the skill adapts to schema changes automatically.
// Only ALLOWED_TABLES are ever introspected, so the LLM never learns about any
// table the read-only role can't read anyway.

import { runReadOnlyQuery } from './db';
import { ALLOWED_TABLES } from './config';

const TTL_MS = 10 * 60 * 1000; // refresh at most every 10 min
let cache: { text: string; at: number } | null = null;

// Stable relationship/usage notes the column dump can't convey on its own.
const RELATIONSHIP_NOTES = `Relationships & notes:
- content.status is a text key into content_statuses.key. Pipeline order:
  script → script_in_review → shooting → editing → editing_in_review →
  thumbnail → thumbnail_in_review → ready_to_publish → published.
- content.priority is a text key into content_priorities.key (low/medium/high/urgent).
- content.content_type_id → content_types.id; content.topic_id → topics.id.
- content.platform_ids is uuid[] referencing platforms.id. To filter by platform,
  join platforms and use: platforms.id = ANY(content.platform_ids).
- content_scripts/content_assets/content_final_videos/content_status_history all
  reference content.id via content_id.
- x_tweet_summaries: the "latest tweet summary" = ORDER BY summary_date DESC LIMIT 1
  (fields: summary_text, tweet_count, account_count).
- x_daily_tweets.followed_account_id → x_followed_accounts.id;
  engagement: like_count, reply_count, retweet_count; posted time: tweeted_at.
- topics/topic_categories/projects carry human-readable names for labels.`;

async function introspectColumns(): Promise<string> {
  const inList = ALLOWED_TABLES.map((t) => `'${t}'`).join(',');
  const rows = await runReadOnlyQuery(`
    SELECT table_name,
           string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN (${inList})
    GROUP BY table_name
    ORDER BY table_name
  `);
  return rows.map((r: any) => `${r.table_name}(${r.cols})`).join('\n');
}

async function introspectEnums(): Promise<string> {
  try {
    const rows = await runReadOnlyQuery(`
      SELECT 'status'::text AS kind, key, label FROM content_statuses WHERE is_active
      UNION ALL SELECT 'priority', key, label FROM content_priorities WHERE is_active
      UNION ALL SELECT 'content_type', slug, name FROM content_types WHERE is_active
      UNION ALL SELECT 'platform', slug, name FROM platforms WHERE is_active
    `);
    if (!rows.length) return '';
    const byKind: Record<string, string[]> = {};
    for (const r of rows as any[]) {
      (byKind[r.kind] ||= []).push(`${r.key} (${r.label})`);
    }
    return (
      'Lookup values:\n' +
      Object.entries(byKind)
        .map(([k, v]) => `- ${k}: ${v.join(', ')}`)
        .join('\n')
    );
  } catch {
    return ''; // enums are a nicety; never block on them
  }
}

/** Compact schema text (columns + relationships + live enum values), cached. */
export async function getSchemaText(): Promise<string> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.text;
  const [cols, enums] = await Promise.all([introspectColumns(), introspectEnums()]);
  const text = [`Tables (schema "public"):\n${cols}`, RELATIONSHIP_NOTES, enums]
    .filter(Boolean)
    .join('\n\n');
  cache = { text, at: Date.now() };
  return text;
}
