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
import { CATALOG, TAGS, byClass, priorityDistribution } from '../alarms/catalog.mjs';
import { effectivePriority, STATE as ALARM_STATE } from '../alarms/register.mjs';
import { listReports, readReport, nextDue } from '../report/scheduler.mjs';
import { buildReportModel } from '../report/model.mjs';
import { render as renderReport } from '../report/render.mjs';
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
        const out = await discoverSubnet(body.cidr, {
          ports: body.ports, concurrency: body.concurrency, timeoutMs: body.timeoutMs,
          username: body.username, password: body.password,
        });
        // A camera answering on the network that nobody is monitoring is a coverage
        // blind spot — or a device that should not be on a camera VLAN at all.
        const inventory = await loadInventory();
        const known = new Set(inventory.cameras.map((c) => c.host));
        const unknown = out.cameras.filter((c) => !known.has(c.host));
        for (const u of unknown) {
          engine.register?.raiseEvent('SEC_ROGUE_DEVICE', { id: `rogue:${u.host}`, name: u.name ?? u.host }, {
            detail: `${u.host} answered on camera ports (${u.openPorts.join(', ') || 'ONVIF'})`
              + `${u.manufacturer ? `, identifying as ${u.manufacturer} ${u.model ?? ''}`.trim() : ''}`
              + ' but is not in the inventory.',
            value: u.host,
          });
        }
        if (unknown.length) await engine.persistAlarms();
        return ok({ ...out, unregistered: unknown });
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
      // Every long-lived subsystem holds its own reference: the register would
      // otherwise keep enforcing the previous maintenance windows and shelve caps.
      engine.bus?.setConfig(cfg);
      engine.register?.setConfig(cfg);
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

    /* ------------------------------- alarms ------------------------------- */

    /** The live annunciator: what needs attention, most severe and oldest first. */
    'GET /api/alarms': async (url) => {
      const reg = engine.register;
      if (!reg) return ok({ alarms: [], enabled: false });
      const scope = url.searchParams.get('scope') ?? 'annunciated';
      const source = scope === 'all' ? [...reg.instances.values()]
        : scope === 'active' ? reg.active()
        : reg.annunciated();
      return ok({
        enabled: true,
        scope,
        alarms: source.map((i) => ({
          key: i.key, tag: i.tag, name: CATALOG[i.tag]?.name ?? i.tag,
          class: CATALOG[i.tag]?.class ?? 'unknown',
          priority: effectivePriority(i), state: i.state,
          subject: i.subjectName, subjectId: i.subjectId, group: i.subjectGroup,
          raisedAt: i.raisedAt, firstRaisedAt: i.firstRaisedAt,
          ackedAt: i.ackedAt, ackedBy: i.ackedBy,
          occurrences: i.occurrences, detail: i.detail, chattering: i.chattering,
          shelvedUntil: i.shelvedUntil, shelveReason: i.shelveReason,
          outOfServiceReason: i.outOfServiceReason,
          correctiveAction: CATALOG[i.tag]?.correctiveAction ?? null,
          consequence: CATALOG[i.tag]?.consequence ?? null,
          timeToRespond: CATALOG[i.tag]?.timeToRespond ?? null,
          shelvable: CATALOG[i.tag]?.shelvable !== false,
        })),
        counts: {
          annunciated: reg.annunciated().length,
          unacknowledged: reg.unacknowledged().length,
          standing: reg.standing().length,
        },
      });
    },

    'POST /api/alarms/ack': async (_url, body) => {
      const reg = engine.register;
      if (!reg) return bad('the alarm register is not running');
      const by = body?.by || 'dashboard';
      if (body?.all) {
        const n = reg.acknowledgeAll({ by, note: body.note });
        await engine.persistAlarms();
        logger.info('bulk acknowledge', { count: n, by });
        return ok({ acknowledged: n });
      }
      if (!body?.key) return bad('provide { "key": "TAG:subjectId" } or { "all": true }');
      const inst = reg.acknowledge(body.key, { by, note: body.note });
      if (!inst) return bad(`nothing to acknowledge for "${body.key}"`);
      await engine.persistAlarms();
      return ok({ acknowledged: 1, alarm: { key: inst.key, state: inst.state, ackedBy: inst.ackedBy } });
    },

    'POST /api/alarms/shelve': async (_url, body) => {
      const reg = engine.register;
      if (!reg) return bad('the alarm register is not running');
      if (!body?.key) return bad('key is required');
      const r = reg.shelve(body.key, {
        hours: body.hours ?? cfg.alarms?.defaultShelveHours ?? 4,
        by: body.by || 'dashboard',
        reason: body.reason,
      });
      if (!r.ok) return bad(r.error);
      await engine.persistAlarms();
      return ok({ shelved: true, hours: r.hours, until: r.instance.shelvedUntil });
    },

    'POST /api/alarms/unshelve': async (_url, body) => {
      const reg = engine.register;
      if (!reg || !body?.key) return bad('key is required');
      const r = reg.unshelve(body.key, { by: body.by || 'dashboard' });
      if (!r.ok) return bad(r.error);
      await engine.persistAlarms();
      return ok({ unshelved: true });
    },

    'POST /api/alarms/out-of-service': async (_url, body) => {
      const reg = engine.register;
      if (!reg || !body?.key) return bad('key is required');
      const r = body.restore
        ? reg.returnToService(body.key, { by: body.by || 'dashboard' })
        : reg.outOfService(body.key, { by: body.by || 'dashboard', reason: body.reason });
      if (!r.ok) return bad(r.error);
      await engine.persistAlarms();
      return ok({ ok: true, state: r.instance.state });
    },

    'GET /api/alarms/kpi': async (url) => {
      const hours = Math.min(24 * 90, Number(url.searchParams.get('hours')) || 24);
      return ok(await engine.alarmKpis(hours));
    },

    /** The rationalised catalogue — what this system can annunciate, and why. */
    'GET /api/alarms/catalog': async () => ok({
      tags: TAGS,
      catalog: CATALOG,
      byClass: Object.fromEntries([...byClass()].map(([k, v]) => [k, v.map((d) => d.tag)])),
      distribution: priorityDistribution(),
      states: Object.values(ALARM_STATE),
    }),

    /* ------------------------------- reports ------------------------------ */

    'GET /api/reports': async (url) => ok({
      reports: await listReports({ limit: Math.min(200, Number(url.searchParams.get('limit')) || 50) }),
      next: nextDue(cfg, { lastIssuedAt: (await loadState()).reporting?.lastIssuedAt ?? 0 }),
      config: cfg.reporting,
    }),

    /** Render a report on demand without issuing or sending it. */
    'GET /api/reports/preview': async (url) => {
      const format = url.searchParams.get('format') ?? 'html';
      const hours = Math.min(24 * 31, Number(url.searchParams.get('hours')) || 6);
      const model = await buildReportModel({
        cfg, register: engine.register, periodMs: hours * 3_600_000,
        label: 'Preview', trigger: 'preview', sequence: { number: 0 },
      });
      const body = renderReport(model, format, format === 'text'
        ? { fullRegister: cfg.reporting?.fullRegister !== false, maxChars: 1e9 }
        : undefined);
      return ok({ format, body: Array.isArray(body) ? body.join('\n\n') : body, reportId: model.meta.reportId });
    },

    /** Read a stored report of record. */
    'GET /api/reports/read': async (url) => {
      const id = url.searchParams.get('id');
      const format = url.searchParams.get('format') ?? 'html';
      if (!id) return bad('id is required');
      const body = await readReport(id, format);
      if (body === null) return bad(`no stored report "${id}" in format "${format}"`, 404);
      return ok({ reportId: id, format, body });
    },

    /** Issue a report now and send it to the channels. */
    'POST /api/reports/send': async (_url, body) => {
      const out = await engine.sendReport({
        label: body?.label ?? 'Manual report',
        trigger: 'manual',
        channels: body?.channels,
        periodMs: body?.hours ? body.hours * 3_600_000 : undefined,
      });
      return ok({
        reportId: out.model.meta.reportId,
        sent: out.sent,
        parts: out.parts ?? 0,
        files: Object.keys(out.files),
        devices: out.model.devices.length,
      });
    },

    'GET /api/site': async () => ok({
      site: cfg.site,
      version: 2,
      intervalSec: cfg.monitor.intervalSec,
      alertsEnabled: cfg.alerts.enabled,
      quietHours: cfg.alerts.quietHours,
      reporting: { enabled: cfg.reporting?.enabled, mode: cfg.reporting?.mode, times: cfg.reporting?.times, intervalMinutes: cfg.reporting?.intervalMinutes },
      alarms: { enabled: cfg.alarms?.enabled },
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
