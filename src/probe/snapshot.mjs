/**
 * Layer 4 — snapshot and image-quality analysis.
 *
 * This catches the failure mode nothing else does: a camera that is powered,
 * reachable, ONVIF-healthy, serving RTSP, and reported `status: 1` by the VMS —
 * whose picture is black, frozen, or looking at a wall.
 *
 * It is deliberately the most expensive layer and runs every Nth cycle, not every
 * cycle. Pulling a full JPEG from 500 cameras every minute would put more load on the
 * corridor network than the monitoring is worth.
 *
 * Verdicts:
 *   black   — mean luma below threshold (IR cut filter stuck, dead sensor, no light)
 *   flat    — near-zero variance (lens covered, fogged, painted, facing a wall)
 *   frozen  — the same frame hash for N consecutive samples (encoder wedged)
 *   tiny    — an implausibly small payload (error placeholder rather than a frame)
 */
import { digestFetch } from './digest.mjs';
import { analyseJpeg, hashDistance } from './jpeg.mjs';
import { onvifSnapshotUri } from './onvif.mjs';
import { getAdapter } from './vendor/index.mjs';

const MAX_BYTES = 8 * 1024 * 1024; // a camera returning a 4K JPEG is normal; 8 MB is not

/** Fetch a JPEG, capped so a misbehaving device cannot exhaust memory. */
async function fetchImage(url, { username, password, timeoutMs }) {
  const res = await digestFetch(url, { username, password, timeoutMs });
  if (res.status === 401) return { ok: false, reason: 'auth' };
  if (!res.ok) return { ok: false, reason: `http-${res.status}` };

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) return { ok: false, reason: 'too-large' };

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) return { ok: false, reason: 'too-large' };

  const type = res.headers.get('content-type') ?? '';
  if (type && !/jpe?g|octet-stream|image/i.test(type)) return { ok: false, reason: 'not-an-image', contentType: type };
  return { ok: true, buf };
}

/** Build the candidate snapshot URLs for a camera, best-known first. */
export async function resolveSnapshotUrl(camera, opts) {
  if (camera.snapshotUrl) return { url: camera.snapshotUrl, via: 'configured' };

  // The camera's own answer beats any guess.
  const onvif = await onvifSnapshotUri(camera.host, {
    port: camera.onvifPort ?? 80, username: opts.username, password: opts.password, timeoutMs: opts.timeoutMs,
  });
  if (onvif.ok && onvif.uri) return { url: onvif.uri, via: 'onvif' };

  const adapter = getAdapter(camera.vendor);
  const paths = adapter?.snapshotPaths ?? ['/onvif-http/snapshot?Profile_1', '/snapshot.jpg', '/image/jpeg.cgi'];
  return { url: `http://${camera.host}:${camera.httpPort ?? 80}${paths[0]}`, via: 'guess', alternatives: paths.slice(1).map((p) => `http://${camera.host}:${camera.httpPort ?? 80}${p}`) };
}

/**
 * Probe a camera's image.
 * `history` is the camera's previous snapshot record — `{ dHash, frozenCount }` —
 * and is returned updated so the caller can persist it.
 */
export async function snapshotProbe(camera, {
  username, password, timeoutMs = 6000,
  blackLumaMax = 18, blurVarianceMin = 12, minBytes = 2048, frozenCycles = 3,
  history = {},
} = {}) {
  const started = Date.now();
  const resolved = await resolveSnapshotUrl(camera, { username, password, timeoutMs });
  const candidates = [resolved.url, ...(resolved.alternatives ?? [])];

  let image = null;
  let usedUrl = null;
  let lastReason = 'no-snapshot-url';
  for (const url of candidates) {
    const r = await fetchImage(url, { username, password, timeoutMs });
    if (r.ok) { image = r.buf; usedUrl = url; break; }
    lastReason = r.reason;
    if (r.reason === 'auth') break;  // trying other paths with bad credentials is pointless
  }

  if (!image) {
    return { ok: false, reason: lastReason, via: resolved.via, latencyMs: Date.now() - started, history };
  }

  if (image.length < minBytes) {
    return {
      ok: false, verdict: 'tiny', reason: 'implausibly-small-image', bytes: image.length,
      url: usedUrl, latencyMs: Date.now() - started, history,
    };
  }

  const stats = analyseJpeg(image);
  const latencyMs = Date.now() - started;

  if (!stats.ok) {
    // Progressive JPEG or an unusual encoder: fall back to identity-only checks so we
    // still detect a frozen stream, and say plainly that luma analysis was skipped.
    const frozen = history.dHash && history.byteHash === hashBytes(image);
    const frozenCount = frozen ? (history.frozenCount ?? 0) + 1 : 0;
    return {
      ok: true, degraded: frozenCount >= frozenCycles,
      verdict: frozenCount >= frozenCycles ? 'frozen' : 'ok',
      analysis: 'bytes-only', reason: stats.reason, bytes: image.length, url: usedUrl, latencyMs,
      history: { byteHash: hashBytes(image), frozenCount, lastAt: Date.now(), dHash: history.dHash ?? null },
    };
  }

  const distance = history.dHash ? hashDistance(history.dHash, stats.dHash) : null;
  const isSameFrame = distance !== null && distance === 0;
  const frozenCount = isSameFrame ? (history.frozenCount ?? 0) + 1 : 0;

  const problems = [];
  if (stats.meanLuma <= blackLumaMax) problems.push('black');
  else if (stats.meanLuma >= 255 - blackLumaMax) problems.push('washed-out');
  if (stats.variance < blurVarianceMin) problems.push('flat');
  if (frozenCount >= frozenCycles) problems.push('frozen');

  return {
    ok: true,
    degraded: problems.length > 0,
    verdict: problems[0] ?? 'ok',
    problems,
    url: usedUrl, via: resolved.via, latencyMs,
    bytes: image.length,
    width: stats.width, height: stats.height,
    meanLuma: stats.meanLuma, variance: stats.variance, dHash: stats.dHash,
    frameDistance: distance,
    history: { dHash: stats.dHash, frozenCount, lastAt: Date.now(), meanLuma: stats.meanLuma },
  };
}

function hashBytes(buf) {
  // FNV-1a over a sample of the payload — enough to spot a byte-identical frame
  // without hashing several megabytes on every cycle.
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(buf.length / 4096));
  for (let i = 0; i < buf.length; i += step) { h ^= buf[i]; h = Math.imul(h, 0x01000193); }
  return ((h >>> 0).toString(16) + ':' + buf.length);
}
