import { getRawSetting, setSetting } from './db';
import type { Env } from './types';

// Instagram API with Instagram Login: https://developers.facebook.com/docs/instagram-platform
const GRAPH = 'https://graph.instagram.com';

/** Instagram rejects DM text of 1000 bytes or more. */
const MAX_TEXT_BYTES = 990;

export type Recipient = { id: string } | { comment_id: string };

const isDryRun = (env: Env) => env.DRY_RUN === 'true';

/**
 * The cron job refreshes the token and stores it in D1. The stored copy is tagged with the tail of
 * the IG_ACCESS_TOKEN secret it came from, so replacing the secret takes effect immediately.
 */
export async function getAccessToken(env: Env): Promise<string> {
  const seed = env.IG_ACCESS_TOKEN.slice(-12);
  const [stored, storedSeed] = await Promise.all([
    getRawSetting(env, 'ig_access_token'),
    getRawSetting(env, 'ig_access_token_seed'),
  ]);
  return stored && storedSeed === seed ? stored : env.IG_ACCESS_TOKEN;
}

async function graph<T>(env: Env, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const token = await getAccessToken(env);
  const res = await fetch(`${GRAPH}/${env.IG_API_VERSION}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) throw new Error(`Instagram API ${res.status}: ${data.error?.message ?? JSON.stringify(data)}`);
  return data as T;
}

export function clampText(text: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= MAX_TEXT_BYTES) return text;
  let out = '';
  let bytes = 0;
  for (const char of text) {
    bytes += encoder.encode(char).length;
    if (bytes > MAX_TEXT_BYTES - 3) break;
    out += char;
  }
  return out + '...';
}

/** Sends a DM (or a private reply to a comment) and returns Instagram's message ID. */
export async function sendMessage(env: Env, recipient: Recipient, text: string): Promise<string> {
  if (isDryRun(env)) {
    console.log('[dry-run] send', JSON.stringify(recipient), text);
    return `dry-run-${crypto.randomUUID()}`;
  }
  const data = await graph<{ message_id: string }>(env, 'POST', '/me/messages', {
    recipient,
    message: { text: clampText(text) },
  });
  return data.message_id;
}

export async function replyToComment(env: Env, commentId: string, text: string): Promise<void> {
  if (isDryRun(env)) {
    console.log('[dry-run] comment reply', commentId, text);
    return;
  }
  await graph(env, 'POST', `/${commentId}/replies`, { message: text });
}

export async function getUserProfile(env: Env, igsid: string): Promise<{ username?: string; name?: string }> {
  if (isDryRun(env)) return { username: `user_${igsid.slice(-4)}` };
  return graph(env, 'GET', `/${igsid}?fields=username,name`);
}

/** Long-lived tokens last 60 days; refreshing resets the clock. Runs from the weekly cron. */
export async function refreshAccessToken(env: Env): Promise<void> {
  if (isDryRun(env)) return;
  const current = await getAccessToken(env);
  const url = `${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(current)}`;
  const res = await fetch(url);
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: { message?: string } };
  if (!res.ok || !data.access_token) {
    console.error('Instagram token refresh failed', res.status, data.error?.message);
    return;
  }
  await setSetting(env, 'ig_access_token', data.access_token);
  await setSetting(env, 'ig_access_token_seed', env.IG_ACCESS_TOKEN.slice(-12));
  await setSetting(env, 'ig_access_token_refreshed_at', new Date().toISOString());
}
