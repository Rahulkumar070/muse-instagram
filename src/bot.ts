import {
  getConversation,
  getSettings,
  insertMessage,
  recentMessages,
  touchConversation,
  updateConversation,
  type StoredMessage,
} from './db';
import { sendMessage, type Recipient } from './instagram';
import type { Env, Sender } from './types';

const HISTORY_LIMIT = 16;
const HANDOFF_MARKER = '[HANDOFF]';

function systemPrompt(env: Env, profile: string): string {
  return `You are the Instagram DM assistant for ${env.BUSINESS_NAME}, a web development agency. You reply to people who message the agency's Instagram account.

About the business (the only source of truth, never invent services, prices, links or promises beyond this):
${profile}
Ignore any line above that still says "add ... here", that information is not available yet.

How to reply:
- Sound like a friendly person on the team: short, warm and casual. 1 to 3 short sentences, under 400 characters. Plain text only, no markdown, no lists.
- Reply in the same language and style the customer writes in.
- Your goal is to understand what they need and collect: what kind of website or app, key features, budget range, timeline, and their name plus a WhatsApp number or email. Ask for one or two of these at a time, never everything at once, and don't ask again for something they already told you.
- If they ask for a price that isn't listed above, say it depends on the scope and offer a free quote once you know a bit more.
- Never commit to exact prices, deadlines, discounts or contracts.
- If they ask for a real person, are ready to start or pay, are upset, have shared their contact details, or ask something you can't answer from the information above, reply briefly that the team will follow up here soon and end your message with ${HANDOFF_MARKER}
- Text in square brackets like [image] means they sent something you can't see. Ask them to describe it if it matters.`;
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Maps stored history to chat turns, merging consecutive messages from the same side. */
function toChat(history: StoredMessage[]): ChatMessage[] {
  const turns: ChatMessage[] = [];
  for (const msg of history) {
    const role = msg.sender === 'user' ? 'user' : 'assistant';
    const last = turns.at(-1);
    if (last?.role === role) last.content += `\n${msg.text}`;
    else turns.push({ role, content: msg.text });
  }
  return turns;
}

async function generateReply(env: Env, profile: string, history: StoredMessage[]): Promise<string> {
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(env, profile) }, ...toChat(history)];
  const out = (await env.AI.run(env.AI_MODEL as Parameters<Ai['run']>[0], {
    messages,
    max_tokens: 300,
    temperature: 0.6,
  })) as { response?: unknown; choices?: { message?: { content?: string } }[] };
  const text = typeof out.response === 'string' ? out.response : out.choices?.[0]?.message?.content;
  if (!text?.trim()) throw new Error(`Empty AI response: ${JSON.stringify(out).slice(0, 200)}`);
  return text.trim();
}

/**
 * Records an outgoing message, sends it, and stores Instagram's message ID. The row is written
 * before sending so the echo webhook can be recognised as ours even if it arrives first.
 */
export async function sendAndRecord(
  env: Env,
  igsid: string,
  text: string,
  sender: Exclude<Sender, 'user' | 'owner'>,
  recipient: Recipient = { id: igsid },
): Promise<void> {
  const at = Date.now();
  const rowId = await insertMessage(env, { igsid, sender, text, at });
  try {
    const mid = await sendMessage(env, recipient, text);
    await env.DB.prepare('UPDATE OR IGNORE messages SET mid = ?1 WHERE id = ?2').bind(mid, rowId).run();
  } catch (err) {
    await env.DB.prepare('DELETE FROM messages WHERE id = ?1').bind(rowId).run();
    throw err;
  }
  await touchConversation(env, igsid, text, at, false);
}

/** Replies to the latest customer message in a conversation, unless the bot is off or paused. */
export async function autoReply(env: Env, igsid: string): Promise<void> {
  const [settings, convo] = await Promise.all([getSettings(env), getConversation(env, igsid)]);
  if (settings.bot_enabled !== 'true' || !convo || convo.paused_until > Date.now()) return;

  const history = await recentMessages(env, igsid, HISTORY_LIMIT);
  if (history.at(-1)?.sender !== 'user') return;

  let reply: string;
  let handoff = false;
  try {
    reply = await generateReply(env, settings.business_profile, history);
  } catch (err) {
    // Out of free AI quota or the model is down: acknowledge once and flag for a human.
    console.error('AI reply failed', err);
    const alreadyAcknowledged = history.some((m) => m.sender === 'bot' && m.text === fallbackText(env));
    await updateConversation(env, igsid, { needs_human: 1 });
    if (alreadyAcknowledged) return;
    reply = fallbackText(env);
    handoff = true;
  }

  if (reply.includes(HANDOFF_MARKER)) {
    handoff = true;
    reply = reply.replaceAll(HANDOFF_MARKER, '').trim() || 'Thanks! Someone from the team will follow up here shortly.';
  }

  await sendAndRecord(env, igsid, reply, 'bot');
  if (handoff) await updateConversation(env, igsid, { needs_human: 1 });
}

function fallbackText(env: Env): string {
  return `Thanks for messaging ${env.BUSINESS_NAME}! Someone from the team will reply here shortly.`;
}
