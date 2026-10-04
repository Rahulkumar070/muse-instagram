// A minimal stateless MCP server (Streamable HTTP transport, JSON responses) so Muse can use this
// worker as a custom connector. Spec: https://modelcontextprotocol.io/specification
import { sendAndRecord } from './bot';
import {
  getConversation,
  getSettings,
  recentMessages,
  setSetting,
  updateConversation,
  type Conversation,
  type SettingKey,
} from './db';
import { DAY, HOUR, type Env, type Sender } from './types';
import { safeEqual } from './webhook';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEAD_STATUSES = ['new', 'contacted', 'proposal_sent', 'won', 'lost'];

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  run(env: Env, args: Args): Promise<unknown>;
}

/** An error the caller (Muse) should see and can act on. */
class ToolError extends Error {}

function str(args: Args, key: string, required: true): string;
function str(args: Args, key: string, required?: false): string | undefined;
function str(args: Args, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') {
    if (required) throw new ToolError(`"${key}" is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new ToolError(`"${key}" must be a string.`);
  return value.trim();
}

function num(args: Args, key: string, fallback: number, min: number, max: number): number {
  const value = args[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ToolError(`"${key}" must be a number between ${min} and ${max}.`);
  }
  return value;
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

function botStatus(convo: Conversation, botEnabled: boolean): string {
  if (!botEnabled) return 'off (bot is turned off for everyone)';
  return convo.paused_until > Date.now() ? `paused until ${iso(convo.paused_until)}` : 'active';
}

function replyWindowOpen(convo: Conversation): boolean {
  return !!convo.last_user_message_at && Date.now() - convo.last_user_message_at < DAY;
}

const SENDER_LABELS: Record<Sender, string> = {
  user: 'customer',
  bot: 'auto-reply bot',
  owner: 'you (Instagram app)',
  muse: 'you (via Muse)',
};

const tools: Tool[] = [
  {
    name: 'list_conversations',
    description:
      'List recent Instagram DM conversations, newest first: who messaged, their last message, whether the auto-reply bot is active or paused for them, whether they need a human, their lead status, and whether the 24-hour reply window is still open.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'needs_human', 'paused'],
          description: 'needs_human = the bot handed these over to you. Default all.',
        },
        limit: { type: 'number', description: 'Max conversations to return (1-100, default 20).' },
      },
    },
    annotations: { readOnlyHint: true },
    async run(env, args) {
      const filter = str(args, 'filter') ?? 'all';
      const where =
        filter === 'needs_human' ? 'WHERE c.needs_human = 1' : filter === 'paused' ? 'WHERE c.paused_until > ?2' : '';
      const { results } = await env.DB.prepare(
        `SELECT c.*, l.status AS lead_status FROM conversations c
         LEFT JOIN leads l ON l.igsid = c.igsid
         ${where} ORDER BY c.last_message_at DESC LIMIT ?1`,
      )
        .bind(num(args, 'limit', 20, 1, 100), ...(filter === 'paused' ? [Date.now()] : []))
        .all<Conversation & { lead_status: string | null }>();
      const { bot_enabled } = await getSettings(env);
      return {
        conversations: results.map((c) => ({
          igsid: c.igsid,
          username: c.username || null,
          name: c.name,
          last_message: c.last_text,
          last_message_at: iso(c.last_message_at),
          reply_window_open: replyWindowOpen(c),
          bot: botStatus(c, bot_enabled === 'true'),
          needs_human: !!c.needs_human,
          lead_status: c.lead_status,
        })),
      };
    },
  },
  {
    name: 'get_conversation',
    description: 'Read the messages of one Instagram DM conversation, plus its lead details if saved.',
    inputSchema: {
      type: 'object',
      properties: {
        igsid: { type: 'string', description: 'Conversation ID from list_conversations.' },
        limit: { type: 'number', description: 'How many recent messages (1-200, default 40).' },
      },
      required: ['igsid'],
    },
    annotations: { readOnlyHint: true },
    async run(env, args) {
      const igsid = str(args, 'igsid', true);
      const convo = await getConversation(env, igsid);
      if (!convo) throw new ToolError(`No conversation with igsid ${igsid}.`);
      const [messages, lead, settings] = await Promise.all([
        recentMessages(env, igsid, num(args, 'limit', 40, 1, 200)),
        env.DB.prepare('SELECT * FROM leads WHERE igsid = ?1').bind(igsid).first(),
        getSettings(env),
      ]);
      return {
        igsid,
        username: convo.username || null,
        name: convo.name,
        bot: botStatus(convo, settings.bot_enabled === 'true'),
        needs_human: !!convo.needs_human,
        reply_window_open: replyWindowOpen(convo),
        lead,
        messages: messages.map((m) => ({ from: SENDER_LABELS[m.sender], text: m.text, at: iso(m.created_at) })),
      };
    },
  },
  {
    name: 'send_message',
    description:
      "Send an Instagram DM as the business to someone who has messaged you. Instagram only allows this within 24 hours of the customer's last message. By default the auto-reply bot pauses for this conversation so it doesn't talk over you.",
    inputSchema: {
      type: 'object',
      properties: {
        igsid: { type: 'string', description: 'Conversation ID from list_conversations.' },
        text: { type: 'string', description: 'Message text (max ~1000 characters).' },
        pause_bot: {
          type: 'boolean',
          description: 'Pause the auto-reply bot for this conversation (for handoff_hours). Default true.',
        },
      },
      required: ['igsid', 'text'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(env, args) {
      const igsid = str(args, 'igsid', true);
      const text = str(args, 'text', true);
      const convo = await getConversation(env, igsid);
      if (!convo) throw new ToolError(`No conversation with igsid ${igsid}.`);
      if (!replyWindowOpen(convo)) {
        const ago = convo.last_user_message_at
          ? `${Math.round((Date.now() - convo.last_user_message_at) / HOUR)} hours ago`
          : 'never (they only commented)';
        throw new ToolError(
          `Instagram only allows API replies within 24 hours of the customer's last message, and their last message was ${ago}. Reply from the Instagram app instead.`,
        );
      }
      await sendAndRecord(env, igsid, text, 'muse');
      if (args.pause_bot !== false) {
        const { handoff_hours } = await getSettings(env);
        await updateConversation(env, igsid, { paused_until: Date.now() + Number(handoff_hours) * HOUR });
      }
      await updateConversation(env, igsid, { needs_human: 0 });
      return `Sent to ${convo.username ? '@' + convo.username : igsid}.`;
    },
  },
  {
    name: 'set_bot_status',
    description:
      'Turn the auto-reply bot on or off. Without igsid it switches the bot for everyone; with igsid it pauses or resumes it for one conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        active: { type: 'boolean', description: 'true = bot replies, false = bot stays quiet.' },
        igsid: { type: 'string', description: 'Optional conversation ID to change only that chat.' },
        hours: { type: 'number', description: 'When pausing one chat: how long. Omit to pause until resumed.' },
      },
      required: ['active'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(env, args) {
      if (typeof args.active !== 'boolean') throw new ToolError('"active" must be true or false.');
      const igsid = str(args, 'igsid');
      if (!igsid) {
        await setSetting(env, 'bot_enabled', String(args.active));
        return args.active ? 'Auto-reply bot is ON for all chats.' : 'Auto-reply bot is OFF for all chats.';
      }
      const pausedUntil = args.active ? 0 : Date.now() + num(args, 'hours', 24 * 365 * 10, 0.1, 24 * 365 * 10) * HOUR;
      const found = await updateConversation(env, igsid, {
        paused_until: pausedUntil,
        ...(args.active ? { needs_human: 0 } : {}),
      });
      if (!found) throw new ToolError(`No conversation with igsid ${igsid}.`);
      return args.active ? 'Bot resumed for this chat.' : `Bot paused for this chat until ${iso(pausedUntil)}.`;
    },
  },
  {
    name: 'get_settings',
    description:
      "Show the bot's settings: the business info it answers from, whether it's on, how long it stays quiet after you reply yourself, and the comment-to-DM keywords and messages.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run(env) {
      return { business_name: env.BUSINESS_NAME, ai_model: env.AI_MODEL, ...(await getSettings(env)) };
    },
  },
  {
    name: 'update_settings',
    description:
      "Change what the bot knows and how it behaves. business_profile is the full text the bot answers from (services, prices, portfolio link, contact details, FAQs), so pass the complete new version, not just the change.",
    inputSchema: {
      type: 'object',
      properties: {
        business_profile: { type: 'string', description: 'Full business info the bot replies from.' },
        handoff_hours: {
          type: 'number',
          description: 'Hours the bot stays quiet in a chat after you reply yourself (0-720).',
        },
        comment_keywords: {
          type: 'string',
          description: 'Comma-separated words that trigger an automatic DM when commented, e.g. "website, price".',
        },
        comment_dm: { type: 'string', description: 'The DM sent to people who comment a keyword.' },
        comment_public_reply: {
          type: 'string',
          description: 'Public reply under their comment, e.g. "Sent you a DM". Empty string to disable.',
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(env, args) {
      const keys: SettingKey[] = ['business_profile', 'comment_keywords', 'comment_dm', 'comment_public_reply'];
      let changed = 0;
      for (const key of keys) {
        if (typeof args[key] === 'string') {
          await setSetting(env, key, (args[key] as string).trim());
          changed++;
        }
      }
      if (args.handoff_hours !== undefined) {
        await setSetting(env, 'handoff_hours', String(num(args, 'handoff_hours', 12, 0, 720)));
        changed++;
      }
      if (!changed) throw new ToolError(`Pass at least one of: ${[...keys, 'handoff_hours'].join(', ')}.`);
      return { updated: true, settings: await getSettings(env) };
    },
  },
  {
    name: 'save_lead',
    description:
      'Create or update a potential client from an Instagram conversation. Only the fields you pass are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        igsid: { type: 'string', description: 'Conversation ID from list_conversations.' },
        name: { type: 'string' },
        contact: { type: 'string', description: 'WhatsApp number, phone or email.' },
        project_type: { type: 'string', description: 'e.g. e-commerce store, landing page, web app.' },
        budget: { type: 'string' },
        timeline: { type: 'string' },
        notes: { type: 'string' },
        status: { type: 'string', enum: LEAD_STATUSES },
      },
      required: ['igsid'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(env, args) {
      const igsid = str(args, 'igsid', true);
      const status = str(args, 'status');
      if (status && !LEAD_STATUSES.includes(status)) throw new ToolError(`status must be one of ${LEAD_STATUSES}.`);
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO leads (igsid, name, contact, project_type, budget, timeline, notes, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, 'new'), ?9, ?9)
         ON CONFLICT(igsid) DO UPDATE SET
           name = COALESCE(?2, name), contact = COALESCE(?3, contact), project_type = COALESCE(?4, project_type),
           budget = COALESCE(?5, budget), timeline = COALESCE(?6, timeline), notes = COALESCE(?7, notes),
           status = COALESCE(?8, status), updated_at = ?9`,
      )
        .bind(
          igsid,
          str(args, 'name') ?? null,
          str(args, 'contact') ?? null,
          str(args, 'project_type') ?? null,
          str(args, 'budget') ?? null,
          str(args, 'timeline') ?? null,
          str(args, 'notes') ?? null,
          status ?? null,
          now,
        )
        .run();
      return env.DB.prepare('SELECT * FROM leads WHERE igsid = ?1').bind(igsid).first();
    },
  },
  {
    name: 'list_leads',
    description: 'List saved potential clients from Instagram, most recently updated first.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: LEAD_STATUSES },
        limit: { type: 'number', description: '1-200, default 50.' },
      },
    },
    annotations: { readOnlyHint: true },
    async run(env, args) {
      const status = str(args, 'status');
      const { results } = await env.DB.prepare(
        `SELECT l.*, c.username FROM leads l LEFT JOIN conversations c ON c.igsid = l.igsid
         ${status ? 'WHERE l.status = ?2' : ''} ORDER BY l.updated_at DESC LIMIT ?1`,
      )
        .bind(num(args, 'limit', 50, 1, 200), ...(status ? [status] : []))
        .all();
      return { leads: results };
    },
  },
];

type RpcMessage = { jsonrpc?: unknown; id?: string | number | null; method?: unknown; params?: Args };

const result = (id: RpcMessage['id'], value: unknown) => ({ jsonrpc: '2.0', id, result: value });
const error = (id: RpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handleRpc(env: Env, msg: RpcMessage): Promise<object | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return error(msg?.id ?? null, -32600, 'Invalid Request');
  }
  if (msg.id === undefined) return null; // notification, no response
  const params = msg.params ?? {};

  switch (msg.method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return result(msg.id, {
        protocolVersion:
          typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'insta-agent', version: '1.0.0' },
        instructions: `Controls the Instagram DM assistant for ${env.BUSINESS_NAME}. An auto-reply bot answers new DMs on its own around the clock and hands chats over (needs_human) when a person should step in. Use list_conversations and get_conversation to see what's happening, send_message to reply as the business, save_lead to track potential clients, and update_settings to change what the bot knows.`,
      });
    }
    case 'ping':
      return result(msg.id, {});
    case 'tools/list':
      return result(msg.id, {
        tools: tools.map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          annotations,
        })),
      });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return error(msg.id, -32602, `Unknown tool: ${String(params.name)}`);
      try {
        const out = await tool.run(env, (params.arguments as Args) ?? {});
        return result(msg.id, {
          content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }],
        });
      } catch (err) {
        if (!(err instanceof ToolError)) console.error(`Tool ${tool.name} failed`, err);
        const message = err instanceof Error ? err.message : String(err);
        return result(msg.id, { content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      return error(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

function authorized(request: Request, env: Env): boolean {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : request.headers.get('x-api-key');
  return !!token && !!env.MCP_TOKEN && safeEqual(token, env.MCP_TOKEN);
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  // Stateless server: no SSE stream (GET) and no sessions to end (DELETE).
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(error(null, -32700, 'Parse error'), 400);
  }
  const batch = Array.isArray(payload);
  const responses: object[] = [];
  for (const msg of batch ? (payload as RpcMessage[]) : [payload as RpcMessage]) {
    const response = await handleRpc(env, msg);
    if (response) responses.push(response);
  }
  if (!responses.length) return new Response(null, { status: 202 });
  return json(batch ? responses : responses[0]);
}
