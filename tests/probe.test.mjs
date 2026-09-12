import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFakeCamera } from './helpers/fake-camera.mjs';
import { rtspProbe } from '../src/probe/rtsp.mjs';
import { onvifAlive, onvifDeviceInfo } from '../src/probe/onvif.mjs';
import { tcpLadder } from '../src/probe/tcp.mjs';
import { probeCamera, STATUS } from '../src/probe/index.mjs';
import { deepMerge, DEFAULTS } from '../src/core/config.mjs';

const cfg = (patch = {}) => deepMerge(DEFAULTS, deepMerge({
  probe: { icmp: { enabled: false }, snapshot: { enabled: false }, vendor: { enabled: false } },
}, patch));

test('RTSP DESCRIBE succeeds against a digest-protected camera and parses the SDP', async (t) => {
  const cam = await startFakeCamera({ username: 'admin', password: 'secret' });
  t.after(() => cam.stop());
  const r = await rtspProbe('127.0.0.1', {
    port: cam.rtspPort, paths: ['/media/video1'], username: 'admin', password: 'secret', timeoutMs: 4000,
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.videoCodec, 'H265');
  assert.equal(r.videoDimensions, '1920x1080');
  assert.equal(r.videoFramerate, 25);
});

test('RTSP reports an auth failure distinctly from an outage', async (t) => {
  const cam = await startFakeCamera({ username: 'admin', password: 'secret' });
  t.after(() => cam.stop());
  const r = await rtspProbe('127.0.0.1', {
    port: cam.rtspPort, paths: ['/media/video1'], username: 'admin', password: 'WRONG', timeoutMs: 4000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'auth');
  assert.equal(r.hostAlive, true, 'a credential failure still proves the camera is alive');
});

test('RTSP tries other paths on 404 but gives up immediately on a hard failure', async (t) => {
  const cam = await startFakeCamera({ requireAuth: false, rtspPath: '/media/video1' });
  t.after(() => cam.stop());
  const r = await rtspProbe('127.0.0.1', {
    port: cam.rtspPort, paths: ['/wrong', '/also-wrong', '/media/video1'], timeoutMs: 4000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts.length, 3, 'should have walked past both 404s');
});

test('ONVIF GetSystemDateAndTime works without credentials and reports drift', async (t) => {
  const cam = await startFakeCamera();
  t.after(() => cam.stop());
  const r = await onvifAlive('127.0.0.1', { port: cam.httpPort, timeoutMs: 3000 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.dateTimeType, 'NTP');
  assert.ok(Math.abs(r.driftSec) <= 2, `drift should be near zero, got ${r.driftSec}`);
});

test('ONVIF device information identifies the vendor', async (t) => {
  const cam = await startFakeCamera();
  t.after(() => cam.stop());
  const r = await onvifDeviceInfo('127.0.0.1', { port: cam.httpPort, timeoutMs: 3000 });
  assert.equal(r.manufacturer, 'Uniview');
  assert.equal(r.model, 'IPC2324SR5');
});

test('a healthy camera is UP through the full ladder', async (t) => {
  const cam = await startFakeCamera();
  t.after(() => cam.stop());
  const c = cfg({ probe: { onvif: { port: cam.httpPort }, rtsp: { port: cam.rtspPort }, tcp: { ports: [cam.rtspPort] } } });
  const r = await probeCamera(
    { id: 'c1', name: 'Fake', host: '127.0.0.1', rtspPath: '/media/video1', onvifPort: cam.httpPort, rtspPort: cam.rtspPort, ports: [cam.rtspPort] },
    c, { cycle: 1, credentials: { username: 'admin', password: 'secret' } },
  );
  assert.equal(r.status, STATUS.UP, `${r.reason}: ${r.detail}`);
});

test('a camera that pings and speaks ONVIF but will not serve RTSP is DEGRADED, not UP', async (t) => {
  // This is the failure class the AIV-MP platform cannot see at all.
  const cam = await startFakeCamera({ behaviour: 'rtsp-dead' });
  t.after(() => cam.stop());
  const c = cfg({ probe: { onvif: { port: cam.httpPort }, rtsp: { port: cam.rtspPort }, tcp: { ports: [cam.rtspPort] } } });
  const r = await probeCamera(
    { id: 'c1', name: 'Fake', host: '127.0.0.1', rtspPath: '/media/video1', onvifPort: cam.httpPort, rtspPort: cam.rtspPort, ports: [cam.rtspPort] },
    c, { cycle: 1, credentials: { username: 'admin', password: 'secret' } },
  );
  assert.equal(r.status, STATUS.DEGRADED);
  assert.match(r.detail, /not serving video/);
});

test('an unroutable address is DOWN with a cabling/power hint', async () => {
  const c = cfg({ probe: { tcp: { ports: [554], timeoutMs: 900 }, onvif: { timeoutMs: 900 }, rtsp: { timeoutMs: 900 } } });
  const r = await probeCamera({ id: 'x', name: 'Void', host: '192.0.2.99' }, c, { cycle: 1 });
  assert.equal(r.status, STATUS.DOWN);
  assert.match(r.detail, /power, PoE and cabling/);
});

test('disabling every authoritative layer yields UNKNOWN, never DOWN', async () => {
  const c = cfg({ probe: { tcp: { enabled: false }, onvif: { enabled: false }, rtsp: { enabled: false }, vendor: { enabled: false } } });
  const r = await probeCamera({ id: 'x', name: 'Void', host: '192.0.2.99' }, c, { cycle: 1 });
  assert.equal(r.status, STATUS.UNKNOWN);
});

test('snapshot analysis flags a black frame as degraded', async (t) => {
  const dir = '/tmp/claude-0/-home-user-DBEDC-Corridor-Vision-Chrome-Plugin/65688936-9d30-5790-a171-efe0e09860bc/scratchpad/jpegs';
  if (!fs.existsSync(`${dir}/black.jpg`)) return t.skip('reference JPEGs not generated');
  const cam = await startFakeCamera({ jpeg: fs.readFileSync(`${dir}/black.jpg`), requireAuth: false });
  t.after(() => cam.stop());
  const { snapshotProbe } = await import('../src/probe/snapshot.mjs');
  const r = await snapshotProbe(
    { id: 'c', host: '127.0.0.1', httpPort: cam.httpPort, snapshotUrl: `http://127.0.0.1:${cam.httpPort}/snapshot` },
    { blackLumaMax: 18, blurVarianceMin: 12, minBytes: 100 },
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.degraded, true);
  assert.equal(r.verdict, 'black');
  assert.ok(r.meanLuma <= 18);
});

test('snapshot analysis detects a frozen frame across cycles', async (t) => {
  const dir = '/tmp/claude-0/-home-user-DBEDC-Corridor-Vision-Chrome-Plugin/65688936-9d30-5790-a171-efe0e09860bc/scratchpad/jpegs';
  if (!fs.existsSync(`${dir}/scene.jpg`)) return t.skip('reference JPEGs not generated');
  const cam = await startFakeCamera({ jpeg: fs.readFileSync(`${dir}/scene.jpg`), requireAuth: false });
  t.after(() => cam.stop());
  const { snapshotProbe } = await import('../src/probe/snapshot.mjs');
  const opts = { blackLumaMax: 18, blurVarianceMin: 12, minBytes: 100, frozenCycles: 3 };
  let history = {};
  let last;
  for (let i = 0; i < 4; i++) {
    last = await snapshotProbe({ id: 'c', host: '127.0.0.1', snapshotUrl: `http://127.0.0.1:${cam.httpPort}/snapshot` }, { ...opts, history });
    history = last.history;
  }
  assert.equal(last.verdict, 'frozen', 'the same image four cycles running is a wedged encoder');
  assert.equal(last.degraded, true);
});

test('a healthy varied image is not flagged', async (t) => {
  const dir = '/tmp/claude-0/-home-user-DBEDC-Corridor-Vision-Chrome-Plugin/65688936-9d30-5790-a171-efe0e09860bc/scratchpad/jpegs';
  if (!fs.existsSync(`${dir}/scene.jpg`)) return t.skip('reference JPEGs not generated');
  const cam = await startFakeCamera({ jpeg: fs.readFileSync(`${dir}/scene.jpg`), requireAuth: false });
  t.after(() => cam.stop());
  const { snapshotProbe } = await import('../src/probe/snapshot.mjs');
  const r = await snapshotProbe({ id: 'c', host: '127.0.0.1', snapshotUrl: `http://127.0.0.1:${cam.httpPort}/snapshot` },
    { blackLumaMax: 18, blurVarianceMin: 12, minBytes: 100 });
  assert.equal(r.degraded, false, `verdict was ${r.verdict}`);
});

test('TCP distinguishes a refused port from an unreachable host', async () => {
  const refused = await tcpLadder('127.0.0.1', [9], 900);
  assert.equal(refused.hostAlive, true);
  assert.equal(refused.reason, 'service-down');
  const gone = await tcpLadder('192.0.2.99', [554], 900);
  assert.equal(gone.hostAlive, false);
});
