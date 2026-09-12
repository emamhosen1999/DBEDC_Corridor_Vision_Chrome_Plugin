/**
 * Capture what a real camera actually speaks.
 *
 * The Uniview LAPI endpoints, RTSP path templates and snapshot URLs in this codebase
 * were written from vendor documentation and have never been checked against
 * hardware. This script does not assume any of them are right: it tries every
 * candidate, records the raw answer, and writes a JSON file you can hand back so the
 * adapter is fixed from evidence rather than from a second guess.
 *
 * It is READ-ONLY. Every request is a GET, a DESCRIBE or an ONVIF query; nothing is
 * configured, written or rebooted.
 *
 *   node scripts/capture-camera-evidence.mjs --host 11.151.11.114 \
 *        --user <camera-user> --pass <camera-password> --out evidence.json
 *
 * Credentials are used to talk to the camera and are NEVER written to the output.
 */
import fs from 'node:fs';
import net from 'node:net';
import { digestFetch } from '../src/probe/digest.mjs';
import { rtspProbe } from '../src/probe/rtsp.mjs';
import { onvifAlive, onvifDeviceInfo, onvifSnapshotUri, onvifStreamUri } from '../src/probe/onvif.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i];
}
const HOST = args.host;
const USER = args.user ?? '';
const PASS = args.pass ?? '';
const OUT = args.out ?? `evidence-${String(HOST).replace(/\./g, '-')}.json`;
const TIMEOUT = Number(args.timeout ?? 6000);

if (!HOST) {
  process.stdout.write('Usage: node scripts/capture-camera-evidence.mjs --host <ip> --user <u> --pass <p> [--out file.json]\n');
  process.exit(1);
}

const ev = { host: HOST, capturedAt: new Date().toISOString(), node: process.version, platform: process.platform, steps: {} };
const say = (m) => process.stdout.write(`${m}\n`);
/** Never let a credential reach the evidence file. */
const scrub = (s) => {
  let out = String(s ?? '');
  for (const secret of [PASS, USER].filter((x) => x && x.length > 2)) {
    out = out.split(secret).join('<redacted>');
  }
  return out.replace(/(response|nonce|cnonce|Digest\s+username)="[^"]*"/gi, '$1="<redacted>"');
};
const clip = (s, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n…[${s.length - n} more bytes]` : s);

/* ------------------------------------------------------------------ ports --- */
// Ports worth knowing about on a camera VLAN. 80/554 are the common pair; Uniview
// also answers on 8000/8080, and a GB/T 28181 registration says nothing about which.
const PORTS = [80, 81, 443, 554, 555, 2000, 5000, 8000, 8080, 8443, 8554, 8899, 9000, 37777];

function tcpCheck(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const t0 = Date.now();
    let done = false;
    const finish = (state, detail) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve({ port, state, ms: Date.now() - t0, detail: detail ?? null });
    };
    s.setTimeout(3000);
    s.once('connect', () => finish('open'));
    s.once('timeout', () => finish('filtered', 'no response'));
    s.once('error', (e) => finish(e.code === 'ECONNREFUSED' ? 'refused' : 'error', e.code));
    s.connect(port, HOST);
  });
}

/* ------------------------------------------------------------------- http --- */
async function httpTry(path, { port = 80, scheme = 'http', accept = 'application/json' } = {}) {
  const url = `${scheme}://${HOST}:${port}${path}`;
  try {
    const res = await digestFetch(url, { username: USER, password: PASS, timeoutMs: TIMEOUT, headers: { Accept: accept } });
    const type = res.headers.get('content-type') ?? '';
    const buf = Buffer.from(await res.arrayBuffer());
    const rec = {
      url: scrub(url), status: res.status, contentType: type, bytes: buf.length,
    };
    if (/image|octet-stream/i.test(type) || buf.slice(0, 2).toString('hex') === 'ffd8') {
      rec.looksLikeJpeg = buf.slice(0, 2).toString('hex') === 'ffd8';
      rec.body = `<binary ${buf.length} bytes, starts ${buf.slice(0, 4).toString('hex')}>`;
    } else {
      rec.body = clip(scrub(buf.toString('utf8')));
    }
    return rec;
  } catch (err) {
    return { url: scrub(url), error: scrub(err?.message ?? String(err)) };
  }
}

/* ------------------------------------------------------------------- main --- */
(async () => {
  say(`\nCorridor Vision — camera evidence capture\n  host: ${HOST}\n  user: ${USER ? `${USER.slice(0, 2)}…` : '(none)'}\n`);

  /* 1. What is listening at all? */
  say('1. TCP ports');
  ev.steps.ports = await Promise.all(PORTS.map(tcpCheck));
  const open = ev.steps.ports.filter((p) => p.state === 'open').map((p) => p.port);
  for (const p of ev.steps.ports) if (p.state !== 'refused') say(`   ${String(p.port).padEnd(6)} ${p.state}${p.detail ? ` (${p.detail})` : ''}`);
  say(`   open: ${open.length ? open.join(', ') : 'none'}`);
  if (!open.length) say('   NOTE: nothing open. Check you are on the camera VLAN before reading anything below.');

  // --http-port / --rtsp-port override the scan, for a camera on a non-standard port
  // or behind a port-forward.
  const httpPorts = args['http-port']
    ? [Number(args['http-port'])]
    : [...new Set([...open.filter((p) => [80, 81, 8000, 8080, 443, 8443].includes(p)), 80])];
  const onvifPort = httpPorts[0] ?? 80;

  /* 2. ONVIF — unauthenticated liveness, then the authoritative answers. */
  say('\n2. ONVIF');
  ev.steps.onvif = {};
  for (const port of httpPorts) {
    ev.steps.onvif[port] = {
      alive: await onvifAlive(HOST, { port, timeoutMs: TIMEOUT }).catch((e) => ({ error: String(e.message) })),
      deviceInfo: await onvifDeviceInfo(HOST, { port, username: USER, password: PASS, timeoutMs: TIMEOUT }).catch((e) => ({ error: String(e.message) })),
      streamUri: await onvifStreamUri(HOST, { port, username: USER, password: PASS, timeoutMs: TIMEOUT }).catch((e) => ({ error: String(e.message) })),
      snapshotUri: await onvifSnapshotUri(HOST, { port, username: USER, password: PASS, timeoutMs: TIMEOUT }).catch((e) => ({ error: String(e.message) })),
    };
    const o = ev.steps.onvif[port];
    say(`   :${port} alive=${o.alive?.ok === true} device=${o.deviceInfo?.ok === true}`
      + `${o.deviceInfo?.manufacturer ? ` (${o.deviceInfo.manufacturer} ${o.deviceInfo.model ?? ''})` : ''}`);
    if (o.streamUri?.ok) say(`   :${port} GetStreamUri  -> ${o.streamUri.uri}`);
    else say(`   :${port} GetStreamUri  -> failed (${o.streamUri?.reason ?? o.streamUri?.error})`);
    if (o.snapshotUri?.ok) say(`   :${port} GetSnapshotUri-> ${o.snapshotUri.uri}`);
  }

  /* 3. RTSP — the ONVIF answer first, then every path this codebase would guess. */
  say('\n3. RTSP DESCRIBE');
  const discovered = Object.values(ev.steps.onvif).map((o) => o.streamUri?.uri).filter(Boolean);
  const CANDIDATES = [
    '/media/video1', '/media/video2', '/unicast/c1/s0/live', '/unicast/c1/s1/live',
    '/cam/realmonitor?channel=1&subtype=0', '/Streaming/Channels/101', '/h264/ch1/main/av_stream',
    '/live/ch0', '/video1', '/stream1', '/profile1', '/ch01/0', '/1/h264major',
  ];
  const rtspPort = args['rtsp-port']
    ? Number(args['rtsp-port'])
    : (open.includes(554) ? 554 : (open.find((p) => [8554, 555].includes(p)) ?? 554));
  ev.steps.rtsp = { port: rtspPort, fromOnvif: [], templates: [] };

  for (const uri of discovered) {
    const r = await rtspProbe(HOST, { explicitUrl: uri, username: USER, password: PASS, timeoutMs: TIMEOUT });
    ev.steps.rtsp.fromOnvif.push({ uri: scrub(uri), ok: r.ok, reason: r.reason ?? null, codec: r.videoCodec ?? null, dimensions: r.videoDimensions ?? null, sdp: r.sdp ? clip(scrub(r.sdp), 2000) : null });
    say(`   ${r.ok ? 'OK  ' : 'FAIL'} (onvif) ${uri}${r.ok ? ` — ${r.videoCodec} ${r.videoDimensions}` : ` — ${r.reason}`}`);
  }
  for (const path of CANDIDATES) {
    const r = await rtspProbe(HOST, { port: rtspPort, paths: [path], username: USER, password: PASS, timeoutMs: TIMEOUT });
    ev.steps.rtsp.templates.push({ path, ok: r.ok, reason: r.reason ?? null, codec: r.videoCodec ?? null, dimensions: r.videoDimensions ?? null });
    say(`   ${r.ok ? 'OK  ' : 'fail'} ${path}${r.ok ? ` — ${r.videoCodec} ${r.videoDimensions}` : ` — ${r.reason}`}`);
  }

  /* 4. Uniview LAPI — every endpoint the adapter relies on, plus known alternates. */
  say('\n4. Uniview LAPI (and alternates)');
  const LAPI_PATHS = [
    '/LAPI/V1.0/System/DeviceInfo', '/LAPI/V1.0/System/Time', '/LAPI/V1.0/System/StorageInfo',
    '/LAPI/V1.0/System/DeviceBasicInfo', '/LAPI/V1.0/System/WorkingStatus',
    '/LAPI/V1.0/Channels/0/System/DeviceInfo', '/LAPI/V1.0/PeripheralManagement/DiskManagement/Disks',
    '/LAPI/V2.0/System/DeviceInfo',
    '/cgi-bin/main-cgi?json={"cmd":"getDeviceInfo"}', '/ISAPI/System/deviceInfo',
  ];
  ev.steps.lapi = {};
  for (const port of httpPorts) {
    ev.steps.lapi[port] = {};
    for (const path of LAPI_PATHS) {
      const r = await httpTry(path, { port });
      ev.steps.lapi[port][path] = r;
      const verdict = r.error ? `error ${r.error}` : `${r.status} ${r.contentType || ''} ${r.bytes}B`;
      if (!r.error && r.status < 400) say(`   :${port} ${path}\n        -> ${verdict}`);
    }
  }
  const anyLapi = Object.values(ev.steps.lapi).some((byPath) => Object.values(byPath).some((r) => !r.error && r.status < 400));
  if (!anyLapi) say('   nothing answered with a success status — see the JSON for every status code');

  /* 5. Snapshot URLs. */
  say('\n5. Snapshot candidates');
  const SNAP = [
    '/LAPI/V1.0/Channels/0/Media/Video/Streams/0/Snapshot', '/images/snapshot.jpg', '/cgi-bin/snapshot.cgi',
    '/onvif-http/snapshot?Profile_1', '/snapshot.jpg', '/image/jpeg.cgi', '/onvifsnapshot/media_service/snapshot?channel=1&subtype=0',
    ...Object.values(ev.steps.onvif).map((o) => o.snapshotUri?.uri).filter(Boolean),
  ];
  ev.steps.snapshot = {};
  for (const cand of SNAP) {
    const isAbsolute = /^https?:\/\//i.test(cand);
    const r = isAbsolute
      ? await (async () => {
        try {
          const res = await digestFetch(cand, { username: USER, password: PASS, timeoutMs: TIMEOUT });
          const buf = Buffer.from(await res.arrayBuffer());
          return { url: scrub(cand), status: res.status, contentType: res.headers.get('content-type') ?? '', bytes: buf.length, looksLikeJpeg: buf.slice(0, 2).toString('hex') === 'ffd8' };
        } catch (e) { return { url: scrub(cand), error: scrub(e.message) }; }
      })()
      : await httpTry(cand, { port: onvifPort, accept: 'image/jpeg' });
    ev.steps.snapshot[cand] = r;
    if (r.looksLikeJpeg) say(`   JPEG ${cand} (${r.bytes} bytes)`);
    else if (!r.error && r.status < 400) say(`   ${r.status}  ${cand} — ${r.contentType} ${r.bytes}B (not a JPEG)`);
  }

  fs.writeFileSync(OUT, JSON.stringify(ev, null, 2));
  say(`\nWritten: ${OUT}`);
  say('Credentials are not included. Review it, then send it back.\n');
})();
