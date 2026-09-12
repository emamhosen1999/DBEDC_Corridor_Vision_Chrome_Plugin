/**
 * Alert bus — decides what gets said, to whom, and how often.
 *
 * Everything here exists because an alerting system's real failure mode is not
 * missing an alert; it is sending so many that people stop reading them. The old
 * extension had none of this: every transition became a desktop toast, immediately,
 * forever (audit findings B4, M6, M8).
 *
 * The pipeline, in order:
 *   1. ENABLED       — is alerting on at all?
 *   2. MAINTENANCE   — is this camera/group inside a planned window?
 *   3. SEVERITY      — does it clear the floor?
 *   4. COALESCE      — hold non-critical alerts briefly and merge them, so a switch
 *                      reboot sends one message about twelve cameras, not twelve.
 *   5. QUIET HOURS   — suppress below the override severity overnight.
 *   6. ROUTE         — per-channel filters by type, severity and camera group.
 *   7. RATE LIMIT    — a hard per-channel hourly cap; the overflow is summarised once
 *                      rather than dropped silently.
 *   8. ENQUEUE       — hand to the persisted queue, which owns retries.
 */
import { renderAlert, severityOf, atLeast, SEVERITY_RANK } from '../core/format.mjs';
import { inWindow, dayKey } from '../core/time.mjs';
import { enqueue } from './queue.mjs';
import { appendEvent } from '../core/store.mjs';
import { log } from '../core/logger.mjs';

const logger = log('alerts');

/** Types that are merged into one message when they arrive together. */
const COALESCIBLE = new Set(['camera.down', 'camera.up', 'camera.degraded', 'camera.recovered', 'inventory.added', 'inventory.removed']);

/** Is this alert inside a configured maintenance window? */
export function inMaintenance(alert, cfg, now = Date.now()) {
  for (const w of cfg.alerts.maintenance ?? []) {
    const from = Date.parse(w.from);
    const to = Date.parse(w.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (now < from || now > to) continue;
    const groups = w.groups ?? [];
    const cameras = w.cameras ?? [];
    if (!groups.length && !cameras.length) return w;                        // site-wide window
    if (groups.includes(alert.group)) return w;
    if (cameras.includes(alert.cameraId)) return w;
  }
  return null;
}

/** Does a channel's route accept this alert? */
export function routeAccepts(route = {}, alert, severity) {
  if (route.minSeverity && !atLeast(severity, route.minSeverity)) return false;
  if (route.types?.length && !route.types.includes(alert.type)) return false;
  if (route.excludeTypes?.length && route.excludeTypes.includes(alert.type)) return false;
  if (route.groups?.length) {
    const g = alert.group ?? alert.items?.[0]?.group;
    // Site-level alerts have no group and are never filtered out by a group route.
    if (g && !route.groups.includes(g)) return false;
  }
  if (route.excludeGroups?.length && route.excludeGroups.includes(alert.group)) return false;
  return true;
}

/** Merge same-type alerts into one carrying an `items` array. */
export function coalesce(alerts) {
  const groups = new Map();
  const out = [];
  for (const a of alerts) {
    if (!COALESCIBLE.has(a.type)) { out.push(a); continue; }
    const list = groups.get(a.type) ?? [];
    list.push(a);
    groups.set(a.type, list);
  }
  for (const [type, list] of groups) {
    if (list.length === 1) { out.push(list[0]); continue; }
    out.push({
      type,
      at: Math.max(...list.map((x) => x.at ?? Date.now())),
      items: list,
      count: list.length,
      group: new Set(list.map((x) => x.group)).size === 1 ? list[0].group : null,
    });
  }
  // Most severe first so a critical is never buried behind housekeeping.
  return out.sort((a, b) => SEVERITY_RANK[severityOf(b)] - SEVERITY_RANK[severityOf(a)]);
}

export class AlertBus {
  constructor(cfg, channels, { state } = {}) {
    this.cfg = cfg;
    this.channels = channels;              // { name: { send(msg, channelCfg), validate? } }
    this.state = state ?? { alerts: {} };
    this.buffer = [];
    this.flushTimer = null;
  }

  setConfig(cfg) { this.cfg = cfg; }

  /**
   * Publish alerts. Critical alerts flush immediately; everything else is held for
   * `alerts.coalesceSec` so a single cause produces a single message.
   */
  async publish(alerts, { immediate = false } = {}) {
    if (!alerts?.length) return { queued: 0, suppressed: 0 };
    for (const a of alerts) {
      // The log records everything, including alerts that are later suppressed — but
      // not a digest's full rendered body, which would bloat it for no benefit.
      const { text, preRendered, ...rest } = a;
      await appendEvent({ ...rest, severity: severityOf(a) });
    }
    if (!this.cfg.alerts.enabled) {
      logger.debug('alerting disabled, events logged only', { count: alerts.length });
      return { queued: 0, suppressed: alerts.length };
    }

    this.buffer.push(...alerts);
    const hasCritical = alerts.some((a) => severityOf(a) === 'critical');
    const holdMs = (this.cfg.alerts.coalesceSec ?? 0) * 1000;

    if (immediate || hasCritical || holdMs <= 0) return this.flush();

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush().catch((e) => logger.error('flush failed', { error: e.message })); }, holdMs);
      if (this.flushTimer.unref) this.flushTimer.unref();
    }
    return { queued: 0, buffered: this.buffer.length };
  }

  async flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const pending = this.buffer;
    this.buffer = [];
    if (!pending.length) return { queued: 0, suppressed: 0 };

    const now = Date.now();
    const cfg = this.cfg;
    let queued = 0;
    let suppressed = 0;

    for (const alert of coalesce(pending)) {
      const severity = severityOf(alert);

      const window = inMaintenance(alert, cfg, now);
      if (window) {
        logger.info('suppressed by maintenance window', { type: alert.type, window: window.name });
        suppressed++;
        continue;
      }
      if (!atLeast(severity, cfg.alerts.minSeverity)) { suppressed++; continue; }

      const qh = cfg.alerts.quietHours;
      if (qh?.enabled && inWindow(now, qh.from, qh.to, cfg.site.timezone) && !atLeast(severity, qh.overrideAtOrAbove)) {
        logger.info('suppressed by quiet hours', { type: alert.type, severity });
        suppressed++;
        continue;
      }

      const rendered = renderAlert(alert, cfg);

      for (const [name, channelCfg] of Object.entries(cfg.channels)) {
        if (!channelCfg?.enabled) continue;
        if (!this.channels[name]) continue;
        if (!routeAccepts(channelCfg.routes, alert, severity)) continue;
        if (!this.#allowRate(name, severity, now)) {
          suppressed++;
          continue;
        }
        await enqueue({
          channel: name,
          alertType: alert.type,
          severity,
          title: rendered.title,
          text: rendered.text,
          payload: { alert, site: cfg.site.name },
        });
        queued++;
      }
    }
    logger.info('alerts dispatched', { queued, suppressed });
    return { queued, suppressed };
  }

  /**
   * Hourly cap per channel. Critical alerts are never rate-limited — the cap exists
   * to stop routine chatter drowning people, not to hide an emergency.
   */
  #allowRate(channel, severity, now) {
    if (severity === 'critical') return true;
    const max = this.cfg.alerts.maxPerHour ?? 0;
    if (max <= 0) return true;

    const hour = `${dayKey(now, this.cfg.site.timezone)}T${new Date(now).getUTCHours()}`;
    const a = this.state.alerts ??= {};
    if (a.hourKey !== hour) { a.hourKey = hour; a.sentThisHour = {}; a.overflowNotified = {}; }
    a.sentThisHour ??= {};
    const count = a.sentThisHour[channel] ?? 0;

    if (count >= max) {
      a.overflowNotified ??= {};
      if (!a.overflowNotified[channel]) {
        a.overflowNotified[channel] = true;
        logger.warn('hourly alert cap reached; further non-critical alerts held', { channel, max });
        // Say so once, rather than going quiet and letting people assume all is well.
        enqueue({
          channel,
          alertType: 'alerts.rateLimited',
          severity: 'warning',
          title: '⚠️ Alert rate limit reached',
          text: `More than ${max} alerts were raised for this channel in the last hour.\n`
            + 'Further non-critical alerts are being held until the hour rolls over.\n'
            + 'Critical alerts are still being delivered. Check the dashboard for the full picture.',
          payload: { channel, max },
        }).catch(() => {});
      }
      return false;
    }
    a.sentThisHour[channel] = count + 1;
    return true;
  }
}
