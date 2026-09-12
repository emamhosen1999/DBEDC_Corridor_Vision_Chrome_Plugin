/**
 * The monitoring engine.
 *
 * One cycle:
 *   1. check OUR network path            (never blame cameras for our own outage)
 *   2. probe every enabled camera        (bounded concurrency, bounded per-camera time)
 *   3. evaluate transitions              (confirmation, flap suppression, escalation)
 *   4. persist state, events and samples
 *   5. publish alerts
 *
 * Around that sit four timers: the cycle itself, the delivery queue drain, the
 * watchdog, and the housekeeping/digest tick.
 *
 * The watchdog is the piece the old extension most conspicuously lacked. It watches
 * the monitor, not the cameras: if a cycle has not completed in `staleAfterSec`, it
 * says so on every channel. A monitor that cannot report its own death is not a
 * monitor (audit finding B1).
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { loadConfig } from '../core/config.mjs';
import { log } from '../core/logger.mjs';
import { mapPool, singleFlight, withTimeout } from '../core/pool.mjs';
import { loadState, updateState, appendSample, prune, diskPressure } from '../core/store.mjs';
import { FILES } from '../core/paths.mjs';
import { probeCameraBounded, checkNetwork, STATUS } from '../probe/index.mjs';
import { evaluateCycle, detectMassOutage, summariseFleet } from './detector.mjs';
import { activeCameras } from './inventory.mjs';
import { cameraAvailability, fleetTrend, dailyAvailability } from './metrics.mjs';
import { AlertBus } from '../alerts/bus.mjs';
import { createChannels, drainQueue } from '../alerts/channels/index.mjs';
import { buildDigest, buildStatusReport } from '../core/format.mjs';
import { minuteOfDay, dayKey } from '../core/time.mjs';
import { getSecret } from '../core/secrets.mjs';

const logger = log('engine');

export class Engine extends EventEmitter {
  constructor({ cfg, broadcast } = {}) {
    super();
    this.cfg = cfg ?? loadConfig();
    this.broadcast = broadcast ?? (() => {});
    // Bind lazily: `broadcast` is reassigned once the HTTP server exists, and a
    // channel that captured the constructor-time no-op would silently drop every
    // dashboard alert.
    this.channels = createChannels({ broadcast: (event, data) => this.broadcast(event, data) });
    this.bus = null;
    this.timers = {};
    this.running = false;
    this.cycleCount = 0;
    this.lastCycle = null;
    this.runCycle = singleFlight(() => this.#cycle());
  }

  async start() {
    if (this.running) return;
    this.running = true;
    const state = await loadState();
    this.bus = new AlertBus(this.cfg, this.channels, { state });

    // Was the monitor down while it was not running? Say so — a silent gap in the
    // history is indistinguishable from "everything was fine".
    const lastFinished = state.cycle.lastFinishedAt;
    if (lastFinished) {
      const gapMs = Date.now() - lastFinished;
      if (gapMs > this.cfg.alerts.watchdog.staleAfterSec * 1000) {
        await this.bus.publish([{
          type: 'monitor.recovered', at: Date.now(),
          gapMs, gapFrom: lastFinished, gapTo: Date.now(),
        }], { immediate: true });
      }
    }

    const cameras = await activeCameras();
    await updateState((s) => { s.startedAt = Date.now(); });
    await this.bus.publish([{
      type: 'monitor.started', at: Date.now(),
      cameras: cameras.length, intervalSec: this.cfg.monitor.intervalSec,
    }]);

    logger.info('engine started', {
      cameras: cameras.length,
      intervalSec: this.cfg.monitor.intervalSec,
      concurrency: this.cfg.monitor.concurrency,
    });

    this.#scheduleCycle(0);
    this.timers.queue = setInterval(() => this.#drain(), 5_000);
    this.timers.watchdog = setInterval(() => this.#watchdog(), 30_000);
    this.timers.housekeeping = setInterval(() => this.#housekeeping(), 60_000);
  }

  async stop() {
    this.running = false;
    for (const t of Object.values(this.timers)) clearInterval(t), clearTimeout(t);
    this.timers = {};
    // Give queued alerts a last chance to leave the building before we exit.
    try { await this.bus?.flush(); await withTimeout(this.#drain(), 10_000, 'final queue drain'); }
    catch (err) { logger.warn('final drain incomplete', { error: err.message }); }
    logger.info('engine stopped');
  }

  /** Schedule the next cycle with jitter so probes never land in lockstep. */
  #scheduleCycle(delayMs) {
    if (!this.running) return;
    clearTimeout(this.timers.cycle);
    this.timers.cycle = setTimeout(async () => {
      try { await this.runCycle(); }
      catch (err) { logger.error('cycle threw', { error: err.message, stack: err.stack }); }
      finally {
        const base = this.cfg.monitor.intervalSec * 1000;
        const jitter = base * (this.cfg.monitor.jitterPct / 100);
        this.#scheduleCycle(Math.max(1000, base + (Math.random() * 2 - 1) * jitter));
      }
    }, delayMs);
  }

  async #cycle() {
    const startedAt = Date.now();
    this.cycleCount++;
    await updateState((s) => { s.cycle.lastStartedAt = startedAt; });

    const cameras = await activeCameras();
    if (!cameras.length) {
      logger.warn('no cameras in inventory — import one with: npm run import -- --csv <file>');
      await updateState((s) => { s.cycle.lastFinishedAt = Date.now(); s.cycle.lastError = 'no-cameras'; });
      return { cameras: 0 };
    }

    /* 1. Is our own network path healthy? */
    const network = await checkNetwork(this.cfg);
    const prevState = await loadState();
    const wasHealthy = prevState.network.healthy !== false;
    const networkAlerts = [];
    if (network.checked && !network.healthy && wasHealthy) {
      networkAlerts.push({ type: 'monitor.networkDown', at: startedAt, detail: network.reason });
    } else if (network.checked && network.healthy && !wasHealthy) {
      networkAlerts.push({ type: 'monitor.networkUp', at: startedAt });
    }

    /* 2. Probe. */
    const credentials = {
      username: getSecret('cameras.username', ''),
      password: getSecret('cameras.password', ''),
    };
    const results = [];
    const probed = await withTimeout(
      mapPool(cameras, this.cfg.monitor.concurrency, (camera) => probeCameraBounded(camera, this.cfg, {
        cycle: this.cycleCount,
        credentials,
        history: { snapshot: prevState.cameras[camera.id]?.snapshot ?? {} },
      })),
      this.cfg.monitor.cycleTimeoutMs,
      'monitoring cycle',
    ).catch((err) => {
      logger.error('cycle exceeded its budget', { error: err.message });
      return [];
    });

    for (const [i, r] of probed.entries()) {
      if (r?.ok) results.push(r.value);
      else {
        const camera = cameras[i];
        results.push({
          cameraId: camera.id, name: camera.name, host: camera.host, group: camera.group,
          at: Date.now(), status: STATUS.UNKNOWN, reason: 'probe-failed',
          detail: String(r?.error?.message ?? 'probe did not complete'), layers: {}, warnings: [],
        });
      }
    }

    /* 3. Evaluate. */
    const now = Date.now();
    const { states, transitions, fleet } = evaluateCycle({
      prevStates: prevState.cameras,
      results,
      cfg: this.cfg,
      now,
      networkHealthy: network.healthy,
    });

    const mass = detectMassOutage(fleet, this.cfg, prevState.massFlags ?? {});

    /* 4. Persist. */
    const durationMs = Date.now() - startedAt;
    await updateState((s) => {
      s.cameras = states;
      s.fleet = fleet;
      s.massFlags = mass.flags;
      s.network = { healthy: network.healthy, since: network.healthy === wasHealthy ? (s.network.since || now) : now, lastCheck: now, detail: network.reason ?? null };
      s.cycle = { count: this.cycleCount, lastStartedAt: startedAt, lastFinishedAt: now, lastDurationMs: durationMs, lastError: null };
    });
    await appendSample({ total: fleet.total, up: fleet.up, down: fleet.down, degraded: fleet.degraded, unknown: fleet.unknown, durationMs });
    await this.#heartbeat({ fleet, durationMs });

    this.lastCycle = { at: now, durationMs, fleet, transitions: transitions.length };
    this.broadcast('status', { fleet, cameras: this.#cameraList(states), cycle: this.lastCycle, network: { healthy: network.healthy } });

    /* 5. Alert. */
    const alerts = [...networkAlerts, ...transitions.map((t) => ({ ...t })), ...mass.alerts.map((a) => ({ ...a, at: now }))];
    if (!this.cfg.alerts.inventoryChanges) {
      // Still logged as events; just not pushed to people.
      for (let i = alerts.length - 1; i >= 0; i--) if (alerts[i].type.startsWith('inventory.')) alerts.splice(i, 1);
    }
    if (alerts.length) await this.bus.publish(alerts);

    if (durationMs > this.cfg.monitor.intervalSec * 1000) {
      logger.warn('cycle took longer than the interval — raise intervalSec or concurrency', {
        durationMs, intervalSec: this.cfg.monitor.intervalSec, cameras: cameras.length,
      });
    }
    logger.info('cycle complete', {
      cameras: cameras.length, up: fleet.up, down: fleet.down, degraded: fleet.degraded,
      unknown: fleet.unknown, durationMs, alerts: alerts.length,
    });
    return { fleet, transitions, durationMs };
  }

  #cameraList(states) {
    const now = Date.now();
    return Object.entries(states).map(([id, s]) => ({
      cameraId: id, name: s.name, host: s.host, group: s.group, status: s.status,
      since: s.since, downtimeMs: s.status === STATUS.UP ? 0 : now - s.since,
      flapping: s.flapping, warnings: s.warnings, latencyMs: s.latencyMs,
      reason: s.lastReason, detail: s.lastDetail, lastProbeAt: s.lastProbeAt,
    }));
  }

  /** A file an external supervisor (or a human) can read to see we are alive. */
  async #heartbeat({ fleet, durationMs }) {
    try {
      await fs.writeFile(FILES.heartbeat, JSON.stringify({
        at: Date.now(), pid: process.pid, cycle: this.cycleCount,
        fleet, durationMs, intervalSec: this.cfg.monitor.intervalSec,
      }, null, 2));
    } catch { /* heartbeat is advisory */ }
  }

  async #drain() {
    try { await drainQueue(this.channels, this.cfg); }
    catch (err) { logger.error('queue drain failed', { error: err.message }); }
  }

  /**
   * Watch the monitor itself. Fires when cycles stop completing — the failure the old
   * extension could not report at all.
   */
  async #watchdog() {
    const wd = this.cfg.alerts.watchdog;
    if (!wd.enabled) return;
    const state = await loadState();
    const lastOk = state.cycle.lastFinishedAt;
    const staleMs = Date.now() - (lastOk || state.startedAt || Date.now());
    if (staleMs < wd.staleAfterSec * 1000) {
      if (state.alerts.watchdogNotifiedAt) {
        await updateState((s) => { s.alerts.watchdogNotifiedAt = 0; });
      }
      return;
    }
    const notifiedAt = state.alerts.watchdogNotifiedAt ?? 0;
    if (Date.now() - notifiedAt < wd.repeatEveryMin * 60_000) return;

    await updateState((s) => { s.alerts.watchdogNotifiedAt = Date.now(); });
    await this.bus.publish([{
      type: 'monitor.stalled', at: Date.now(), staleMs, lastOkAt: lastOk,
      reason: state.cycle.lastError ?? 'cycles are not completing',
    }], { immediate: true });
    logger.error('WATCHDOG: monitoring has stalled', { staleMs, lastOkAt: lastOk });
  }

  /** Digests, retention, SLA checks and disk pressure — once a minute, cheaply. */
  async #housekeeping() {
    const now = Date.now();
    const tz = this.cfg.site.timezone;
    const state = await loadState();

    /* Scheduled digests */
    const digest = this.cfg.alerts.digest;
    if (digest.enabled) {
      const today = dayKey(now, tz);
      const minute = minuteOfDay(now, tz);
      for (const time of digest.times ?? []) {
        const [h, m] = time.split(':').map(Number);
        const target = h * 60 + m;
        // Fire within a two-minute window, once per day per configured time.
        if (minute < target || minute > target + 2) continue;
        if (state.alerts.lastDigestDay?.[time] === today) continue;
        await updateState((s) => { (s.alerts.lastDigestDay ??= {})[time] = today; });
        await this.sendDigest({ label: `${time} status digest` });
      }
    }

    /* SLA breach check — once per day, after the first digest time */
    const sla = this.cfg.alerts.slaBreach;
    if (sla?.enabled) {
      const today = dayKey(now, tz);
      if (state.alerts.lastSlaDay !== today && minuteOfDay(now, tz) >= 23 * 60) {
        const rows = await cameraAvailability({ sinceTs: now - 86_400_000, states: state.cameras });
        const daily = await dailyAvailability({ days: 2, tz, states: state.cameras });
        const uptimePct = daily.today?.uptimePct;
        await updateState((s) => { s.alerts.lastSlaDay = today; });
        if (uptimePct !== null && uptimePct !== undefined && uptimePct < sla.dailyUptimePct) {
          await this.bus.publish([{
            type: 'sla.breach', at: now, uptimePct, targetPct: sla.dailyUptimePct,
            worst: rows.filter((r) => r.uptimePct < 100).slice(0, 10),
          }]);
        }
      }
    }

    /* Retention + disk pressure */
    if (this.cycleCount % 60 === 0 || !this._prunedOnce) {
      this._prunedOnce = true;
      await prune(this.cfg.retention).catch(() => {});
      const disk = await diskPressure();
      if (disk.freePct < 5 && !state.alerts.diskNotified) {
        await updateState((s) => { s.alerts.diskNotified = true; });
        await this.bus.publish([{ type: 'monitor.diskLow', at: now, freePct: Math.round(disk.freePct) }], { immediate: true });
      } else if (disk.freePct >= 10 && state.alerts.diskNotified) {
        await updateState((s) => { s.alerts.diskNotified = false; });
      }
    }
  }

  /** Build and publish a digest immediately (also used by the dashboard button). */
  async sendDigest({ label = 'Status digest' } = {}) {
    const state = await loadState();
    const cameras = this.#cameraList(state.cameras);
    const rows = await cameraAvailability({ sinceTs: Date.now() - 86_400_000, states: state.cameras });
    const trend = await fleetTrend({ sinceTs: Date.now() - 86_400_000 });
    const text = buildDigest({
      fleet: state.fleet, cameras, cfg: this.cfg, at: Date.now(), label,
      sla: this.cfg.alerts.digest.includeSla ? { rows, availabilityPct: trend.availabilityPct } : null,
    });
    if (this.cfg.alerts.digest.skipIfAllHealthy && state.fleet.down === 0 && state.fleet.degraded === 0) {
      logger.info('digest skipped — fleet fully healthy');
      return { skipped: true };
    }
    await this.bus.publish([{ type: 'digest.scheduled', at: Date.now(), label, text, preRendered: text }], { immediate: true });
    return { sent: true, text };
  }

  /** On-demand report in any of the three shapes. Used by the dashboard and CLI. */
  async buildReport(fmt = 'full') {
    const state = await loadState();
    return buildStatusReport({
      fleet: state.fleet,
      cameras: this.#cameraList(state.cameras),
      cfg: this.cfg,
      fmt,
    });
  }

  async snapshotForApi() {
    const state = await loadState();
    return {
      fleet: state.fleet,
      cameras: this.#cameraList(state.cameras),
      cycle: state.cycle,
      network: state.network,
      startedAt: state.startedAt,
      running: this.running,
      staleMs: state.cycle.lastFinishedAt ? Date.now() - state.cycle.lastFinishedAt : null,
      stale: state.cycle.lastFinishedAt
        ? Date.now() - state.cycle.lastFinishedAt > this.cfg.alerts.watchdog.staleAfterSec * 1000
        : true,
    };
  }
}

export { summariseFleet };
