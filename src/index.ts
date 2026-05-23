import './env'; // must be first — loads .env before modules that read it
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { verifyTraceSignature } from './hmac';
import { getSchemaText } from './schema';
import { runReadOnlyQuery } from './db';
import { generateSql, summarizeAnswer } from './agents';
import { getOwnerUserId } from './config';

const app = express();
const PORT = process.env.PORT || 3000;
const TRACE_HMAC_SECRET = process.env.TRACE_HMAC_SECRET || '';
const TRACE_SKILL_ID = process.env.TRACE_SKILL_ID || '';
const BRAIN_BASE_URL = process.env.BRAIN_BASE_URL || 'https://brain.endlessriver.ai';

// Capture rawBody BEFORE JSON parsing — required for HMAC verification.
app.use(
  express.json({
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
  })
);

// ─── 🟢 Webhook Endpoint ──────────────────────────────────────────────────────
// media.photo, media.audio, media.video events arrive here.
// Always: return 202 immediately, then process asynchronously and POST to callback_url.
app.post('/webhook', verifyTraceSignature(TRACE_HMAC_SECRET), async (req: Request, res: Response) => {
  const { event, user, request_id, callback_url } = req.body;
  console.log(`[Webhook] Received ${event.channel} for user ${user.id}`);

  // Acknowledge immediately — never keep the platform waiting.
  res.status(202).json({ status: 'accepted' });

  // Process asynchronously, then call back with results.
  processEvent({ event, user, requestId: request_id, callbackUrl: callback_url })
    .catch((err) => console.error('[Webhook] processing error:', err));
});

async function processEvent(opts: {
  event: any;
  user: any;
  requestId: string;
  callbackUrl: string;
}) {
  const { event, user, requestId, callbackUrl } = opts;

  // TODO: add your processing logic here (vision, audio, etc.)
  // Then POST the results to callbackUrl.

  const responses = [
    {
      type: 'notification',
      content: {
        title: 'Template Skill',
        body: `Processed your ${event.channel} event.`,
      },
    },
  ];

  await postCallback(callbackUrl, requestId, responses);
}

// ─── 🔵 MCP (JSON-RPC) Endpoint ──────────────────────────────────────────────
// Used for dialog turns (voice queries).
app.post('/mcp', async (req: Request, res: Response) => {
  const { jsonrpc, method, params, id } = req.body;
  if (jsonrpc !== '2.0') return res.status(400).send('Invalid JSON-RPC');

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'handle_dialog',
            description:
              "Answer the user's spoken questions about their Content Gap content pipeline " +
              '(items in editing/draft/published, statuses, counts) and X/tweets (latest ' +
              'summaries, top tweets). Read-only.',
            inputSchema: {
              type: 'object',
              properties: {
                utterance: { type: 'string' }
              }
            }
          }
        ]
      }
    });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    if (name === 'handle_dialog') {
      const result = await handleContentGapDialog(args || {});
      return res.json({ jsonrpc: '2.0', id, result });
    }
  }

  res.status(404).json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});

// ─── Content Gap dialog pipeline ──────────────────────────────────────────────
// utterance → GPT-4o text-to-SQL → read-only query → GPT-4o spoken summary.

// Plain spoken line — used for prompts/errors. On voice turns the platform
// speaks the `text` content via TTS.
function speak(text: string) {
  return { content: [{ type: 'text', text }] };
}

// Final answer: just the spoken `text` line, read out via TTS on the glasses.
function answer(text: string) {
  return {
    content: [{ type: 'text', text }],
  };
}

async function handleContentGapDialog(args: any) {
  const utterance: string = (args.utterance || args.context?.query || '').trim();
  const userId: string | undefined = args.userId || args.user?.id;
  console.log(`[handle_dialog] user=${userId ?? 'unknown'} utterance="${utterance}"`);

  // Private skill: only the owner may query (allow when no userId, e.g. local curl).
  const owner = getOwnerUserId();
  if (owner && userId && userId !== owner) {
    return speak('Sorry, this skill is private.');
  }

  if (!utterance) {
    return speak('What would you like to know about your content?');
  }

  try {
    const schema = await getSchemaText();
    const plan = await generateSql(utterance, schema);

    if (plan.clarify) {
      // Keep the voice session open so the user's reply comes back to us.
      return { content: [{ type: 'text', text: plan.clarify }], state: 'awaiting_input' };
    }
    if (!plan.sql) {
      return speak("I couldn't turn that into a query — try rephrasing?");
    }

    const rows = await runReadOnlyQuery(plan.sql);
    const replyText = await summarizeAnswer(utterance, rows);
    return answer(replyText);
  } catch (err: any) {
    console.error('[handle_dialog] error:', err?.message);
    return speak('Sorry, I ran into a problem answering that.');
  }
}

// ─── Callback helper ─────────────────────────────────────────────────────────
// Sign and POST the skill's response back to the platform after async processing.

async function postCallback(callbackUrl: string, requestId: string, responses: any[]) {
  const body      = JSON.stringify({ request_id: requestId, status: 'success', responses });
  const timestamp = Date.now().toString();
  const signature = 'sha256=' + crypto
    .createHmac('sha256', TRACE_HMAC_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  const res = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Timestamp': timestamp,
      'X-Trace-Signature': signature,
    },
    body,
  });
  console.log(`[Callback] → ${res.status}`);
}

// ─── 🟣 Proactive Push API Helper ───────────────────────────────────────────
// Use this to send responses on your own schedule (cron, job queue, etc.)
// without a triggering event from the platform.

async function sendPushResponse(user_id: string, responses: any[]) {
  const url = `${BRAIN_BASE_URL}/api/skill-push/${TRACE_SKILL_ID}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TRACE_HMAC_SECRET}`,
    },
    body: JSON.stringify({ user_id, responses }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[Push] ${res.status} ${text}`);
  }
}

// ─── Lifecycle / Deletion ────────────────────────────────────────────────────
app.post('/delete-user', (req: Request, res: Response) => {
  const { user_id } = req.body;
  console.log(`[Cleanup] Deleting data for user ${user_id}`);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Skill template running at http://localhost:${PORT}`);
});
