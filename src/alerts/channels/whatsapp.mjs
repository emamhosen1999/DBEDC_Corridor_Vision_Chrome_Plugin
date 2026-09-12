/**
 * WhatsApp — five delivery routes, because there is no single good one.
 *
 * The honest state of WhatsApp group messaging, which decides the design:
 *
 *  - Meta's official Cloud API supports groups, capped at EIGHT participants and
 *    requiring an Official Business Account. With an OBA and a group that fits inside
 *    eight, this is the RECOMMENDED route: official, supported, nothing to keep
 *    linked. Its one trap is the 24-hour messaging window — see the section below.
 *  - GREEN API and WAHA both link a normal WhatsApp number by QR and address a real
 *    group by its chatId (`<id>@g.us`) with no participant cap. These are the two
 *    routes that actually work for an ops group.
 *  - CallMeBot is free and requires no account at all, but sends only to individual
 *    numbers that have opted in, and its free tier is for personal use.
 *  - whatsapp-web.js drives WhatsApp Web locally: no server, no account, full group
 *    support. It is an OPTIONAL dependency because it pulls in a browser, and it is
 *    unofficial — see the note on its `send` below.
 *
 * Every route takes the same rendered text, so switching route changes one config
 * field and nothing else.
 */
import { postJson, request, ChannelError, chunk, required } from './http.mjs';
import { resolveRefs } from '../../core/secrets.mjs';
import { log } from '../../core/logger.mjs';

const logger = log('whatsapp');
const WA_LIMIT = 4000;   // WhatsApp's practical text limit is 65k, but long messages read badly on a phone

const isGroup = (chatId) => String(chatId).endsWith('@g.us');

/* ------------------------------------------------------------ GREEN API --- */
/**
 * GREEN API — hosted gateway, your own WhatsApp number linked by QR.
 * POST {apiUrl}/waInstance{idInstance}/sendMessage/{apiToken}  { chatId, message }
 * Group chatIds look like `8801XXXXXXXXX-1581234048@g.us` and are returned by the
 * API — never hand-assembled.
 */
export const whatsappGreen = {
  name: 'whatsappGreen',
  describe: () => 'WhatsApp via GREEN API (hosted gateway — supports real groups)',

  validate(raw) {
    const c = resolveRefs(raw);
    const problems = [];
    if (!c.idInstance) problems.push('idInstance is required (from your GREEN API console)');
    if (!c.apiToken) problems.push('apiToken is required — store it with: npm run start -- secret set whatsappGreen.apiToken');
    if (!c.chatId) problems.push('chatId is required, e.g. 8801XXXXXXXXX-1581234048@g.us for a group');
    else if (!/@[cg]\.us$/.test(c.chatId)) problems.push(`chatId "${c.chatId}" must end in @g.us (group) or @c.us (individual)`);
    return problems;
  },

  async send(msg, raw) {
    const c = resolveRefs(raw);
    const apiUrl = (c.apiUrl || 'https://api.green-api.com').replace(/\/+$/, '');
    const idInstance = required(c.idInstance, 'idInstance', 'whatsappGreen');
    const apiToken = required(c.apiToken, 'apiToken', 'whatsappGreen');
    const chatId = required(c.chatId, 'chatId', 'whatsappGreen');

    const url = `${apiUrl}/waInstance${idInstance}/sendMessage/${apiToken}`;
    const ids = [];
    for (const part of chunk(msg.text, WA_LIMIT)) {
      const res = await postJson(url, { chatId, message: part });
      if (!res.body?.idMessage) {
        throw new ChannelError(`GREEN API did not return a message id: ${JSON.stringify(res.body).slice(0, 200)}`);
      }
      ids.push(res.body.idMessage);
      // The free tier throttles to roughly one message a second.
      if (ids.length) await new Promise((r) => setTimeout(r, 1100));
    }
    return { messageIds: ids, target: chatId, group: isGroup(chatId) };
  },
};

/* ------------------------------------------------------------------ WAHA --- */
/**
 * WAHA — self-hosted WhatsApp HTTP API (Docker). Data never leaves your network.
 * POST {baseUrl}/api/sendText  { session, chatId, text }, auth via X-Api-Key.
 */
export const whatsappWaha = {
  name: 'whatsappWaha',
  describe: () => 'WhatsApp via WAHA (self-hosted — supports real groups, no third party)',

  validate(raw) {
    const c = resolveRefs(raw);
    const problems = [];
    if (!c.baseUrl) problems.push('baseUrl is required, e.g. http://127.0.0.1:3000');
    if (!c.chatId) problems.push('chatId is required, e.g. 8801XXXXXXXXX-1581234048@g.us for a group');
    else if (!/@[cg]\.us$/.test(c.chatId)) problems.push(`chatId "${c.chatId}" must end in @g.us (group) or @c.us (individual)`);
    return problems;
  },

  /** Is the linked WhatsApp session actually connected? Surfaced by the doctor command. */
  async health(raw) {
    const c = resolveRefs(raw);
    const base = (c.baseUrl || '').replace(/\/+$/, '');
    const res = await request(`${base}/api/sessions/${encodeURIComponent(c.session || 'default')}`, {
      headers: c.apiKey ? { 'X-Api-Key': c.apiKey } : {},
      timeoutMs: 8000,
    });
    const status = res.body?.status ?? 'unknown';
    return {
      ok: status === 'WORKING',
      status,
      detail: status === 'WORKING' ? 'session linked and ready'
        : status === 'SCAN_QR_CODE' ? 'WAHA is waiting for a QR scan — open the WAHA dashboard and link the phone'
        : `session state is ${status}`,
    };
  },

  async send(msg, raw) {
    const c = resolveRefs(raw);
    const base = required(c.baseUrl, 'baseUrl', 'whatsappWaha').replace(/\/+$/, '');
    const chatId = required(c.chatId, 'chatId', 'whatsappWaha');
    const headers = c.apiKey ? { 'X-Api-Key': c.apiKey } : {};
    const ids = [];
    for (const part of chunk(msg.text, WA_LIMIT)) {
      const res = await postJson(`${base}/api/sendText`, {
        session: c.session || 'default', chatId, text: part,
      }, { headers });
      ids.push(res.body?.id?._serialized ?? res.body?.id ?? 'sent');
      await new Promise((r) => setTimeout(r, 400));
    }
    return { messageIds: ids, target: chatId, group: isGroup(chatId) };
  },
};

/* ------------------------------------------------------- Meta Cloud API --- */
/**
 * Official WhatsApp Business Cloud API — the recommended route when you hold an
 * Official Business Account.
 *
 * Groups: `recipient_type: "group"` with a group id addresses a real group. Meta caps
 * these at EIGHT participants, which is fine for a duty roster and not fine for a
 * whole department — size the group accordingly before relying on it.
 *
 * THE 24-HOUR WINDOW IS THE THING THAT WILL BITE YOU.
 * Meta only delivers free-form text inside a 24-hour "customer service window" opened
 * by someone messaging the business number. A monitoring system raises its most
 * important alarms at 03:00, long after the window has lapsed — and Meta rejects those
 * with error 131047/131026 rather than delivering them. A monitor whose alerts are
 * silently refused overnight is worse than no monitor.
 *
 * The fix, and the reason `template` config exists: approved MESSAGE TEMPLATES are
 * delivered at any time, window or not. This channel sends free-form text, and on a
 * window error automatically re-sends the same alert as a template. Configure a
 * template and the 3am alarm arrives; skip it and it will not.
 *
 * Create one in WhatsApp Manager → Message templates, category UTILITY, with a body of
 * exactly one variable, e.g.:
 *     "Corridor Vision alert:\n\n{{1}}"
 * then set channels.whatsappCloud.template.name to its name.
 */

/** Meta error codes that mean "outside the 24-hour window — use a template". */
const WINDOW_ERROR_CODES = new Set([131047, 131026, 131051, 470]);

function windowErrorFrom(err) {
  const text = String(err?.message ?? '');
  const code = Number(/"code"\s*:\s*(\d+)/.exec(text)?.[1]);
  if (WINDOW_ERROR_CODES.has(code)) return code;
  // Meta's prose varies by API version; match the phrasing too.
  if (/re-?engagement|outside the (24|twenty-four)|message window|24 hour/i.test(text)) return 0;
  return null;
}

async function cloudSend(cfg, payload) {
  const version = cfg.apiVersion || 'v21.0';
  return postJson(
    `https://graph.facebook.com/${version}/${cfg.phoneNumberId}/messages`,
    payload,
    { headers: { Authorization: `Bearer ${cfg.accessToken}` } },
  );
}

export const whatsappCloud = {
  name: 'whatsappCloud',
  describe: () => 'WhatsApp via Meta Cloud API (official; groups supported, capped at 8 participants)',

  validate(raw) {
    const c = resolveRefs(raw);
    const problems = [];
    if (!c.phoneNumberId) problems.push('phoneNumberId is required (Meta App → WhatsApp → API Setup)');
    if (!c.accessToken) problems.push('accessToken is required — store it with: node src/cli.mjs secret set whatsappCloud.accessToken <token>');
    if (!c.to) {
      problems.push(c.recipientType === 'group'
        ? 'to is required — the group id. List your groups with: node src/cli.mjs wa-groups'
        : 'to is required — a phone number in international format, digits only, no +');
    } else if (c.recipientType !== 'group' && !/^\d{8,15}$/.test(String(c.to))) {
      problems.push(`to "${c.to}" should be digits only in international format, e.g. 8801712345678`);
    }
    if (c.recipientType === 'group') {
      problems.push('NOTE: Cloud API groups are capped at 8 participants — keep the group to a duty roster, not a whole department');
    }
    if (!c.template?.name) {
      problems.push(
        'NOTE: no template configured. Meta refuses free-form text outside the 24-hour customer '
        + 'service window, so alarms raised overnight will NOT be delivered. Configure '
        + 'template.name with an approved UTILITY template whose body is a single {{1}} variable.',
      );
    }
    return problems;
  },

  /** Confirm the token and number are live. Surfaced by `doctor`. */
  async health(raw) {
    const c = resolveRefs(raw);
    const version = c.apiVersion || 'v21.0';
    const res = await request(
      `https://graph.facebook.com/${version}/${c.phoneNumberId}?fields=verified_name,quality_rating,display_phone_number`,
      { headers: { Authorization: `Bearer ${c.accessToken}` }, timeoutMs: 10_000 },
    );
    const b = res.body ?? {};
    return {
      ok: !!b.display_phone_number,
      status: b.quality_rating ?? 'unknown',
      detail: b.display_phone_number
        ? `${b.verified_name ?? 'number'} ${b.display_phone_number} · quality ${b.quality_rating ?? 'n/a'}`
        : 'the API did not return this number — check phoneNumberId and the access token',
    };
  },

  /** List the groups this business number can post to. Used by `wa-groups`. */
  async listGroups(raw) {
    const c = resolveRefs(raw);
    const version = c.apiVersion || 'v21.0';
    const res = await request(
      `https://graph.facebook.com/${version}/${c.phoneNumberId}/groups`,
      { headers: { Authorization: `Bearer ${c.accessToken}` }, timeoutMs: 15_000 },
    );
    return res.body?.data ?? [];
  },

  async send(msg, raw) {
    const c = resolveRefs(raw);
    const cfg = {
      apiVersion: c.apiVersion || 'v21.0',
      phoneNumberId: required(c.phoneNumberId, 'phoneNumberId', 'whatsappCloud'),
      accessToken: required(c.accessToken, 'accessToken', 'whatsappCloud'),
    };
    const to = required(c.to, 'to', 'whatsappCloud');
    const recipientType = c.recipientType === 'group' ? 'group' : 'individual';

    const ids = [];
    let usedTemplate = false;

    for (const part of chunk(msg.text, WA_LIMIT)) {
      try {
        const res = await cloudSend(cfg, {
          messaging_product: 'whatsapp',
          recipient_type: recipientType,
          to,
          type: 'text',
          text: { preview_url: false, body: part },
        });
        ids.push(res.body?.messages?.[0]?.id ?? 'sent');
      } catch (err) {
        const windowCode = windowErrorFrom(err);
        if (windowCode === null || !c.template?.name) {
          // Not a window problem, or no template to fall back to — surface it as-is,
          // including the actionable hint, rather than pretending the alert was sent.
          if (windowCode !== null) {
            throw new ChannelError(
              `${err.message}\n\nThis is Meta's 24-hour customer service window: free-form text is only `
              + 'delivered within 24 hours of someone messaging the business number. Configure '
              + 'channels.whatsappCloud.template.name with an approved UTILITY template so alarms '
              + 'raised overnight still arrive.',
              { permanent: false },
            );
          }
          throw err;
        }
        // Outside the window: re-send this part as an approved template.
        const res = await cloudSend(cfg, {
          messaging_product: 'whatsapp',
          recipient_type: recipientType,
          to,
          type: 'template',
          template: {
            name: c.template.name,
            language: { code: c.template.languageCode || 'en' },
            components: [{ type: 'body', parameters: [{ type: 'text', text: part.slice(0, 1024) }] }],
          },
        });
        ids.push(res.body?.messages?.[0]?.id ?? 'sent-as-template');
        usedTemplate = true;
      }
    }
    return { messageIds: ids, target: to, group: recipientType === 'group', viaTemplate: usedTemplate };
  },
};

/* ------------------------------------------------------------ CallMeBot --- */
/**
 * CallMeBot — free, no account, individual numbers only.
 * The recipient first messages the bot to opt in and receives an API key.
 */
export const whatsappCallmebot = {
  name: 'whatsappCallmebot',
  describe: () => 'WhatsApp via CallMeBot (free, individual numbers only — not groups)',

  validate(raw) {
    const c = resolveRefs(raw);
    const problems = [];
    if (!c.phone) problems.push('phone is required, including country code, e.g. +8801XXXXXXXXX');
    if (!c.apiKey) problems.push('apiKey is required — message the CallMeBot number from that phone to obtain one');
    return problems;
  },

  async send(msg, raw) {
    const c = resolveRefs(raw);
    const phone = required(c.phone, 'phone', 'whatsappCallmebot').replace(/[^\d+]/g, '');
    const apiKey = required(c.apiKey, 'apiKey', 'whatsappCallmebot');
    // CallMeBot takes the message in the query string, so keep parts short.
    const parts = chunk(msg.text, 900);
    for (const part of parts) {
      const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}`
        + `&text=${encodeURIComponent(part)}&apikey=${encodeURIComponent(apiKey)}`;
      await request(url, { timeoutMs: 20_000 });
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { parts: parts.length, target: phone };
  },
};

/* --------------------------------------------------------- WhatsApp Web --- */
/**
 * whatsapp-web.js — drives WhatsApp Web locally. No server, no business account,
 * full group support, and the only zero-infrastructure route to a real group.
 *
 * Stated plainly rather than buried: this is an UNOFFICIAL route. It automates the
 * WhatsApp Web client with your own account, which WhatsApp's terms do not sanction.
 * For an internal operations group on a company number the practical risk is low, but
 * it is not zero, and WhatsApp can change the web client at any time and break it.
 * That is exactly why it is an optional dependency and why GREEN API or WAHA are the
 * recommended routes: if this one breaks, nothing else in the system does.
 *
 * Enable with:  npm install whatsapp-web.js qrcode-terminal
 * Then run:     npm run start -- wa-login      (scan the QR once; the session persists)
 */
let waClient = null;
let waReady = false;
let waStarting = null;

export const whatsappWeb = {
  name: 'whatsappWeb',
  describe: () => 'WhatsApp via WhatsApp Web automation (no server; unofficial)',

  validate(raw) {
    const c = resolveRefs(raw);
    const problems = [];
    if (!c.groupName && !c.chatId) problems.push('set groupName (the exact group title) or chatId');
    return problems;
  },

  isReady: () => waReady,

  /** Start the client, optionally printing a QR for the first link. */
  async start(raw, { onQr } = {}) {
    if (waReady) return { ok: true, already: true };
    if (waStarting) return waStarting;

    const c = resolveRefs(raw);
    waStarting = (async () => {
      let mod;
      try {
        mod = await import('whatsapp-web.js');
      } catch {
        throw new ChannelError(
          'The whatsappWeb channel needs an optional dependency that is not installed.\n'
          + 'Run:  npm install whatsapp-web.js qrcode-terminal\n'
          + 'Or use the whatsappGreen / whatsappWaha channel instead, which needs no browser.',
          { permanent: true },
        );
      }
      const { Client, LocalAuth } = mod.default ?? mod;
      waClient = new Client({
        authStrategy: new LocalAuth({ dataPath: c.sessionDir || undefined, clientId: 'corridor-vision' }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      });
      waClient.on('qr', (qr) => {
        logger.warn('WhatsApp Web needs to be linked — scan the QR code');
        onQr?.(qr);
      });
      waClient.on('ready', () => { waReady = true; logger.info('WhatsApp Web client ready'); });
      waClient.on('disconnected', (reason) => { waReady = false; logger.error('WhatsApp Web disconnected', { reason }); });
      waClient.on('auth_failure', (m) => { waReady = false; logger.error('WhatsApp Web auth failure', { detail: m }); });
      await waClient.initialize();
      return { ok: true };
    })().finally(() => { waStarting = null; });

    return waStarting;
  },

  /** Resolve a group title to its chatId, so operators configure a name, not an id. */
  async resolveGroupId(groupName) {
    if (!waClient || !waReady) throw new ChannelError('WhatsApp Web is not linked yet', { permanent: false });
    const chats = await waClient.getChats();
    const match = chats.find((ch) => ch.isGroup && ch.name?.trim() === String(groupName).trim());
    if (!match) {
      const available = chats.filter((ch) => ch.isGroup).map((ch) => ch.name).slice(0, 20);
      throw new ChannelError(
        `No WhatsApp group named "${groupName}". Groups visible to this account: ${available.join(', ') || '(none)'}`,
        { permanent: true },
      );
    }
    return match.id._serialized;
  },

  async send(msg, raw) {
    const c = resolveRefs(raw);
    if (!waReady) {
      await whatsappWeb.start(raw);
      // Give the browser a moment to reach `ready` before declaring failure.
      for (let i = 0; i < 30 && !waReady; i++) await new Promise((r) => setTimeout(r, 1000));
      if (!waReady) throw new ChannelError('WhatsApp Web is not linked. Run: npm run start -- wa-login', { permanent: false });
    }
    const chatId = c.chatId || await whatsappWeb.resolveGroupId(c.groupName);
    for (const part of chunk(msg.text, WA_LIMIT)) {
      await waClient.sendMessage(chatId, part);
      await new Promise((r) => setTimeout(r, 600));
    }
    return { target: chatId, group: isGroup(chatId) };
  },

  async stop() {
    if (waClient) { try { await waClient.destroy(); } catch { /* already gone */ } }
    waClient = null; waReady = false;
  },
};
