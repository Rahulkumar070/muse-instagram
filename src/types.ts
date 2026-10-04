export interface Env {
  DB: D1Database;
  AI: Ai;

  // Secrets
  IG_APP_SECRET: string;
  IG_ACCESS_TOKEN: string;
  WEBHOOK_VERIFY_TOKEN: string;
  MCP_TOKEN: string;

  // Vars (wrangler.jsonc)
  BUSINESS_NAME: string;
  CONTACT_EMAIL: string;
  AI_MODEL: string;
  IG_API_VERSION: string;
  DRY_RUN?: string;
}

/** Who wrote a message: the customer, the auto-reply bot, you in the Instagram app, or you via Muse. */
export type Sender = 'user' | 'bot' | 'owner' | 'muse';

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
