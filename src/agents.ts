// ─── OpenAI agents: text-to-SQL + spoken-answer phrasing ──────────────────────
//
// generateSql()    — turns a spoken question into ONE read-only SELECT (or asks
//                    for clarification). Read-only is enforced downstream by the
//                    DB role + transaction; this prompt just steers it.
// summarizeAnswer() — turns result rows into one short, TTS-friendly sentence.

import OpenAI from 'openai';
import { MAX_ROWS } from './config';

let _openai: OpenAI | null = null;
// Lazily construct the client so .env is loaded before first use.
function openai(): OpenAI {
  return (_openai ||= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
}
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

export interface SqlPlan {
  sql?: string;
  clarify?: string;
}

function sqlSystemPrompt(schemaText: string): string {
  return `You convert a user's spoken question about their "Content Gap" content database into a single PostgreSQL query.

${schemaText}

Rules:
- Output JSON only: {"sql": "<one SELECT statement>"} OR {"clarify": "<one short question>"}.
- The query MUST be a single read-only SELECT (a WITH ... SELECT is fine). NEVER write
  (no INSERT/UPDATE/DELETE/DDL) — such queries will be rejected by the database.
- Use ONLY the tables and columns listed above. Do not reference any other table.
- For "how many" / counting questions, use COUNT(*) so the count is exact.
- Always include an explicit LIMIT (<= ${MAX_ROWS}) on row-returning queries.
- Map natural language to the lookup keys above (e.g. "in editing" → status = 'editing';
  "in review" may mean script_in_review/editing_in_review/thumbnail_in_review — prefer the
  closest, or use status LIKE '%in_review' if the user is generic).
- "latest tweet summary" → SELECT from x_tweet_summaries ORDER BY summary_date DESC LIMIT 1.
- Prefer human-readable columns (title, name, summary_text, label) over ids/uuids.
- If the question is ambiguous or needs info not in the schema, return {"clarify": "..."}.`;
}

/** Generate a read-only SELECT (or a clarification) for the question. */
export async function generateSql(question: string, schemaText: string): Promise<SqlPlan> {
  const resp = await openai().chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sqlSystemPrompt(schemaText) },
      { role: 'user', content: question },
    ],
  });
  const raw = resp.choices[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(raw) as SqlPlan;
    if (parsed.sql) parsed.sql = parsed.sql.trim();
    return parsed;
  } catch {
    return { clarify: "Sorry, I couldn't understand that — could you rephrase?" };
  }
}

/** Turn result rows into a single short, natural sentence for text-to-speech. */
export async function summarizeAnswer(question: string, rows: any[]): Promise<string> {
  const resp = await openai().chat.completions.create({
    model: MODEL,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content:
          'You are a concise voice assistant for the user\'s content pipeline. ' +
          'Given the question and the JSON result rows, answer in ONE short, natural ' +
          'spoken sentence (two at most). No markdown, no lists, no SQL. Use plain ' +
          'numbers and names. If there are no rows, say nothing matched in a friendly way.',
      },
      {
        role: 'user',
        // Bound the payload sent to OpenAI (rows are already <= MAX_ROWS).
        content: JSON.stringify({ question, rows }).slice(0, 12_000),
      },
    ],
  });
  return resp.choices[0]?.message?.content?.trim() || "I couldn't find an answer to that.";
}
