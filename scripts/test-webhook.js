// Ad-hoc webhook tester. Run while `npm run dev` is up.
// Verifies: HMAC guard (401s) + happy path (202 ack -> async callback).
const crypto = require('crypto');
const http = require('http');

const SECRET = process.env.TRACE_HMAC_SECRET || ''; // matches server default
const WEBHOOK = 'http://localhost:3000/webhook';
const CALLBACK_PORT = 4000;

function sign(body, timestamp) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
}

async function post(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  let parsed; const text = await res.text();
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

(async () => {
  // 1. Local callback receiver — captures the async POST the skill makes back.
  let callbackPayload = null;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      callbackPayload = { headers: req.headers, body: JSON.parse(data || '{}') };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise(r => server.listen(CALLBACK_PORT, r));

  // --- Test 1: missing signature -> 401 ---
  const t1 = await post(WEBHOOK, {}, JSON.stringify({ event: {}, user: {} }));
  console.log('1) no signature      ->', t1.status, JSON.stringify(t1.body));

  // --- Test 2: bad signature -> 401 ---
  const ts = Date.now().toString();
  const t2 = await post(WEBHOOK, { 'X-Trace-Timestamp': ts, 'X-Trace-Signature': 'sha256=deadbeef' }, JSON.stringify({ event: {}, user: {} }));
  console.log('2) bad signature     ->', t2.status, JSON.stringify(t2.body));

  // --- Test 3: valid signature, happy path -> 202 + callback ---
  const payload = {
    event: { channel: 'media.photo', media_url: 'https://example.com/cat.jpg' },
    user: { id: 'user_123' },
    request_id: 'req_' + crypto.randomUUID(),
    callback_url: `http://localhost:${CALLBACK_PORT}/callback`,
  };
  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const t3 = await post(WEBHOOK, { 'X-Trace-Timestamp': timestamp, 'X-Trace-Signature': sign(body, timestamp) }, body);
  console.log('3) valid signature   ->', t3.status, JSON.stringify(t3.body));

  // Wait for the async callback.
  for (let i = 0; i < 30 && !callbackPayload; i++) await new Promise(r => setTimeout(r, 100));
  if (callbackPayload) {
    console.log('   callback received  -> sig valid:',
      callbackPayload.headers['x-trace-signature'] ===
        sign(JSON.stringify(callbackPayload.body), callbackPayload.headers['x-trace-timestamp']));
    console.log('   callback body      ->', JSON.stringify(callbackPayload.body));
  } else {
    console.log('   callback received  -> NONE (timed out)');
  }

  server.close();
})();
