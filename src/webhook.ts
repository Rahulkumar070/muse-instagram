import { autoReply, sendAndRecord } from './bot';
import { getSettings, insertMessage, touchConversation, updateConversation } from './db';
import { getUserProfile, replyToComment } from './instagram';
import { HOUR, type Env } from './types';

/** Wait this long after a DM before replying, so a burst of messages gets one combined answer. */
const DEBOUNCE_MS = 4000;

interface MessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    is_self?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    attachments?: { type?: string }[];
    reply_to?: { story?: unknown };
  };
}

interface CommentValue {
  id?: string;
  comment_id?: string;
  text?: string;
  from?: { id?: string; username?: string };
}

interface WebhookBody {
  object?: string;
  entry?: {
    id?: string;
    messaging?: MessagingEvent[];
    changes?: { field?: string; value?: unknown }[];
  }[];
}

/** Meta calls this once with a challenge when you save the webhook URL. */
export function verifyWebhook(url: URL, env: Env): Response {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  if (mode === 'subscribe' && token && safeEqual(token, env.WEBHOOK_VERIFY_TOKEN)) {
    return new Response(url.searchParams.get('hub.challenge') ?? '');
  }
  return new Response('Forbidden', { status: 403 });
}

export async function receiveWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await request.text();
  if (!(await validSignature(raw, request.headers.get('x-hub-signature-256'), env.IG_APP_SECRET))) {
    return new Response('Invalid signature', { status: 401 });
  }
  let body: WebhookBody;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }
  // Answer Meta right away; replying (AI + send) continues in the background.
  ctx.waitUntil(processWebhook(env, body).catch((err) => console.error('Webhook processing failed', err)));
  return new Response('EVENT_RECEIVED');
}

async function processWebhook(env: Env, body: WebhookBody): Promise<void> {
  if (body.object !== 'instagram') return;

  // Latest new customer message ID per conversation in this delivery.
  const pending = new Map<string, string>();

  for (const entry of body.entry ?? []) {
    const businessId = String(entry.id ?? '');
    const events = [
      ...(entry.messaging ?? []),
      ...(entry.changes ?? []).filter((c) => c.field === 'messages').map((c) => c.value as MessagingEvent),
    ];
    for (const event of events) {
      const fresh = await recordMessagingEvent(env, event, businessId);
      if (fresh) pending.set(fresh.igsid, fresh.mid);
    }
    for (const change of entry.changes ?? []) {
      if (change.field === 'comments') await handleComment(env, change.value as CommentValue, businessId);
    }
  }

  if (!pending.size) return;
  await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS));
  for (const [igsid, mid] of pending) {
    // If the customer sent more messages since, the webhook for the newest one replies instead.
    const latest = await env.DB.prepare(
      "SELECT mid FROM messages WHERE igsid = ?1 AND sender = 'user' ORDER BY id DESC LIMIT 1",
    )
      .bind(igsid)
      .first<{ mid: string }>();
    if (latest?.mid !== mid) continue;
    try {
      await autoReply(env, igsid);
    } catch (err) {
      console.error('Auto-reply failed for', igsid, err);
    }
  }
}

function describeMessage(message: NonNullable<MessagingEvent['message']>): string {
  const parts: string[] = [];
  if (message.reply_to?.story) parts.push('[replied to your story]');
  for (const attachment of message.attachments ?? []) parts.push(`[${attachment.type ?? 'attachment'}]`);
  if (message.text) parts.push(message.text);
  return parts.join(' ') || '[message]';
}

/** Stores a DM event. Returns the conversation to reply to when it is a new customer message. */
async function recordMessagingEvent(
  env: Env,
  event: MessagingEvent,
  businessId: string,
): Promise<{ igsid: string; mid: string } | null> {
  const message = event.message;
  if (!message?.mid || message.is_self || message.is_deleted || message.is_unsupported) return null;
  const text = describeMessage(message);
  const now = Date.now();

  if (message.is_echo) {
    await recordEcho(env, event.recipient?.id, message.mid, text, now);
    return null;
  }

  const igsid = event.sender?.id;
  if (!igsid || igsid === businessId) return null;
  if ((await insertMessage(env, { igsid, sender: 'user', text, mid: message.mid, at: now })) === null) {
    return null; // Meta retried a delivery we already handled
  }
  await touchConversation(env, igsid, text, now, true);
  await fillProfile(env, igsid);
  return { igsid, mid: message.mid };
}

/**
 * Instagram echoes every message sent from the business account. Echoes of the bot's own messages
 * are ignored; anything else means you replied from the Instagram app, so the bot steps back.
 */
async function recordEcho(env: Env, igsid: string | undefined, mid: string, text: string, now: number) {
  if (!igsid) return;
  const ours = await env.DB.prepare(
    `SELECT id FROM messages WHERE igsid = ?1 AND sender IN ('bot', 'muse')
       AND (mid = ?2 OR (text = ?3 AND created_at > ?4)) LIMIT 1`,
  )
    .bind(igsid, mid, text, now - 5 * 60 * 1000)
    .first();
  if (ours) return;
  if ((await insertMessage(env, { igsid, sender: 'owner', text, mid, at: now })) === null) return;

  const { handoff_hours } = await getSettings(env);
  await touchConversation(env, igsid, text, now, false);
  await updateConversation(env, igsid, { paused_until: now + Number(handoff_hours) * HOUR, needs_human: 0 });
}

async function fillProfile(env: Env, igsid: string): Promise<void> {
  const row = await env.DB.prepare('SELECT username FROM conversations WHERE igsid = ?1').bind(igsid).first<{
    username: string | null;
  }>();
  if (row?.username !== null) return;
  try {
    const profile = await getUserProfile(env, igsid);
    await updateConversation(env, igsid, { username: profile.username ?? '', name: profile.name ?? null });
  } catch (err) {
    console.error('Profile lookup failed for', igsid, err);
    await updateConversation(env, igsid, { username: '' }); // don't retry on every message
  }
}

/**
 * Comment-to-DM: when someone comments one of your keywords, send them one private DM (the only
 * way Instagram allows you to message someone first) and optionally reply publicly.
 */
async function handleComment(env: Env, value: CommentValue, businessId: string): Promise<void> {
  const commentId = value.id ?? value.comment_id;
  const igsid = value.from?.id;
  if (!commentId || !igsid || igsid === businessId) return;

  const settings = await getSettings(env);
  const keywords = settings.comment_keywords
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  const text = (value.text ?? '').toLowerCase();
  if (settings.bot_enabled !== 'true' || !keywords.some((k) => text.includes(k))) return;

  const claimed = await env.DB.prepare(
    'INSERT OR IGNORE INTO comment_replies (comment_id, igsid, created_at) VALUES (?1, ?2, ?3)',
  )
    .bind(commentId, igsid, Date.now())
    .run();
  if (!claimed.meta.changes) return;

  await touchConversation(env, igsid, `[commented] ${value.text ?? ''}`, Date.now(), false);
  if (value.from?.username) await updateConversation(env, igsid, { username: value.from.username });
  await sendAndRecord(env, igsid, settings.comment_dm, 'bot', { comment_id: commentId });
  if (settings.comment_public_reply.trim()) {
    await replyToComment(env, commentId, settings.comment_public_reply).catch((err) =>
      console.error('Public comment reply failed', err),
    );
  }
}

async function validSignature(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return safeEqual(header.slice('sha256='.length), expected);
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
