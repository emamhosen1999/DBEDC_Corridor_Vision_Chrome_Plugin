/**
 * Chat webhooks (Slack, Teams, Discord) and a generic signed JSON webhook.
 *
 * The generic webhook is the escape hatch: it lets the site wire Corridor Vision into
 * whatever it already runs — n8n, Make, a ticketing system, an SMS gateway, a
 * building management system — without any code change here.
 */
import crypto from 'node:crypto';
import { postJson, request, ChannelError, chunk, required } from './http.mjs';
import { resolveRefs } from '../../core/secrets.mjs';

const ICON = { info: ':information_source:', warning: ':warning:', critical: ':rotating_light:' };
const COLOUR = { info: '#2e9e4f', warning: '#d98324', critical: '#d93636' };

export const slack = {
  name: 'slack',
  describe: () => 'Slack incoming webhook',
  validate(raw) {
    const c = resolveRefs(raw);
    return c.webhookUrl ? [] : ['webhookUrl is required (Slack → Apps → Incoming Webhooks)'];
  },
  async send(msg, raw) {
    const c = resolveRefs(raw);
    const url = required(c.webhookUrl, 'webhookUrl', 'slack');
    await postJson(url, {
      text: `${ICON[msg.severity] ?? ''} ${msg.title}`,
      attachments: [{ color: COLOUR[msg.severity] ?? '#888', text: msg.text, mrkdwn_in: ['text'] }],
    });
    return { target: 'slack' };
  },
};

export const teams = {
  name: 'teams',
  describe: () => 'Microsoft Teams incoming webhook',
  validate(raw) {
    const c = resolveRefs(raw);
    return c.webhookUrl ? [] : ['webhookUrl is required (Teams channel → Connectors → Incoming Webhook)'];
  },
  async send(msg, raw) {
    const c = resolveRefs(raw);
    const url = required(c.webhookUrl, 'webhookUrl', 'teams');
    await postJson(url, {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      themeColor: (COLOUR[msg.severity] ?? '#888888').replace('#', ''),
      summary: msg.title,
      title: msg.title,
      text: msg.text.replace(/\n/g, '\n\n'),   // Teams collapses single newlines
    });
    return { target: 'teams' };
  },
};

export const discord = {
  name: 'discord',
  describe: () => 'Discord webhook',
  validate(raw) {
    const c = resolveRefs(raw);
    return c.webhookUrl ? [] : ['webhookUrl is required (Channel → Integrations → Webhooks)'];
  },
  async send(msg, raw) {
    const c = resolveRefs(raw);
    const url = required(c.webhookUrl, 'webhookUrl', 'discord');
    for (const part of chunk(msg.text, 1900)) {
      await postJson(url, { content: `**${msg.title}**\n\`\`\`\n${part}\n\`\`\`` });
      await new Promise((r) => setTimeout(r, 400));
    }
    return { target: 'discord' };
  },
};

/**
 * Generic JSON webhook with optional HMAC-SHA256 signing.
 *
 * The signature lets the receiving system verify the payload really came from this
 * monitor — worth having if the webhook triggers anything consequential, like
 * dispatching a field team.
 */
export const webhook = {
  name: 'webhook',
  describe: () => 'Generic JSON webhook (HMAC-signed) — wire into n8n, Make, a ticketing system, an SMS gateway',
  validate(raw) {
    const c = resolveRefs(raw);
    const problems = [];
    if (!c.url) problems.push('url is required');
    else if (!/^https?:\/\//i.test(c.url)) problems.push(`url "${c.url}" must start with http:// or https://`);
    return problems;
  },
  async send(msg, raw) {
    const c = resolveRefs(raw);
    const url = required(c.url, 'url', 'webhook');
    const body = JSON.stringify({
      source: 'corridor-vision',
      version: 2,
      sentAt: new Date().toISOString(),
      severity: msg.severity,
      type: msg.alertType,
      title: msg.title,
      text: msg.text,
      data: msg.payload?.alert ?? null,
      site: msg.payload?.site ?? null,
    });
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'CorridorVision/2.0', ...(c.headers ?? {}) };
    if (c.secret) {
      const ts = String(Date.now());
      headers['X-Corridor-Timestamp'] = ts;
      // Sign timestamp+body so a captured payload cannot be replayed later.
      headers['X-Corridor-Signature'] = 'sha256=' + crypto.createHmac('sha256', c.secret).update(`${ts}.${body}`).digest('hex');
    }
    const res = await request(url, { method: c.method || 'POST', headers, body, timeoutMs: 15_000 });
    return { target: url, status: res.status };
  },
};

export { ChannelError };
