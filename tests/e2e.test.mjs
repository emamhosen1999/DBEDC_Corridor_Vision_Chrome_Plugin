/**
 * End-to-end: real fake cameras, real engine, real HTTP server, real alert delivery.
 * Nothing is stubbed except the cameras themselves and the outbound channel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startFakeCamera } from './helpers/fake-camera.mjs';

/** Reserve a free TCP port by binding and releasing it. */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-e2e-'));
process.env.CORRIDOR_HOME = HOME;
fs.mkdirSync(path.join(HOME, 'config'), { recursive: true });

let healthy; let broken; let engine; let server; let cfg;
const delivered = [];

test.before(async () => {
  healthy = await startFakeCamera({ requireAuth: false });
  broken = await startFakeCamera({ requireAuth: false, behaviour: 'rtsp-dead' });
  const port = await freePort();

  fs.writeFileSync(path.join(HOME, 'config', 'config.json'), JSON.stringify({
    site: { name: 'Test Corridor', timezone: 'Asia/Dhaka' },
    server: { host: '127.0.0.1', port },
    monitor: { intervalSec: 3600, concurrency: 4, gatewayCheck: { enabled: false } },
    probe: {
      icmp: { enabled: false }, vendor: { enabled: false }, snapshot: { enabled: false },
      tcp: { ports: [healthy.rtspPort, broken.rtspPort], timeoutMs: 1000 },
      onvif: { timeoutMs: 1500 }, rtsp: { timeoutMs: 1500, pathTemplates: ['/media/video1'] },
    },
    detect: { confirmDownCycles: 1, confirmUpCycles: 1 },
    alerts: { coalesceSec: 0, minSeverity: 'info', digest: { enabled: false }, watchdog: { enabled: false } },
    channels: { console: { enabled: false }, dashboard: { enabled: false }, desktop: { enabled: false } },
  }, null, 2));

  const { loadConfig } = await import('../src/core/config.mjs');
  const { configureLogger } = await import('../src/core/logger.mjs');
  configureLogger({ level: 'error', file: false });
  cfg = loadConfig({ force: true });

  const { importCsv } = await import('../src/monitor/inventory.mjs');
  const csv = path.join(HOME, 'cams.csv');
  fs.writeFileSync(csv, [
    'Camera,Organization,IP,rtspPort,onvifPort',
    `Healthy Cam,Zone 1,127.0.0.1,${healthy.rtspPort},${healthy.httpPort}`,
    `Broken Cam,Zone 2,127.0.0.1,${broken.rtspPort},${broken.httpPort}`,
  ].join('\n'));
  await importCsv(csv);

  const { Engine } = await import('../src/monitor/engine.mjs');
  const { DashboardServer } = await import('../src/server/http.mjs');
  engine = new Engine({ cfg });
  // Capture everything that would be sent, instead of sending it.
  cfg.channels.capture = { enabled: true, routes: {} };
  engine.channels.capture = { name: 'capture', validate: () => [], send: async (m) => { delivered.push(m); return {}; } };
  server = new DashboardServer({ cfg, engine });
  engine.broadcast = (e, d) => server.broadcast(e, d);
  await server.listen();
  await engine.start();
});

test.after(async () => {
  await engine?.stop();
  await server?.close();
  await healthy?.stop();
  await broken?.stop();
});

const api = async (p, opts) => {
  const res = await fetch(`http://127.0.0.1:${cfg.server.port}${p}`, opts);
  return { status: res.status, body: await res.json() };
};

test('a probe cycle classifies healthy and broken cameras correctly', async () => {
  await engine.runCycle();
  const { body } = await api('/api/status');
  assert.equal(body.fleet.total, 2);
  assert.equal(body.fleet.up, 1);
  assert.equal(body.fleet.degraded, 1, 'the RTSP-dead camera is degraded, not up and not down');
  const bad = body.cameras.find((c) => c.status === 'degraded');
  assert.equal(bad.name, 'Broken Cam');
  assert.match(bad.detail, /not serving video/);
});

test('the degraded camera produced an alert that reached a channel', async () => {
  const { drainQueue } = await import('../src/alerts/channels/index.mjs');
  await engine.bus.flush();
  await drainQueue(engine.channels, cfg);
  const alert = delivered.find((d) => d.alertType === 'camera.degraded');
  assert.ok(alert, `expected a camera.degraded delivery, got: ${delivered.map((d) => d.alertType).join(', ')}`);
  assert.match(alert.text, /Broken Cam/);
  assert.match(alert.text, /Test Corridor/, 'the site name must be in the message footer');
});

test('an outage and its recovery are both detected, logged and timed', async () => {
  const ports = { rtspPort: healthy.rtspPort, httpPort: healthy.httpPort };
  await healthy.stop();                       // pull the plug
  await engine.runCycle();
  let { body } = await api('/api/status');
  // NB these fakes live on 127.0.0.1, where a closed port answers with RST rather
  // than timing out — so the host is provably alive and `degraded` is the correct
  // verdict. A real camera that has lost power times out and reads as `down`; that
  // path is covered in probe.test.mjs against an unroutable address.
  assert.equal(body.fleet.up, 0, 'the stopped camera must stop counting as healthy');
  const stopped = body.cameras.find((c) => c.name === 'Healthy Cam');
  assert.ok(['down', 'degraded'].includes(stopped.status), `expected an outage state, got ${stopped.status}`);

  healthy = await startFakeCamera({ requireAuth: false, ...ports });
  await engine.runCycle();
  ({ body } = await api('/api/status'));
  assert.equal(body.fleet.up, 1, 'it must come back up');

  const { body: ev } = await api('/api/events?limit=80');
  const mine = ev.events.filter((e) => e.name === 'Healthy Cam');
  const outage = mine.find((e) => e.type === 'camera.down' || e.type === 'camera.degraded');
  const recovery = mine.find((e) => e.type === 'camera.up' || e.type === 'camera.recovered');
  assert.ok(outage, `the outage must be in the event log; saw ${mine.map((e) => e.type).join(', ')}`);
  assert.ok(recovery, 'so must the recovery');
  assert.ok(recovery.downtimeMs >= 0, 'recovery carries the outage duration');
  assert.ok(recovery.ts >= outage.ts, 'recovery must come after the outage');
});

test('the report endpoint renders all three shapes', async () => {
  for (const fmt of ['full', 'offline', 'summary']) {
    const { status, body } = await api(`/api/report?format=${fmt}`);
    assert.equal(status, 200);
    assert.ok(body.text.includes('Test Corridor'), `${fmt} report lost the site name`);
  }
  assert.equal((await api('/api/report?format=bogus')).status, 400);
});

test('metrics compute availability from real history', async () => {
  const { status, body } = await api('/api/metrics?hours=24');
  assert.equal(status, 200);
  assert.equal(body.cameras.length >= 1, true);
  for (const row of body.cameras) {
    assert.ok(row.uptimePct >= 0 && row.uptimePct <= 100, `implausible uptime ${row.uptimePct}`);
  }
});

test('health endpoint reports 200 while fresh', async () => {
  const { status, body } = await api('/api/health');
  assert.equal(status, 200);
  assert.equal(body.stale, false);
});

test('the dashboard and its assets are served', async () => {
  for (const p of ['/', '/app.js', '/app.css']) {
    const res = await fetch(`http://127.0.0.1:${cfg.server.port}${p}`);
    assert.equal(res.status, 200, `${p} did not serve`);
  }
});

test('path traversal out of the static directory is refused', async () => {
  for (const p of ['/../../config/config.json', '/..%2f..%2fconfig%2fconfig.json']) {
    const res = await fetch(`http://127.0.0.1:${cfg.server.port}${p}`);
    assert.ok(res.status === 403 || res.status === 404, `${p} returned ${res.status}`);
    const text = await res.text();
    assert.ok(!text.includes('accessToken'), 'config contents must never be served');
  }
});

test('an unknown API endpoint 404s cleanly', async () => {
  const { status, body } = await api('/api/nope');
  assert.equal(status, 404);
  assert.match(body.error, /no such endpoint/);
});

test('config can be read and updated over the API, and secrets are never returned', async () => {
  const { setSecret } = await import('../src/core/secrets.mjs');
  setSecret('email.pass', 'SUPER-SECRET-VALUE');
  const { body } = await api('/api/config');
  assert.equal(body.config.site.name, 'Test Corridor');
  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes('SUPER-SECRET-VALUE'), 'a stored credential must never be returned by the API');
  assert.ok(body.secrets.includes('email.pass'), 'the API lists secret NAMES so the UI can show what is configured');

  const put = await api('/api/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ detect: { confirmDownCycles: 3 } }),
  });
  assert.equal(put.status, 200);
  assert.equal(cfg.detect.confirmDownCycles, 3, 'the change must take effect live');
});

test('an invalid config update is rejected without corrupting the live config', async () => {
  const res = await api('/api/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site: { timezone: 'Not/AZone' } }),
  });
  assert.equal(res.status, 400);
  assert.equal(cfg.site.timezone, 'Asia/Dhaka', 'the live config must be untouched');
});

test('ad-hoc probing works through the API', async () => {
  const { status, body } = await api('/api/probe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', rtspPort: healthy.rtspPort, onvifPort: healthy.httpPort, rtspPath: '/media/video1', ports: [healthy.rtspPort] }),
  });
  assert.equal(status, 200);
  assert.equal(body.status, 'up', `${body.reason}: ${body.detail}`);
  assert.ok(body.layers.rtsp.ok);
});

test('a heartbeat file is written for external supervision', () => {
  const hb = JSON.parse(fs.readFileSync(path.join(HOME, 'data', 'heartbeat.json'), 'utf8'));
  assert.equal(hb.pid, process.pid);
  assert.ok(hb.at > 0);
  assert.ok(hb.fleet.total >= 2);
});
