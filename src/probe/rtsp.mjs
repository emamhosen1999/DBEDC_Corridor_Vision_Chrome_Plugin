/**
 * Layer 3 — RTSP handshake.
 *
 * This is the layer that answers the question the AIV-MP platform cannot: **does the
 * video actually serve?** A camera can be powered, pingable, ONVIF-responsive and
 * flagged `status: 1` by the VMS while its encoder has wedged and every stream
 * request fails. Operators discover this when they go looking for footage of an
 * incident and find nothing. By then it is too late.
 *
 * `DESCRIBE` returns the SDP, which also tells us codec, resolution and track layout
 * — so a camera that silently dropped from H.265 1080p to H.264 D1 (a classic symptom
 * of a factory reset after a power event) is caught as a configuration drift.
 *
 * Implemented on a raw socket: RTSP is HTTP-shaped but is not HTTP, and no HTTP client
 * will speak it.
 */
import net from 'node:net';
import tls from 'node:tls';
import { parseChallenge, buildDigestHeader } from './digest.mjs';

const CRLF = '\r\n';
const UA = 'CorridorVision/2.0 (health-probe)';

/** Split an RTSP response into status, headers and body. */
function parseResponse(raw) {
  const headEnd = raw.indexOf('\r\n\r\n');
  const head = headEnd === -1 ? raw : raw.slice(0, headEnd);
  const body = headEnd === -1 ? '' : raw.slice(headEnd + 4);
  const [statusLine, ...headerLines] = head.split(/\r?\n/);
  const m = /^RTSP\/1\.\d\s+(\d{3})\s*(.*)$/.exec(statusLine ?? '');
  const headers = {};
  for (const line of headerLines) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: m ? Number(m[1]) : 0, statusText: m ? m[2] : (statusLine ?? ''), headers, body };
}

/**
 * One RTSP conversation on one socket. Sends `OPTIONS`, then the requested method,
 * handling a 401 Digest challenge by re-issuing with credentials.
 */
function converse(host, port, url, { method = 'DESCRIBE', username, password, timeoutMs = 4000, secure = false } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = secure
      ? tls.connect({ host, port, rejectUnauthorized: false })
      : new net.Socket();
    let settled = false;
    let buffer = '';
    let stage = 'options';
    let cseq = 1;
    let challenge = null;
    let authNc = 0;          // Digest nonce-count: must increment per authenticated request
    let optionsInfo = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve({ latencyMs: Date.now() - started, ...result });
    };

    const send = (verb, extraHeaders = {}) => {
      const headers = { CSeq: String(cseq++), 'User-Agent': UA, ...extraHeaders };
      if (challenge && username) {
        headers.Authorization = challenge.scheme === 'digest'
          ? buildDigestHeader({ username, password, method: verb, uri: url, params: challenge.params, nc: ++authNc })
          : `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
      }
      const lines = [`${verb} ${url} RTSP/1.0`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''];
      socket.write(lines.join(CRLF));
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish({ ok: false, reason: 'timeout', detail: `no RTSP response within ${timeoutMs}ms`, stage }));
    socket.once('error', (err) => finish({
      ok: false,
      reason: err.code === 'ECONNREFUSED' ? 'refused' : err.code === 'EHOSTUNREACH' ? 'unreachable' : 'error',
      detail: err.code || err.message,
      stage,
    }));
    socket.once('close', () => finish({ ok: false, reason: 'closed', detail: 'camera closed the connection', stage }));

    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      if (!buffer.includes('\r\n\r\n')) return;

      const res = parseResponse(buffer);
      // Wait for the full body when Content-Length says there is more to come.
      const declared = Number(res.headers['content-length'] ?? 0);
      if (declared && Buffer.byteLength(res.body, 'latin1') < declared) return;
      buffer = '';

      const staleNonce = res.status === 401 && /stale\s*=\s*"?true/i.test(res.headers['www-authenticate'] ?? '');
      if (res.status === 401 && username && (!challenge || staleNonce)) {
        challenge = parseChallenge(res.headers['www-authenticate']);
        authNc = 0;
        if (!challenge) return finish({ ok: false, reason: 'auth', detail: '401 without a usable challenge', stage });
        send(stage === 'options' ? 'OPTIONS' : method, stage === 'options' ? {} : { Accept: 'application/sdp' });
        return;
      }
      if (res.status === 401) {
        return finish({ ok: false, hostAlive: true, reason: 'auth', detail: 'credentials rejected', status: 401, stage });
      }

      if (stage === 'options') {
        optionsInfo = { status: res.status, methods: res.headers.public ?? '', server: res.headers.server ?? null };
        if (res.status !== 200) {
          // A non-200 OPTIONS still proves an RTSP server answered.
          return finish({ ok: false, hostAlive: true, reason: `rtsp-${res.status}`, detail: res.statusText, ...optionsInfo, stage });
        }
        if (method === 'OPTIONS') return finish({ ok: true, ...optionsInfo, stage: 'options' });
        stage = 'describe';
        // Keep the challenge: cameras that allow OPTIONS anonymously almost always
        // 401 on DESCRIBE, and reusing the nonce saves a whole round trip per camera.
        send(method, { Accept: 'application/sdp' });
        return;
      }

      if (res.status !== 200) {
        return finish({
          ok: false, hostAlive: true, status: res.status,
          reason: res.status === 404 ? 'no-such-stream' : `rtsp-${res.status}`,
          detail: res.statusText, ...optionsInfo, stage,
        });
      }
      finish({ ok: true, status: 200, ...optionsInfo, sdp: res.body, ...parseSdp(res.body), stage: 'describe' });
    });

    const onConnect = () => send('OPTIONS');
    if (secure) socket.once('secureConnect', onConnect);
    else socket.connect(port, host, onConnect);
  });
}

/** Extract the facts worth alerting on from an SDP payload. */
export function parseSdp(sdp = '') {
  const media = [];
  let current = null;
  for (const line of String(sdp).split(/\r?\n/)) {
    const m = /^m=(\w+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) {
      current = { kind: m[1], payloads: m[4].split(/\s+/), codec: null, clockRate: null, dimensions: null, framerate: null };
      media.push(current);
      continue;
    }
    if (!current) continue;
    const rtpmap = /^a=rtpmap:\d+\s+([\w-]+)\/(\d+)/.exec(line);
    if (rtpmap) { current.codec = rtpmap[1]; current.clockRate = Number(rtpmap[2]); continue; }
    const dims = /^a=x-dimensions:\s*(\d+)\s*,\s*(\d+)/.exec(line);
    if (dims) { current.dimensions = `${dims[1]}x${dims[2]}`; continue; }
    const fr = /^a=framerate:\s*([\d.]+)/.exec(line) ?? /^a=x-framerate:\s*([\d.]+)/.exec(line);
    if (fr) { current.framerate = Number(fr[1]); }
  }
  const video = media.find((t) => t.kind === 'video');
  return {
    tracks: media.map((t) => ({ kind: t.kind, codec: t.codec, dimensions: t.dimensions, framerate: t.framerate })),
    videoCodec: video?.codec ?? null,
    videoDimensions: video?.dimensions ?? null,
    videoFramerate: video?.framerate ?? null,
    hasVideo: !!video,
    hasAudio: media.some((t) => t.kind === 'audio'),
  };
}

/** Build `rtsp://user:pass@host:port/path` without leaking credentials into logs. */
export function rtspUrl(host, port, path) {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `rtsp://${host}:${port}${clean}`;
}

/**
 * Try each candidate stream path until one describes successfully.
 *
 * `404` on a path means the RTSP server is healthy and that URL is simply wrong, so
 * we keep trying; `timeout` means the server is not answering and further attempts
 * would just burn the camera's probe budget, so we stop immediately.
 */
export async function rtspProbe(host, { port = 554, paths = ['/'], username, password, timeoutMs = 4000, method = 'DESCRIBE', explicitUrl = null } = {}) {
  const candidates = explicitUrl ? [explicitUrl] : paths.map((p) => rtspUrl(host, port, p));
  const attempts = [];
  for (const url of candidates) {
    const res = await converse(host, port, url, { method, username, password, timeoutMs });
    attempts.push({ url, ok: res.ok, reason: res.reason ?? null, status: res.status ?? null });
    if (res.ok) return { ...res, url, attempts };
    // Hard failures are about the server, not the path — stop wasting the budget.
    if (['timeout', 'refused', 'unreachable', 'auth', 'error'].includes(res.reason)) {
      return { ...res, url, attempts };
    }
  }
  const last = attempts.at(-1);
  return { ok: false, reason: last?.reason ?? 'no-stream', hostAlive: true, attempts, url: last?.url ?? null };
}

export const _internals = { parseResponse, converse };
