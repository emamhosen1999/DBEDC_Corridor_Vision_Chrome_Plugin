/**
 * REST API behind the dashboard.
 *
 * Deliberately small and explicit — a lookup table of `METHOD /path` handlers rather
 * than a router, so the entire attack surface is visible on one screen.
 *
 * Nothing here ever returns a credential. Config is passed through `redact()` on the
 * way out, and secrets are written by name into the vault, never read back.
 */
import { loadConfig, saveConfig, validate, deepMerge, DEFAULTS } from '../core/config.mjs';
import { loadState, readEvents, loadInventory, saveInventory } from '../core/store.mjs';
import { redact, setSecret, listSecrets } from '../core/secrets.mjs';
import { cameraAvailability, groupAvailability, fleetTrend, dailyAvailability } from '../monitor/metrics.mjs';
import { importCsv, upsertCamera, removeCamera, normaliseCamera } from '../monitor/inventory.mjs';
import { stats as queueStats, clearHistory } from '../alerts/queue.mjs';
import { validateChannels } from '../alerts/channels/index.mjs';
import { probeCamera } from '../probe/index.mjs';
import { discoverSubnet } from '../monitor/discovery.mjs';
import { renderAlert } from '../core/format.mjs';
import { log } from '../core/logger.mjs';

const logger = log('api');
const ok = (body) => ({ status: 200, body });
const bad = (message, status = 400) => ({ status, body: { error: message } });

export function buildApi({ cfg, engine, server }) {
  const routes = {

    'GET /api/status': async () => ok(await engine.snapshotForApi()),

    'GET /api/health': async () => {
      const s = await engine.snapshotForApi();
      return {
        status: s.stale ? 503 : 200,
        body: {
          ok: !s.stale && s.running,
          stale: s.stale, staleMs: s.staleMs, running: s.running,
          fleet: s.fleet, network: s.network, lastCycleAt: s.cycle.lastFinishedAt,
        },
      };
    },

    'GET /api/events': async (url) => ok({
      events: await readEvents({
        sinceTs: Number(url.searchParams.get('since')) || 0,
        limit: Math.min(1000, Number(url.searchParams.get('limit')) || 200),
        types: url.searchParams.get('types')?.split(',').filter(Boolean),
        cameraId: url.searchParams.get('cameraId') ?? undefined,
      }),
    }),

    'GET /api/metrics': async (url) => {
      const hours = Math.min(24 * 90, Number(url.searchParams.get('hours')) || 24);
      const sinceTs = Date.now() - hours * 3_600_000;
      const state = await loadState();
      const rows = await cameraAvailability({ sinceTs, states: state.cameras });
      const trend = await fleetTrend({ sinceTs, buckets: Number(url.searchParams.get('buckets')) || 96 });
      const daily = await dailyAvailability({ days: Math.ceil(hours / 24) + 1, tz: cfg.site.timezone, states: state.cameras });
      return ok({ hours, cameras: rows, groups: groupAvailability(rows), trend, daily: daily.rows });
    },

    'GET /api/inventory': async () => ok(await loadInventory()),

    'POST /api/inventory/import': async (_url, body) => {
      if (!body?.file) return bad('provide { "file": "path/to/export.csv" }');
      try { return ok(await importCsv(body.file, { merge: body.merge !== false, defaults: body.defaults ?? {} })); }
      catch (err) { return bad(err.message); }
    },

    'POST /api/inventory/camera': async (_url, body) => {
      if (!body) return bad('body required');
      const { camera, errors } = normaliseCamera(body);
      if (errors.length) return bad(errors.join('; '));
      return ok(await upsertCamera(camera));
    },

    'DELETE /api/inventory/camera': async (url) => {
      const id = url.searchParams.get('id');
      if (!id) return bad('id is required');
      return ok(await removeCamera(id));
    },

    'POST /api/inventory/discover': async (_url, body) => {
      if (!body?.cidr) return bad('provide { "cidr": "192.168.10.0/24" }');
      try {
        return ok(await discoverSubnet(body.cidr, {
          ports: body.ports, concurrency: body.concurrency, timeoutMs: body.timeoutMs,
          username: body.username, password: body.password,
        }));
      } catch (err) { return bad(err.message); }
    },

    /** Probe one camera right now and return the full ladder detail. */
    'POST /api/probe': async (_url, body) => {
      if (!body?.host) return bad('provide { "host": "192.168.10.11" }');
      const camera = { id: body.id ?? `adhoc-${body.host}`, name: body.name ?? body.host, host: body.host, ...body };
      const result = await probeCamera(camera, cfg, { cycle: 0, credentials: body.credentials ?? {} });
      return ok(result);
    },

    'POST /api/refresh': async () => {
      const out = await engine.runCycle();
      return ok({ triggered: true, ...out });
    },

    'GET /api/report': async (url) => {
      const fmt = url.searchParams.get('format') ?? 'full';
      if (!['full', 'offline', 'summary'].includes(fmt)) return bad('format must be full, offline or summary');
      return ok({ format: fmt, text: await engine.buildReport(fmt) });
    },

    'POST /api/digest': async () => ok(await engine.sendDigest({ label: 'Manual status digest' })),

    'GET /api/queue': async () => ok(await queueStats()),
    'DELETE /api/queue/history': async () => { await clearHistory(); return ok({ cleared: true }); },

    'GET /api/channels': async () => ok({
      channels: validateChannels(engine.channels, cfg),
      available: Object.entries(engine.channels).map(([name, c]) => ({ name, describe: c.describe?.() ?? name })),
    }),

    /** Send a test message through one channel, end to end. */
    'POST /api/channels/test': async (_url, body) => {
      const name = body?.channel;
      const channel = engine.channels[name];
      if (!channel) return bad(`unknown channel "${name}"`);
      const channelCfg = cfg.channels[name];
      if (!channelCfg) return bad(`channel "${name}" is not configured`);
      const problems = channel.validate?.(channelCfg) ?? [];
      const blocking = problems.filter((p) => !p.startsWith('NOTE:'));
      if (blocking.length) return bad(`configuration is incomplete: ${blocking.join('; ')}`);
      const rendered = renderAlert({ type: 'channel.test', channel: name, at: Date.now() }, cfg);
      try {
        const info = await channel.send({ ...rendered, alertType: 'channel.test' }, channelCfg);
        logger.info('channel test succeeded', { channel: name });
        return ok({ ok: true, channel: name, info, notes: problems.filter((p) => p.startsWith('NOTE:')) });
      } catch (err) {
        logger.warn('channel test failed', { channel: name, error: err.message });
        return ok({ ok: false, channel: name, error: err.message, permanent: err.permanent === true });
      }
    },

    'GET /api/channels/health': async (_url, _body, url) => {
      const name = url.searchParams.get('channel');
      const channel = engine.channels[name];
      if (!channel?.health) return bad(`channel "${name}" has no health check`);
      try { return ok(await channel.health(cfg.channels[name])); }
      catch (err) { return ok({ ok: false, detail: err.message }); }
    },

    'GET /api/config': async () => ok({
      config: redact(loadConfig()),
      defaults: redact(DEFAULTS),
      secrets: listSecrets(),
    }),

    'PUT /api/config': async (_url, body) => {
      if (!body || typeof body !== 'object') return bad('body must be a config patch object');
      const merged = deepMerge(deepMerge(DEFAULTS, loadConfig()), body);
      const { errors, warnings } = validate(merged);
      if (errors.length) return bad(`invalid configuration: ${errors.join('; ')}`);
      const next = saveConfig(body);
      // Push the new config into the live objects so changes take effect immediately.
      Object.assign(cfg, next);
      engine.cfg = cfg;
      engine.bus?.setConfig(cfg);
      logger.info('configuration updated via dashboard');
      return ok({ saved: true, warnings, config: redact(next) });
    },

    /** Store a credential in the encrypted vault. Write-only by design. */
    'POST /api/secret': async (_url, body) => {
      if (!body?.path) return bad('provide { "path": "telegram.botToken", "value": "..." }');
      if (!/^[\w.-]+$/.test(body.path)) return bad('path may contain only letters, digits, dot, dash and underscore');
      setSecret(body.path, body.value === '' || body.value === null ? null : String(body.value));
      logger.info('secret updated', { path: body.path });
      return ok({ saved: true, path: body.path, secrets: listSecrets() });
    },

    'GET /api/site': async () => ok({
      site: cfg.site,
      version: 2,
      intervalSec: cfg.monitor.intervalSec,
      alertsEnabled: cfg.alerts.enabled,
      quietHours: cfg.alerts.quietHours,
    }),
  };

  return {
    async handle(method, url, body) {
      const key = `${method} ${url.pathname}`;
      const route = routes[key];
      if (!route) return bad(`no such endpoint: ${key}`, 404);
      return route(url, body, url);
    },
    routes: Object.keys(routes),
  };
}
