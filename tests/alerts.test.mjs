import test from 'node:test';
import assert from 'node:assert/strict';
import { coalesce, routeAccepts, inMaintenance, AlertBus } from '../src/alerts/bus.mjs';
import { deepMerge, DEFAULTS } from '../src/core/config.mjs';
import { renderAlert, severityOf, atLeast } from '../src/core/format.mjs';

const cfg = (patch = {}) => deepMerge(DEFAULTS, patch);

test('same-type alerts coalesce into one message', () => {
  const alerts = Array.from({ length: 12 }, (_, i) => ({ type: 'camera.down', cameraId: `c${i}`, name: `Cam ${i}`, group: 'Zone 3', at: 1000 }));
  const out = coalesce(alerts);
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 12);
  assert.equal(out[0].group, 'Zone 3');
});

test('coalescing keeps different types apart and puts critical first', () => {
  const out = coalesce([
    { type: 'camera.up', name: 'a', at: 1 },
    { type: 'camera.down', name: 'b', at: 1 },
    { type: 'site.groupDown', group: 'Z', at: 1 },
  ]);
  assert.equal(out.length, 3);
  assert.equal(severityOf(out[0]), 'critical', 'most severe must lead');
});

test('a coalesced alert renders one message naming every camera', () => {
  const alert = {
    type: 'camera.down', at: Date.now(), count: 3,
    items: [{ name: 'A', group: 'Z', host: '1.1.1.1' }, { name: 'B', group: 'Z' }, { name: 'C', group: 'Z' }],
  };
  const { text, title } = renderAlert(alert, cfg());
  assert.match(title, /3 cameras OFFLINE/);
  for (const n of ['A', 'B', 'C']) assert.ok(text.includes(n), `missing ${n}`);
});

test('routes filter by severity, type and group', () => {
  const alert = { type: 'camera.down', group: 'Zone 1' };
  assert.equal(routeAccepts({ minSeverity: 'critical' }, alert, 'warning'), false);
  assert.equal(routeAccepts({ minSeverity: 'warning' }, alert, 'warning'), true);
  assert.equal(routeAccepts({ types: ['camera.up'] }, alert, 'warning'), false);
  assert.equal(routeAccepts({ excludeTypes: ['camera.down'] }, alert, 'warning'), false);
  assert.equal(routeAccepts({ groups: ['Zone 2'] }, alert, 'warning'), false);
  assert.equal(routeAccepts({ groups: ['Zone 1'] }, alert, 'warning'), true);
});

test('a group route never hides a site-level alert that has no group', () => {
  assert.equal(routeAccepts({ groups: ['Zone 1'] }, { type: 'monitor.stalled' }, 'critical'), true);
});

test('maintenance windows suppress by group, camera and site-wide', () => {
  const now = Date.parse('2026-09-12T02:00:00Z');
  const w = (extra) => cfg({ alerts: { maintenance: [{ name: 'PM', from: '2026-09-12T01:00:00Z', to: '2026-09-12T05:00:00Z', ...extra }] } });
  assert.ok(inMaintenance({ group: 'Zone 1' }, w({}), now), 'no scope means site-wide');
  assert.ok(inMaintenance({ group: 'Zone 1' }, w({ groups: ['Zone 1'] }), now));
  assert.equal(inMaintenance({ group: 'Zone 2' }, w({ groups: ['Zone 1'] }), now), null);
  assert.ok(inMaintenance({ cameraId: 'c1' }, w({ cameras: ['c1'] }), now));
  assert.equal(inMaintenance({ group: 'Zone 1' }, w({}), Date.parse('2026-09-12T06:00:00Z')), null, 'outside the window');
});

/** A channel that records what it was asked to send. */
function recorder() {
  const sent = [];
  return { sent, channel: { name: 'test', validate: () => [], send: async (msg) => { sent.push(msg); return {}; } } };
}

async function runBus(config, alerts) {
  const { sent, channel } = recorder();
  const state = { alerts: {} };
  const bus = new AlertBus(config, { console: channel }, { state });
  await bus.publish(alerts, { immediate: true });
  const { drainQueue } = await import('../src/alerts/channels/index.mjs');
  await drainQueue({ console: channel }, config);
  return sent;
}

test('quiet hours suppress warnings but let criticals through', async () => {
  const base = {
    alerts: {
      coalesceSec: 0, minSeverity: 'info',
      quietHours: { enabled: true, from: '00:00', to: '23:59', overrideAtOrAbove: 'critical' },
    },
    channels: { console: { enabled: true, routes: {} }, dashboard: { enabled: false } },
  };
  const sent = await runBus(cfg(base), [
    { type: 'camera.down', name: 'A', at: Date.now() },       // warning → suppressed
    { type: 'monitor.stalled', staleMs: 1000, at: Date.now() }, // critical → delivered
  ]);
  const types = sent.map((s) => s.alertType);
  assert.ok(!types.includes('camera.down'), 'warning must be held during quiet hours');
  assert.ok(types.includes('monitor.stalled'), 'critical must override quiet hours');
});

test('minSeverity filters out routine chatter', async () => {
  const sent = await runBus(cfg({
    alerts: { coalesceSec: 0, minSeverity: 'critical' },
    channels: { console: { enabled: true, routes: {} }, dashboard: { enabled: false } },
  }), [{ type: 'camera.up', name: 'A', at: Date.now() }]);
  assert.equal(sent.length, 0);
});

test('the hourly rate limit caps warnings but never criticals, and says it is limiting', async () => {
  const config = cfg({
    alerts: { coalesceSec: 0, minSeverity: 'info', maxPerHour: 3 },
    channels: { console: { enabled: true, routes: {} }, dashboard: { enabled: false } },
  });
  const { sent, channel } = recorder();
  const bus = new AlertBus(config, { console: channel }, { state: { alerts: {} } });
  for (let i = 0; i < 8; i++) {
    await bus.publish([{ type: 'camera.flapping', name: `C${i}`, changes: 5, windowMin: 30, at: Date.now() + i }], { immediate: true });
  }
  await bus.publish([{ type: 'monitor.stalled', staleMs: 1, at: Date.now() }], { immediate: true });
  const { drainQueue } = await import('../src/alerts/channels/index.mjs');
  await drainQueue({ console: channel }, config);

  const flaps = sent.filter((s) => s.alertType === 'camera.flapping');
  assert.equal(flaps.length, 3, `cap is 3, got ${flaps.length}`);
  assert.ok(sent.some((s) => s.alertType === 'alerts.rateLimited'), 'must announce that it is limiting, not go quiet');
  assert.ok(sent.some((s) => s.alertType === 'monitor.stalled'), 'criticals are never rate limited');
});

test('alerting disabled still records events but sends nothing', async () => {
  const sent = await runBus(cfg({
    alerts: { enabled: false, coalesceSec: 0 },
    channels: { console: { enabled: true }, dashboard: { enabled: false } },
  }), [{ type: 'monitor.stalled', staleMs: 1, at: Date.now() }]);
  assert.equal(sent.length, 0);
});

test('severity ranking', () => {
  assert.ok(atLeast('critical', 'warning'));
  assert.ok(atLeast('warning', 'warning'));
  assert.ok(!atLeast('info', 'warning'));
  assert.equal(severityOf({ type: 'camera.escalation' }), 'critical');
  assert.equal(severityOf({ type: 'camera.down' }), 'warning');
  assert.equal(severityOf({ type: 'camera.up' }), 'info');
  assert.equal(severityOf({ type: 'camera.down', severity: 'critical' }), 'critical', 'explicit severity wins');
});
