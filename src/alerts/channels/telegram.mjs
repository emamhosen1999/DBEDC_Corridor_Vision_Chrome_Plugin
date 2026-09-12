/**
 * Telegram Bot API.
 *
 * Worth enabling even when WhatsApp is the primary channel: groups are free and
 * first-class, there is no session to link and nothing to keep alive, and the API has
 * not broken in a decade. When WhatsApp inevitably has a bad week, this is the route
 * that still delivers.
 */
import { postJson, ChannelError, chunk, required } from './http.mjs';
import { resolveRefs } from '../../core/secrets.mjs';

const TG_LIMIT = 4000;   // hard API limit is 4096

export const telegram = {
  name: 'telegram',
  describe: () => 'Telegram bot (groups, topics and channels — free and very reliable)',

  validate(raw) {
    const c = resolveRefs(raw);
    const problems = [];
    if (!c.botToken) problems.push('botToken is required — create a bot with @BotFather');
    else if (!/^\d+:[\w-]{30,}$/.test(c.botToken)) problems.push('botToken does not look like a BotFather token (123456:ABC-DEF…)');
    if (!c.chatId) problems.push('chatId is required — add the bot to the group, then read the id from getUpdates (group ids are negative, e.g. -1001234567890)');
    return problems;
  },

  async health(raw) {
    const c = resolveRefs(raw);
    const res = await postJson(`https://api.telegram.org/bot${c.botToken}/getMe`, {});
    return { ok: !!res.body?.ok, detail: res.body?.result?.username ? `bot @${res.body.result.username}` : 'unexpected response' };
  },

  async send(msg, raw) {
    const c = resolveRefs(raw);
    const token = required(c.botToken, 'botToken', 'telegram');
    const chatId = required(c.chatId, 'chatId', 'telegram');
    const ids = [];
    for (const part of chunk(msg.text, TG_LIMIT)) {
      const res = await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: part,
        // Plain text: the alert bodies contain camera names with underscores and
        // brackets that would break Markdown parsing and get the message rejected.
        disable_web_page_preview: true,
        disable_notification: msg.severity === 'info',
        ...(c.threadId ? { message_thread_id: Number(c.threadId) } : {}),
      });
      if (!res.body?.ok) throw new ChannelError(`Telegram rejected the message: ${JSON.stringify(res.body).slice(0, 200)}`);
      ids.push(res.body.result?.message_id);
    }
    return { messageIds: ids, target: chatId };
  },
};
