import type { Env, Sender } from './types';

export const DEFAULT_PROFILE = `Services: business websites, landing pages, e-commerce stores, portfolio sites, custom web apps, website redesigns, and ongoing maintenance.
Pricing: depends on scope. We give a free quote after a quick chat about the project.
Timeline: most websites take 1 to 4 weeks depending on size.
Process: free consultation, then proposal and quote, design, development, launch, and support.
Portfolio: (add your portfolio link here)
Contact: (add your WhatsApp number, email or booking link here)`;

export const DEFAULT_SETTINGS = {
  bot_enabled: 'true',
  handoff_hours: '12',
  business_profile: DEFAULT_PROFILE,
  comment_keywords: '',
  comment_dm: "Hey, thanks for the comment! Tell me a bit about the website you have in mind and I'll help you out.",
  comment_public_reply: 'Sent you a DM 📩',
};

export type Settings = Record<keyof typeof DEFAULT_SETTINGS, string>;
export type SettingKey = keyof Settings;

export async function getSettings(env: Env): Promise<Settings> {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const settings: Settings = { ...DEFAULT_SETTINGS };
  for (const row of results) {
    if (row.key in settings) settings[row.key as SettingKey] = row.value;
  }
  return settings;
}

/** Reads any settings row, including internal ones like the refreshed access token. */
export async function getRawSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
    .bind(key, value)
    .run();
}

export interface Conversation {
  igsid: string;
  username: string | null;
  name: string | null;
  last_text: string | null;
  last_message_at: number | null;
  last_user_message_at: number | null;
  paused_until: number;
  needs_human: number;
}

export async function getConversation(env: Env, igsid: string): Promise<Conversation | null> {
  return env.DB.prepare('SELECT * FROM conversations WHERE igsid = ?1').bind(igsid).first<Conversation>();
}

/** Creates the conversation if needed and records its latest message. */
export async function touchConversation(
  env: Env,
  igsid: string,
  text: string,
  at: number,
  fromCustomer: boolean,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO conversations (igsid, last_text, last_message_at, last_user_message_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(igsid) DO UPDATE SET
       last_text = excluded.last_text,
       last_message_at = excluded.last_message_at,
       last_user_message_at = COALESCE(excluded.last_user_message_at, conversations.last_user_message_at)`,
  )
    .bind(igsid, text, at, fromCustomer ? at : null)
    .run();
}

export async function updateConversation(
  env: Env,
  igsid: string,
  fields: Partial<Pick<Conversation, 'username' | 'name' | 'paused_until' | 'needs_human'>>,
): Promise<boolean> {
  const entries = Object.entries(fields);
  if (!entries.length) return false;
  const sets = entries.map(([key], i) => `${key} = ?${i + 2}`).join(', ');
  const result = await env.DB.prepare(`UPDATE conversations SET ${sets} WHERE igsid = ?1`)
    .bind(igsid, ...entries.map(([, value]) => value))
    .run();
  return result.meta.changes > 0;
}

export interface StoredMessage {
  id: number;
  igsid: string;
  sender: Sender;
  text: string;
  mid: string | null;
  created_at: number;
}

/** Inserts a message; returns null when a message with the same Instagram ID already exists. */
export async function insertMessage(
  env: Env,
  msg: { igsid: string; sender: Sender; text: string; mid?: string | null; at: number },
): Promise<number | null> {
  const result = await env.DB.prepare(
    'INSERT OR IGNORE INTO messages (igsid, sender, text, mid, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(msg.igsid, msg.sender, msg.text, msg.mid ?? null, msg.at)
    .run();
  return result.meta.changes > 0 ? result.meta.last_row_id : null;
}

/** The last `limit` messages of a conversation, oldest first. */
export async function recentMessages(env: Env, igsid: string, limit: number): Promise<StoredMessage[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM (SELECT * FROM messages WHERE igsid = ?1 ORDER BY id DESC LIMIT ?2) ORDER BY id ASC',
  )
    .bind(igsid, limit)
    .all<StoredMessage>();
  return results;
}
