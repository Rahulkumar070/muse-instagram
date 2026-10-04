import type { Env } from './types';

// Meta requires a privacy policy URL and data deletion instructions before an app can go Live.

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 680px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; background: #fff; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.1rem; margin-top: 1.6em; }
</style>
</head>
<body>${body}</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export function privacyPage(env: Env): Response {
  const name = escape(env.BUSINESS_NAME);
  const email = escape(env.CONTACT_EMAIL);
  return page(
    `Privacy Policy | ${env.BUSINESS_NAME}`,
    `<h1>Privacy Policy</h1>
<p>This policy explains how ${name} handles information when you message our Instagram account.</p>
<h2>What we collect</h2>
<p>When you send us a direct message or comment on our posts, we receive your Instagram username, your name if it is public, and the content of your messages. If you choose to share contact details or project information, we store those too.</p>
<h2>How we use it</h2>
<p>We use this information only to reply to you, answer questions about our web development services, and prepare quotes. Replies may be drafted automatically by an AI assistant and reviewed by our team.</p>
<h2>Sharing</h2>
<p>We do not sell your information. It is stored with our hosting provider (Cloudflare) and processed by Meta as part of Instagram messaging.</p>
<h2>Retention and deletion</h2>
<p>We keep conversation history only as long as needed to work with you. You can ask us to delete your data at any time, see <a href="/data-deletion">data deletion</a>.</p>
<h2>Contact</h2>
<p>${name}: <a href="mailto:${email}">${email}</a></p>`,
  );
}

export function dataDeletionPage(env: Env): Response {
  const email = escape(env.CONTACT_EMAIL);
  return page(
    `Data Deletion | ${env.BUSINESS_NAME}`,
    `<h1>Delete your data</h1>
<p>To delete the messages and details ${escape(env.BUSINESS_NAME)} holds about you, send us a DM on Instagram saying "delete my data", or email <a href="mailto:${email}">${email}</a> with your Instagram username.</p>
<p>We will delete your conversation history and any saved contact or project details within 30 days and confirm once it's done.</p>`,
  );
}
