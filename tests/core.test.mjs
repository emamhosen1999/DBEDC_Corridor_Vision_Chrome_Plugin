import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fmtDuration, inWindow, parseHHMM, minuteOfDay, dayKey, fmtTime } from '../src/core/time.mjs';
import { deepMerge, validate, migrate, DEFAULTS, readJsonFile } from '../src/core/config.mjs';
import { mapPool, singleFlight, createMutex, retry, withTimeout } from '../src/core/pool.mjs';
import { parseChallenge, buildDigestHeader } from '../src/probe/digest.mjs';
import { parseCsv, mapColumns, normaliseCamera, deriveId, assignIds, isValidHost } from '../src/monitor/inventory.mjs';
import { buildOutageIntervals } from '../src/monitor/metrics.mjs';
import { expandCidr } from '../src/monitor/discovery.mjs';
import { analyseJpeg, hashDistance, readJpegHeader } from '../src/probe/jpeg.mjs';
import { parseSdp } from '../src/probe/rtsp.mjs';
import { buildStatusReport, renderAlert } from '../src/core/format.mjs';

const JPEG_DIR = '/tmp/claude-0/-home-user-DBEDC-Corridor-Vision-Chrome-Plugin/65688936-9d30-5790-a171-efe0e09860bc/scratchpad/jpegs';

/* ------------------------------------------------------------------ time --- */

test('durations stay readable past a day (audit finding M2)', () => {
  assert.equal(fmtDuration(45_000), '45s');
  assert.equal(fmtDuration(90 * 60_000), '1h 30m');
  assert.equal(fmtDuration(121.5 * 3_600_000), '5d 1h');   // v1 rendered this as "121h 30m"
  assert.equal(fmtDuration(-1), '—');
  assert.equal(fmtDuration(NaN), '—');
});

test('quiet-hours windows handle midnight wrap', () => {
  const tz = 'Asia/Dhaka';
  const at = (iso) => Date.parse(iso);
  assert.ok(inWindow(at('2026-09-12T17:30:00Z'), '22:00', '07:00', tz), '23:30 local is inside 22:00-07:00');
  assert.ok(inWindow(at('2026-09-12T00:30:00Z'), '22:00', '07:00', tz), '06:30 local is inside');
  assert.ok(!inWindow(at('2026-09-12T06:00:00Z'), '22:00', '07:00', tz), '12:00 local is outside');
  assert.ok(inWindow(at('2026-09-12T06:00:00Z'), '09:00', '17:00', tz), 'non-wrapping window');
});

test('HH:MM parsing rejects nonsense', () => {
  assert.equal(parseHHMM('09:30'), 570);
  assert.equal(parseHHMM('00:00'), 0);
  assert.equal(parseHHMM('23:59'), 1439);
  assert.equal(parseHHMM('24:00'), null);
  assert.equal(parseHHMM('9:60'), null);
  assert.equal(parseHHMM('nope'), null);
});

test('timestamps render in the SITE timezone, not the host one (audit finding M3)', () => {
  const ts = Date.parse('2026-09-12T18:30:00Z');
  assert.equal(fmtTime(ts, 'Asia/Dhaka'), '2026-09-13 00:30');
  assert.equal(fmtTime(ts, 'UTC'), '2026-09-12 18:30');
  assert.equal(dayKey(ts, 'Asia/Dhaka'), '2026-09-13');
  assert.equal(minuteOfDay(ts, 'Asia/Dhaka'), 30);
});

/* ---------------------------------------------------------------- config --- */

test('deep merge preserves untouched branches and replaces arrays', () => {
  const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2, 3] }, { a: { c: 9 }, list: [7] });
  assert.deepEqual(merged, { a: { b: 1, c: 9 }, list: [7] });
});

test('config validation catches the mistakes that silently disable alerting', () => {
  const bad = deepMerge(DEFAULTS, {
    site: { timezone: 'Nowhere/Land' },
    server: { port: 70000 },
    monitor: { intervalSec: 2 },
    alerts: { minSeverity: 'urgent', quietHours: { enabled: true, from: '25:00', to: 'x' }, digest: { times: ['9am'] } },
  });
  const { errors } = validate(bad);
  assert.ok(errors.some((e) => /timezone/.test(e)));
  assert.ok(errors.some((e) => /server.port/.test(e)));
  assert.ok(errors.some((e) => /intervalSec/.test(e)));
  assert.ok(errors.some((e) => /minSeverity/.test(e)));
  assert.ok(errors.some((e) => /quietHours.from/.test(e)));
  assert.ok(errors.some((e) => /digest.times/.test(e)));
});

test('config refuses to expose an unauthenticated dashboard off loopback', () => {
  const { errors } = validate(deepMerge(DEFAULTS, { server: { host: '0.0.0.0', accessToken: '' } }));
  assert.ok(errors.some((e) => /accessToken is required/.test(e)));
  assert.equal(validate(deepMerge(DEFAULTS, { server: { host: '0.0.0.0', accessToken: 'abc' } })).errors.length, 0);
});

test('config warns when confirmDownCycles disables flap protection', () => {
  const { warnings } = validate(deepMerge(DEFAULTS, { detect: { confirmDownCycles: 1 } }));
  assert.ok(warnings.some((w) => /flap protection/.test(w)));
});

test('config requires at least one authoritative probe layer', () => {
  const { errors } = validate(deepMerge(DEFAULTS, {
    probe: { tcp: { enabled: false }, onvif: { enabled: false }, rtsp: { enabled: false }, vendor: { enabled: false } },
  }));
  assert.ok(errors.some((e) => /authoritative probe layer/.test(e)));
});

test('v1 config is migrated rather than rejected', () => {
  const out = migrate({ pollMinutes: 10, siteName: 'Old Site' });
  assert.equal(out.monitor.intervalSec, 600);
  assert.equal(out.site.name, 'Old Site');
  assert.equal(out.version, 2);
});

/* ------------------------------------------------------------------ pool --- */

test('mapPool respects the concurrency limit and isolates failures', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapPool(Array.from({ length: 30 }, (_, i) => i), 5, async (n) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (n === 7) throw new Error('boom');
    return n;
  });
  assert.ok(peak <= 5, `peak concurrency was ${peak}`);
  assert.equal(out.filter((r) => r.ok).length, 29);
  assert.equal(out[7].ok, false);
});

test('singleFlight collapses overlapping calls (the fix for audit finding B3)', async () => {
  let runs = 0;
  const fn = singleFlight(async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return runs; });
  await Promise.all([fn(), fn(), fn(), fn()]);
  assert.equal(runs, 1);
});

test('mutex serialises read-modify-write so no update is lost', async () => {
  const lock = createMutex();
  let counter = 0;
  await Promise.all(Array.from({ length: 40 }, () => lock(async () => {
    const read = counter;
    await new Promise((r) => setTimeout(r, 1));
    counter = read + 1;
  })));
  assert.equal(counter, 40, 'without the mutex this loses updates');
});

test('retry backs off and eventually gives up', async () => {
  let attempts = 0;
  await assert.rejects(() => retry(async () => { attempts++; throw new Error('nope'); }, { attempts: 4, baseMs: 1 }));
  assert.equal(attempts, 4);
  attempts = 0;
  const value = await retry(async () => { if (++attempts < 3) throw new Error('nope'); return 'ok'; }, { attempts: 5, baseMs: 1 });
  assert.equal(value, 'ok');
});

test('withTimeout rejects rather than hanging', async () => {
  await assert.rejects(() => withTimeout(new Promise(() => {}), 30, 'stuck probe'), /TIMEOUT: stuck probe/);
});

/* ---------------------------------------------------------------- digest --- */

test('digest auth matches the RFC 2617 reference vector', () => {
  const header = buildDigestHeader({
    username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html',
    params: { realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', qop: 'auth' },
    nc: 1, cnonce: '0a4f113b',
  });
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
});

test('digest challenge parsing tolerates vendor spacing and escapes', () => {
  const c = parseChallenge('Digest  realm="IP Camera", qop="auth,auth-int" , nonce=abc123, algorithm=MD5-sess');
  assert.equal(c.scheme, 'digest');
  assert.equal(c.params.realm, 'IP Camera');
  assert.equal(c.params.nonce, 'abc123');
  assert.equal(c.params.algorithm, 'MD5-sess');
});

/* ------------------------------------------------------------- inventory --- */

test('CSV parsing handles quotes, embedded commas, CRLF and a BOM', () => {
  const rows = parseCsv('﻿a,b\r\n"x,1","say ""hi"""\r\n\r\np,q\n');
  assert.deepEqual(rows, [['a', 'b'], ['x,1', 'say "hi"'], ['p', 'q']]);
});

test('column mapping accepts AIV-MP headers and common variants', () => {
  assert.deepEqual(mapColumns(['Camera', 'Organization', 'IP', 'Device', 'Status']), { name: 0, group: 1, host: 2, model: 3 });
  const m = mapColumns(['Camera Name', 'Zone', 'IP Address', 'RTSP Port']);
  assert.equal(m.name, 0); assert.equal(m.group, 1); assert.equal(m.host, 2); assert.equal(m.rtspPort, 3);
});

test('invalid rows are rejected with a reason, not silently dropped', () => {
  assert.ok(normaliseCamera({ name: 'x' }).errors.some((e) => /missing IP/.test(e)));
  assert.ok(normaliseCamera({ name: 'x', host: '999.1.1.1' }).errors.some((e) => /invalid IP/.test(e)));
  assert.ok(normaliseCamera({ name: 'x', host: '10.0.0.1', rtspPort: '70000' }).errors.some((e) => /rtspPort/.test(e)));
});

test('an unqualified hostname is accepted but flagged', () => {
  const { errors, warnings } = normaliseCamera({ name: 'x', host: 'cam-3' });
  assert.equal(errors.length, 0);
  assert.ok(warnings.some((w) => /unqualified name/.test(w)));
});

test('host validation', () => {
  assert.ok(isValidHost('192.168.1.1'));
  assert.ok(isValidHost('cam.example.com'));
  assert.ok(!isValidHost('999.1.1.1'));
  assert.ok(!isValidHost(''));
});

test('identity prefers serial, then host, and survives a rename (audit finding B2)', () => {
  assert.equal(deriveId({ id: 'X1' }).keySource, 'explicit');
  assert.equal(deriveId({ serial: 'SN-123', host: '10.0.0.1' }).id, 'sn-sn-123');
  assert.equal(deriveId({ host: '10.0.0.1', name: 'Gate' }).id, 'ip-10.0.0.1');
  // Renaming must NOT change the id — that was the v1 bug.
  assert.equal(deriveId({ host: '10.0.0.1', name: 'Gate' }).id, deriveId({ host: '10.0.0.1', name: 'Gate Renamed' }).id);
});

test('cameras sharing one NVR address get distinct ids', () => {
  const { cameras, collisions } = assignIds([
    { name: 'Ch1', host: '10.0.0.9', rtspPort: 554, keySource: 'host', id: 'ip-10.0.0.9' },
    { name: 'Ch2', host: '10.0.0.9', rtspPort: 555, keySource: 'host', id: 'ip-10.0.0.9' },
    { name: 'Solo', host: '10.0.0.8', keySource: 'host', id: 'ip-10.0.0.8' },
  ]);
  assert.equal(new Set(cameras.map((c) => c.id)).size, 3);
  assert.equal(collisions.length, 2);
  assert.equal(cameras[2].id, 'ip-10.0.0.8', 'a camera with a unique address keeps its plain id');
});

/* ----------------------------------------------------------------- other --- */

test('CIDR expansion and its guard rails', () => {
  assert.equal(expandCidr('192.168.1.0/24').length, 254);
  assert.deepEqual(expandCidr('10.1.2.0/30'), ['10.1.2.1', '10.1.2.2']);
  assert.throws(() => expandCidr('10.0.0.0/8'), /prefix must be/);
  assert.throws(() => expandCidr('192.168.1.0'), /valid IPv4 CIDR/);
  assert.throws(() => expandCidr('300.1.1.1/24'), /octet above 255|valid IPv4/);
});

test('outage intervals handle outages that straddle the window boundary', () => {
  const since = 1000; const until = 101_000;
  const intervals = buildOutageIntervals(
    [{ ts: 21_000, type: 'camera.down', cameraId: 'a' }, { ts: 41_000, type: 'camera.up', cameraId: 'a' },
     { ts: 31_000, type: 'camera.up', cameraId: 'b' }],
    { sinceTs: since, untilTs: until, currentStates: { c: { status: 'down', since: 0 } } },
  );
  assert.deepEqual(intervals.get('a'), [[21_000, 41_000]], 'a plain outage inside the window');
  assert.deepEqual(intervals.get('b'), [[1000, 31_000]], 'recovery first means it was already down');
  assert.deepEqual(intervals.get('c'), [[1000, 101_000]], 'still down, no events at all');
});

test('SDP parsing extracts codec, resolution and framerate', () => {
  const p = parseSdp('v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=x-dimensions:1280,720\r\n');
  assert.equal(p.videoCodec, 'H264');
  assert.equal(p.videoDimensions, '1280x720');
  assert.equal(p.hasVideo, true);
  assert.equal(p.hasAudio, false);
});

test('JPEG analysis measures luminance accurately', { skip: !fs.existsSync(`${JPEG_DIR}/black.jpg`) }, () => {
  const read = (n) => analyseJpeg(fs.readFileSync(`${JPEG_DIR}/${n}.jpg`));
  assert.ok(read('black').meanLuma <= 1, 'a black frame must measure near zero');
  assert.ok(Math.abs(read('grey').meanLuma - 128) < 2);
  assert.ok(read('white').meanLuma >= 253);
  assert.ok(read('scene').variance > 50, 'a real scene has structure');
  assert.equal(read('grey').variance, 0, 'a flat frame has no structure');
});

test('JPEG restart markers and greyscale JPEGs decode correctly', { skip: !fs.existsSync(`${JPEG_DIR}/restart.jpg`) }, () => {
  const plain = analyseJpeg(fs.readFileSync(`${JPEG_DIR}/scene.jpg`));
  const restart = analyseJpeg(fs.readFileSync(`${JPEG_DIR}/restart.jpg`));
  const grey1c = analyseJpeg(fs.readFileSync(`${JPEG_DIR}/gray1c.jpg`));
  assert.equal(restart.dHash, plain.dHash, 'restart markers must not change the decoded image');
  assert.equal(grey1c.dHash, plain.dHash, 'a 1-component JPEG of the same scene decodes the same');
});

test('progressive JPEGs are refused, not silently mis-measured', { skip: !fs.existsSync(`${JPEG_DIR}/progressive.jpg`) }, () => {
  const r = analyseJpeg(fs.readFileSync(`${JPEG_DIR}/progressive.jpg`));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'progressive');
  assert.equal(r.width, 640, 'dimensions are still reported');
});

test('non-JPEG input is rejected', () => {
  assert.equal(readJpegHeader(Buffer.from('not an image')).ok, false);
  assert.equal(analyseJpeg(Buffer.from([0x89, 0x50, 0x4e, 0x47])).reason, 'not-jpeg');
});

test('frame hashing separates a frozen stream from a live one', { skip: !fs.existsSync(`${JPEG_DIR}/scene.jpg`) }, () => {
  const a = analyseJpeg(fs.readFileSync(`${JPEG_DIR}/scene.jpg`));
  const b = analyseJpeg(fs.readFileSync(`${JPEG_DIR}/scene2.jpg`));
  const c = analyseJpeg(fs.readFileSync(`${JPEG_DIR}/noise.jpg`));
  assert.equal(hashDistance(a.dHash, b.dHash), 0, 'an unchanged picture hashes identically');
  assert.ok(hashDistance(a.dHash, c.dHash) > 10, 'a different picture hashes differently');
});

/* ---------------------------------------------------------------- format --- */

test('the three report shapes all render and carry the right facts', () => {
  const cfg = deepMerge(DEFAULTS, {});
  const fleet = {
    total: 4, up: 2, down: 1, degraded: 1, unknown: 0, flapping: 0, healthyPct: 50,
    groups: [{ name: 'Zone 1', total: 2, up: 2, down: 0, degraded: 0, unknown: 0 },
             { name: 'Zone 3', total: 2, up: 0, down: 1, degraded: 1, unknown: 0 }],
  };
  const cameras = [
    { name: 'A', group: 'Zone 1', status: 'up', since: Date.now() },
    { name: 'B', group: 'Zone 3', status: 'down', downtimeMs: 3_600_000, detail: 'no response on any port' },
    { name: 'C', group: 'Zone 3', status: 'degraded', downtimeMs: 600_000, detail: 'image black' },
  ];
  const full = buildStatusReport({ fleet, cameras, cfg, fmt: 'full' });
  assert.match(full, /2\/4 devices serving video/);
  assert.match(full, /B .*down 1h/s);
  assert.match(full, /No video at all: Zone 3/);

  const offline = buildStatusReport({ fleet, cameras, cfg, fmt: 'offline' });
  assert.ok(!offline.includes('\nA'), 'the offline report must not list healthy cameras');
  assert.match(offline, /B/);

  const summary = buildStatusReport({ fleet, cameras, cfg, fmt: 'summary' });
  assert.match(summary, /Total 4/);
  assert.match(summary, /50% up/);
});

test('an all-healthy report says so plainly', () => {
  const cfg = deepMerge(DEFAULTS, {});
  const fleet = { total: 2, up: 2, down: 0, degraded: 0, unknown: 0, flapping: 0, healthyPct: 100, groups: [{ name: 'Z', total: 2, up: 2, down: 0, degraded: 0, unknown: 0 }] };
  assert.match(buildStatusReport({ fleet, cameras: [], cfg, fmt: 'full' }), /✅ All cameras online/);
});

test('the watchdog alert warns that displayed status is stale', () => {
  const { text } = renderAlert({ type: 'monitor.stalled', staleMs: 7_200_000, lastOkAt: Date.now() - 7_200_000, at: Date.now() }, deepMerge(DEFAULTS, {}));
  assert.match(text, /MONITORING HAS STOPPED/);
  assert.match(text, /STALE and must not be trusted/);
});

test('every alert type renders without throwing', () => {
  const cfg = deepMerge(DEFAULTS, {});
  const samples = [
    { type: 'camera.down', name: 'A', group: 'Z', host: '1.1.1.1' },
    { type: 'camera.degraded', name: 'A', warnings: ['storage failed'] },
    { type: 'camera.up', name: 'A', downtimeMs: 1000 },
    { type: 'camera.recovered', name: 'A', downtimeMs: 1000 },
    { type: 'camera.flapping', name: 'A', changes: 5, windowMin: 30 },
    { type: 'camera.stable', name: 'A' },
    { type: 'camera.escalation', name: 'A', status: 'down', since: Date.now() - 1000, downtimeMs: 1000 },
    { type: 'site.groupDown', group: 'Z', total: 5 },
    { type: 'site.groupRecovered', group: 'Z' },
    { type: 'site.massOutage', total: 10, down: 5, degraded: 0, pct: 50 },
    { type: 'site.massOutageCleared', total: 10, down: 0, degraded: 0 },
    { type: 'monitor.stalled', staleMs: 1000 },
    { type: 'monitor.recovered', gapMs: 1000, gapFrom: Date.now() - 1000, gapTo: Date.now() },
    { type: 'monitor.networkDown' }, { type: 'monitor.networkUp' },
    { type: 'monitor.diskLow', freePct: 3 },
    { type: 'monitor.started', cameras: 5, intervalSec: 60 },
    { type: 'inventory.added', name: 'A', host: '1.1.1.1' },
    { type: 'inventory.removed', name: 'A', host: '1.1.1.1' },
    { type: 'sla.breach', uptimePct: 91, targetPct: 95, worst: [{ name: 'A', uptimePct: 50, outages: 3 }] },
    { type: 'channel.test', channel: 'telegram' },
    { type: 'alerts.rateLimited', channel: 'telegram', max: 30 },
  ];
  for (const s of samples) {
    const r = renderAlert({ ...s, at: Date.now() }, cfg);
    assert.ok(r.title && r.text, `${s.type} produced an empty message`);
    assert.ok(r.text.includes(cfg.site.name), `${s.type} lost the site footer`);
  }
});

/* ------------------------------------------------- config file encoding --- */

test('config JSON loads despite a UTF-8 BOM (Windows commissioning)', () => {
  // Windows PowerShell 5.1's `Set-Content -Encoding UTF8` and Notepad both prepend
  // U+FEFF. scripts/setup.ps1 did exactly that, and the config it wrote could not be
  // parsed at all - `doctor`, `run` and `selftest` every one refused to start.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-bom-'));
  const file = path.join(dir, 'config.json');
  try {
    const body = JSON.stringify({ site: { name: 'Dhaka Bypass Expressway' } }, null, 2);

    fs.writeFileSync(file, `﻿${body}`, 'utf8');
    assert.throws(() => JSON.parse(fs.readFileSync(file, 'utf8')), 'a BOM really does break JSON.parse');
    assert.equal(readJsonFile(file).site.name, 'Dhaka Bypass Expressway');

    fs.writeFileSync(file, body, 'utf8');
    assert.equal(readJsonFile(file).site.name, 'Dhaka Bypass Expressway', 'still fine without a BOM');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------- AIV-MP / VPAASPlat CSV shape --- */

// The real DBEDC export ("Camera Information_*.xlsx" -> CSV). Header spellings here
// are verbatim from the platform; each one of these mappings was wrong before.
const AIVMP_HEADERS = [
  'Camera ID', 'Third-Party Camera ID', 'Interconnection Code', 'Camera Name',
  'Main Device ID', 'Third-Party Main Device ID', 'Main Device Name', 'Platform ID',
  'Platform Name', 'Registration Status', 'Organization ID', 'Organization Name',
  'Administrative Area Code', 'Tenant ID', 'Tenant Name', 'Channel Number',
  'mainDev Interconnect Code', 'IP Address', 'Access Server IP', 'Access Server Port',
  'Device Manufacturer', 'Device Model', 'PTZ Type', 'Remarks',
];

test('AIV-MP "Organization Name" maps to the zone, not Ungrouped', () => {
  const map = mapColumns(AIVMP_HEADERS);
  assert.equal(map.group, 11, 'Organization Name is the zone');
  assert.equal(map.host, 17, 'IP Address is the host');
  assert.equal(map.name, 3);
  // "Organization ID" precedes "Organization Name" and must not win the group slot.
  assert.notEqual(map.group, 10);
});

test('a zone-less import would disable the zone-dark alarm, so group must survive', () => {
  const { camera } = normaliseCamera({
    name: 'K04+600 HD Box Camera East',
    host: '11.151.11.115',
    group: 'Dhaka Bypass Expressway/Fixed Bullet Cameras/EastBound K4 To K26',
  });
  assert.equal(camera.group, 'Dhaka Bypass Expressway/Fixed Bullet Cameras/EastBound K4 To K26');
  assert.notEqual(camera.group, 'Ungrouped');
});

test('a placeholder manufacturer is not treated as a vendor', () => {
  // AIV-MP writes "Others" for all 162 DBEDC cameras. Storing that as the make would
  // shadow the --vendor default and put a fake manufacturer in the device register.
  for (const placeholder of ['Others', 'Unknown', 'N/A', 'none', '-']) {
    const { camera } = normaliseCamera({ name: 'c', host: '11.151.11.115', vendor: placeholder });
    assert.equal(camera.vendor, null, `${placeholder} should not be a vendor`);
  }
  const withDefault = normaliseCamera(
    { name: 'c', host: '11.151.11.115', vendor: 'Others' }, { defaults: { vendor: 'uniview' } },
  ).camera;
  assert.equal(withDefault.vendor, 'uniview', 'the default still applies through a placeholder');

  // A real manufacturer is still honoured.
  assert.equal(normaliseCamera({ name: 'c', host: '1.2.3.4', vendor: 'Uniview' }).camera.vendor, 'uniview');
});
