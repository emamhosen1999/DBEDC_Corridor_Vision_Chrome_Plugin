/**
 * Channel registry and the delivery worker.
 *
 * Channels are plain objects with `send(msg, config)`, plus optional `validate` and
 * `health`. The worker owns retries via the persisted queue, so a channel
 * implementation only has to make one attempt and throw a useful error.
 */
import { whatsappGreen, whatsappWaha, whatsappCloud, whatsappCallmebot, whatsappWeb } from './whatsapp.mjs';
import { telegram } from './telegram.mjs';
import { slack, teams, discord, webhook } from './webhooks.mjs';
import { email } from './email.mjs';
import { consoleChannel, desktop, createDashboardChannel } from './local.mjs';
import { due, markSent, markFailed } from '../queue.mjs';
import { log } from '../../core/logger.mjs';

const logger = log('delivery');

export function createChannels({ broadcast } = {}) {
  return {
    console: consoleChannel,
    desktop,
    dashboard: createDashboardChannel(broadcast ?? (() => {})),
    whatsappWeb,
    whatsappGreen,
    whatsappWaha,
    whatsappCloud,
    whatsappCallmebot,
    telegram,
    slack,
    teams,
    discord,
    webhook,
    email,
  };
}

/**
 * Attempt every due message once. Called on a short timer by the engine.
 * Returns `{ sent, failed }`.
 */
export async function drainQueue(channels, cfg) {
  const items = await due();
  if (!items.length) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  // Group by channel so one broken channel cannot block the others, while messages
  // within a channel stay strictly ordered (a recovery must not overtake its outage).
  const byChannel = new Map();
  for (const item of items) {
    const list = byChannel.get(item.channel) ?? [];
    list.push(item);
    byChannel.set(item.channel, list);
  }

  await Promise.all([...byChannel.entries()].map(async ([name, list]) => {
    const channel = channels[name];
    const channelCfg = cfg.channels[name];
    if (!channel) {
      for (const item of list) await markFailed(item.id, new Error(`unknown channel "${name}"`), { permanent: true });
      failed += list.length;
      return;
    }
    if (!channelCfg?.enabled) {
      // Disabled after the message was queued: drop rather than retry forever.
      for (const item of list) await markFailed(item.id, new Error(`channel "${name}" was disabled`), { permanent: true });
      failed += list.length;
      return;
    }
    for (const item of list.sort((a, b) => a.createdAt - b.createdAt)) {
      try {
        const info = await channel.send(item, channelCfg);
        await markSent(item.id, { info });
        sent++;
        logger.info('delivered', { channel: name, type: item.alertType, severity: item.severity });
      } catch (err) {
        failed++;
        await markFailed(item.id, err, {
          permanent: err.permanent === true,
          maxAgeMs: cfg.retention.outboxMaxAge,
        });
        // One bad message must not stop the rest of this channel's backlog.
      }
    }
  }));

  return { sent, failed };
}

/** Validate every enabled channel's configuration. Used by `doctor` and the dashboard. */
export function validateChannels(channels, cfg) {
  const report = [];
  for (const [name, channelCfg] of Object.entries(cfg.channels)) {
    if (!channelCfg?.enabled) continue;
    const channel = channels[name];
    if (!channel) { report.push({ channel: name, ok: false, problems: ['no such channel'] }); continue; }
    let problems = [];
    try { problems = channel.validate?.(channelCfg) ?? []; }
    catch (err) { problems = [`validation threw: ${err.message}`]; }
    report.push({
      channel: name,
      ok: problems.length === 0,
      describe: channel.describe?.() ?? name,
      problems,
    });
  }
  return report;
}

export { whatsappWeb };
