import { refreshAccessToken } from './instagram';
import { handleMcp } from './mcp';
import { dataDeletionPage, privacyPage } from './pages';
import type { Env } from './types';
import { receiveWebhook, verifyWebhook } from './webhook';

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/':
        return new Response(`${env.BUSINESS_NAME} Instagram assistant is running.`);
      case '/webhook':
        if (request.method === 'GET') return verifyWebhook(url, env);
        if (request.method === 'POST') return receiveWebhook(request, env, ctx);
        return new Response('Method Not Allowed', { status: 405 });
      case '/mcp':
        return handleMcp(request, env);
      case '/privacy':
        return privacyPage(env);
      case '/data-deletion':
        return dataDeletionPage(env);
      default:
        return new Response('Not found', { status: 404 });
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(refreshAccessToken(env));
  },
} satisfies ExportedHandler<Env>;
