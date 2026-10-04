// End-to-end check against `wrangler dev` with DRY_RUN=true (nothing is sent to Instagram).
// Usage: npm run dev:test   (in another terminal), then: npm run test:local
import { createHmac } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const APP_SECRET = process.env.IG_APP_SECRET ?? 'local-test-secret';
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN ?? 'local-verify-token';
const MCP_TOKEN = process.env.MCP_TOKEN ?? 'local-mcp-token';
const BUSINESS_ID = '17840000000000000';
const run = Date.now().toString(36); // unique IDs per run so reruns don't collide
const REPLY_WAIT_MS = 9000;

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function webhook(body, signature) {
  const raw = JSON.stringify(body);
  return fetch(`${BASE}/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': signature ?? `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
    body: raw,
  });
}

const dm = (igsid, mid, text) =>
  webhook({
    object: 'instagram',
    entry: [{ id: BUSINESS_ID, time: Date.now(), messaging: [{ sender: { id: igsid }, recipient: { id: BUSINESS_ID }, timestamp: Date.now(), message: { mid, text } }] }],
  });

const echo = (igsid, mid, text) =>
  webhook({
    object: 'instagram',
    entry: [{ id: BUSINESS_ID, time: Date.now(), messaging: [{ sender: { id: BUSINESS_ID }, recipient: { id: igsid }, timestamp: Date.now(), message: { mid, text, is_echo: true } }] }],
  });

const comment = (igsid, commentId, text) =>
  webhook({
    object: 'instagram',
    entry: [{ id: BUSINESS_ID, time: Date.now(), changes: [{ field: 'comments', value: { id: commentId, text, from: { id: igsid, username: 'commenter' }, media: { id: 'media1' } } }] }],
  });

let rpcId = 0;
async function mcp(method, params, token = MCP_TOKEN) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
}

async function tool(name, args = {}) {
  const { body } = await mcp('tools/call', { name, arguments: args });
  const text = body.result?.content?.[0]?.text ?? '';
  let data = text;
  try { data = JSON.parse(text); } catch {}
  return { isError: !!body.result?.isError, data, text };
}

const conversation = async (igsid) => (await tool('get_conversation', { igsid })).data;
const countFrom = (convo, from) => convo.messages.filter((m) => m.from === from).length;

// --- Basics -------------------------------------------------------------------------------
check((await fetch(`${BASE}/`)).status === 200, 'health check');
check((await fetch(`${BASE}/privacy`)).status === 200, 'privacy policy page');
check((await fetch(`${BASE}/data-deletion`)).status === 200, 'data deletion page');

let res = await fetch(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=abc123`);
check(res.status === 200 && (await res.text()) === 'abc123', 'webhook verification returns challenge');
res = await fetch(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123`);
check(res.status === 403, 'webhook verification rejects wrong token');
res = await webhook({ object: 'instagram', entry: [] }, 'sha256=deadbeef');
check(res.status === 401, 'webhook rejects bad signature');

// --- MCP protocol -------------------------------------------------------------------------
check((await mcp('tools/list', {}, 'wrong-token')).status === 401, 'MCP rejects wrong token');
const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
check(init.body.result?.protocolVersion === '2025-06-18', 'MCP initialize negotiates version', init.body);
const note = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MCP_TOKEN}` },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
});
check(note.status === 202, 'MCP notification gets 202');
check((await fetch(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${MCP_TOKEN}` } })).status === 405, 'MCP GET returns 405');
const list = await mcp('tools/list', {});
const names = list.body.result?.tools?.map((t) => t.name) ?? [];
check(names.length === 8, `tools/list returns 8 tools (${names.join(', ')})`);

// --- Auto-reply ---------------------------------------------------------------------------
const alice = `alice-${run}`;
await dm(alice, `${run}-m1`, 'Hi, I need a website for my bakery');
await dm(alice, `${run}-m1`, 'Hi, I need a website for my bakery'); // Meta retry
await sleep(REPLY_WAIT_MS);
let convo = await conversation(alice);
check(countFrom(convo, 'customer') === 1, 'duplicate webhook delivery stored once', convo.messages);
check(countFrom(convo, 'auto-reply bot') === 1, 'bot replied once to first message', convo.messages);
console.log(`      bot said: "${convo.messages.at(-1)?.text}"`);
check(convo.username === `user_${alice.slice(-4)}`, 'customer profile looked up', convo.username);

// Burst of messages => one combined reply
const bob = `bob-${run}`;
await dm(bob, `${run}-b1`, 'hello');
await sleep(500);
await dm(bob, `${run}-b2`, 'how much for an online store?');
await sleep(REPLY_WAIT_MS);
convo = await conversation(bob);
check(countFrom(convo, 'auto-reply bot') === 1, 'burst of 2 messages gets 1 reply', convo.messages);

// Echo of the bot's own message is ignored
const botText = convo.messages.find((m) => m.from === 'auto-reply bot')?.text;
await echo(bob, `${run}-echo-bot`, botText);
await sleep(1500);
convo = await conversation(bob);
check(countFrom(convo, 'you (Instagram app)') === 0 && convo.bot === 'active', "bot's own echo ignored", convo);

// You replying from the Instagram app pauses the bot for that chat
await echo(bob, `${run}-echo-owner`, 'Hey Bob, this is Rahul, let me call you');
await sleep(1500);
convo = await conversation(bob);
check(countFrom(convo, 'you (Instagram app)') === 1 && convo.bot.startsWith('paused'), 'owner reply pauses bot', convo.bot);
await dm(bob, `${run}-b3`, 'sure, call me at 5');
await sleep(REPLY_WAIT_MS);
convo = await conversation(bob);
check(countFrom(convo, 'auto-reply bot') === 1, 'paused bot stays quiet', convo.messages);

let out = await tool('set_bot_status', { igsid: bob, active: true });
convo = await conversation(bob);
check(!out.isError && convo.bot === 'active', 'set_bot_status resumes one chat', out.text);

// --- Tools --------------------------------------------------------------------------------
out = await tool('send_message', { igsid: alice, text: 'Hi! Rahul here, can you share some sites you like?' });
convo = await conversation(alice);
check(!out.isError && countFrom(convo, 'you (via Muse)') === 1 && convo.bot.startsWith('paused'), 'send_message sends and pauses bot', out.text);

out = await tool('save_lead', { igsid: alice, name: 'Alice', project_type: 'bakery website', budget: '30k' });
check(!out.isError && out.data.status === 'new' && out.data.budget === '30k', 'save_lead creates lead', out.data);
out = await tool('save_lead', { igsid: alice, status: 'contacted' });
check(out.data.status === 'contacted' && out.data.budget === '30k', 'save_lead updates only given fields', out.data);
out = await tool('save_lead', { igsid: alice, status: 'bogus' });
check(out.isError, 'save_lead rejects bad status');
out = await tool('list_leads', { status: 'contacted' });
check(out.data.leads.some((l) => l.igsid === alice), 'list_leads filters by status');

out = await tool('list_conversations', { limit: 50 });
check(out.data.conversations.some((c) => c.igsid === alice && c.lead_status === 'contacted'), 'list_conversations shows lead status');

out = await tool('update_settings', { comment_keywords: 'website, price', handoff_hours: 6 });
check(!out.isError && out.data.settings.comment_keywords === 'website, price' && out.data.settings.handoff_hours === '6', 'update_settings saves');
out = await tool('update_settings', {});
check(out.isError, 'update_settings with nothing errors');
out = await tool('get_conversation', { igsid: 'nope' });
check(out.isError, 'unknown conversation errors');

// --- Comment-to-DM ------------------------------------------------------------------------
const carol = `carol-${run}`;
await comment(carol, `${run}-c1`, 'Need a WEBSITE for my gym!');
await comment(carol, `${run}-c1`, 'Need a WEBSITE for my gym!'); // retry
await comment(carol, `${run}-c2`, 'nice post');
await sleep(2000);
convo = await conversation(carol);
check(countFrom(convo, 'auto-reply bot') === 1, 'keyword comment triggers exactly one DM', convo?.messages);
out = await tool('send_message', { igsid: carol, text: 'hi' });
check(out.isError && out.text.includes('24 hours'), 'send_message blocked outside reply window', out.text);

// --- Global switch ------------------------------------------------------------------------
await tool('set_bot_status', { active: false });
const dave = `dave-${run}`;
await dm(dave, `${run}-d1`, 'hi there');
await sleep(REPLY_WAIT_MS);
convo = await conversation(dave);
check(countFrom(convo, 'auto-reply bot') === 0, 'bot off globally stays quiet', convo.messages);
await tool('set_bot_status', { active: true });
await tool('update_settings', { comment_keywords: '', handoff_hours: 12 });

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
