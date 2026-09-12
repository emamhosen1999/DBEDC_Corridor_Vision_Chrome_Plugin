/**
 * The probe ladder.
 *
 * One camera, up to six layers, cheapest first, escalating only when a cheaper layer
 * is inconclusive. The whole ladder runs inside one wall-clock budget so a single
 * unresponsive camera can never stall the cycle.
 *
 * The verdict vocabulary is deliberately richer than the old extension's binary
 * online/offline, because "offline" is not an actionable word. An operator dispatched
 * to site needs to know whether they are looking for a power problem, a network
 * problem, a credential problem or a lens problem:
 *
 *   up        — reachable and serving video
 *   degraded  — reachable, but something is wrong (no stream, black image, frozen
 *               frame, failed storage, clock drift). The camera is lying about being
 *               healthy; this is the class AIV-MP cannot see at all.
 *   down      — not reachable by any authoritative layer
 *   unknown   — we could not tell (our own network path is broken). Critically, this
 *               is NOT reported as `down`: blaming 500 cameras because the monitoring
 *               PC lost its uplink is how monitors lose credibility permanently.
 */
import { icmpProbe } from './icmp.mjs';
import { tcpLadder } from './tcp.mjs';
import { onvifAlive, onvifDeviceInfo, onvifStreamUri } from './onvif.mjs';
import { rtspProbe } from './rtsp.mjs';
import { snapshotProbe } from './snapshot.mjs';
import { pullOnvifEvents } from './onvif-events.mjs';
import { getAdapter, detectVendor } from './vendor/index.mjs';
import { withTimeout } from '../core/pool.mjs';

export const STATUS = { UP: 'up', DEGRADED: 'degraded', DOWN: 'down', UNKNOWN: 'unknown' };

/**
 * Ports to TCP-probe for this camera.
 *
 * A camera that declares its own ports must be probed on THOSE, not on the global
 * defaults. Two cameras behind one NVR address differ only by port, so probing the
 * defaults would find the neighbour's open port and report a dead camera as alive —
 * the most dangerous possible error for a monitor to make.
 */
function tcpPorts(camera, cfg) {
  if (camera.ports?.length) return camera.ports;
  const own = [camera.rtspPort, camera.httpPort, camera.onvifPort].filter(Boolean);
  const unique = [...new Set(own)];
  return unique.length ? unique : cfg.probe.tcp.ports;
}

/** Decide the RTSP paths to try: explicit, then vendor-specific, then generic. */
function rtspPaths(camera, cfg) {
  if (camera.rtspPath) return [camera.rtspPath];
  const adapter = getAdapter(camera.vendor);
  return [...(adapter?.rtspPaths ?? []), ...cfg.probe.rtsp.pathTemplates]
    .filter((p, i, a) => a.indexOf(p) === i)
    .slice(0, 4); // cap the fan-out: four failed DESCRIBEs is already a strong signal
}

/**
 * Probe one camera through the ladder.
 *
 * @param camera   inventory record: { id, name, host, group, vendor, ports, credentials… }
 * @param cfg      the validated config object
 * @param ctx      { cycle, history: { snapshot }, credentials: { username, password } }
 */
export async function probeCamera(camera, cfg, ctx = {}) {
  const startedAt = Date.now();
  const { username, password } = ctx.credentials ?? {};
  const p = cfg.probe;
  const layers = {};
  const warnings = [];
  // Structured counterpart to `warnings`: the alarm mapper keys off `code`, so alarm
  // raising never depends on pattern-matching a human-readable string.
  const findings = [];
  const finding = (code, detail, value) => { findings.push({ code, detail, value }); warnings.push(detail); };
  let hostAlive = false;

  const result = {
    cameraId: camera.id,
    name: camera.name,
    host: camera.host,
    group: camera.group ?? null,
    at: startedAt,
    status: STATUS.UNKNOWN,
    reason: null,
    detail: null,
    layers,
    warnings,
    findings,
    latencyMs: null,
    durationMs: 0,
  };

  try {
    /* ---- Layer 0: ICMP (advisory only — never decides anything) -------------- */
    if (p.icmp.enabled) {
      layers.icmp = await icmpProbe(camera.host, p.icmp.timeoutMs);
      if (layers.icmp.ok) {
        hostAlive = true;
        result.latencyMs = layers.icmp.rttMs;
        if (layers.icmp.rttMs > 200) finding('HIGH_LATENCY', `high latency ${layers.icmp.rttMs}ms`, layers.icmp.rttMs);
      }
    }

    /* ---- Layer 1: TCP connect ------------------------------------------------ */
    if (p.tcp.enabled) {
      layers.tcp = await tcpLadder(camera.host, tcpPorts(camera, cfg), p.tcp.timeoutMs);
      if (layers.tcp.hostAlive) hostAlive = true;
      if (layers.tcp.ok) result.latencyMs ??= layers.tcp.latencyMs;
    }

    /* ---- Layer 2: ONVIF (unauthenticated liveness + clock drift) ------------- */
    if (p.onvif.enabled && (hostAlive || !p.tcp.enabled)) {
      layers.onvif = await onvifAlive(camera.host, {
        port: camera.onvifPort ?? p.onvif.port,
        path: camera.onvifPath ?? p.onvif.path,
        timeoutMs: p.onvif.timeoutMs,
      });
      if (layers.onvif.ok) {
        hostAlive = true;
        result.latencyMs ??= layers.onvif.latencyMs;
        if (Number.isFinite(layers.onvif.driftSec) && Math.abs(layers.onvif.driftSec) > 60) {
          finding('CLOCK_DRIFT', `clock drift ${layers.onvif.driftSec}s — recorded footage will carry the wrong time`, layers.onvif.driftSec);
        }
      }
    }

    /* ---- Layer 3: RTSP DESCRIBE (does the video actually serve?) ------------- */
    let streamOk = null;
    if (p.rtsp.enabled && hostAlive) {
      const rtspOpts = {
        port: camera.rtspPort ?? p.rtsp.port,
        username: camera.rtspUser ?? username,
        password: camera.rtspPass ?? password,
        timeoutMs: p.rtsp.timeoutMs,
        method: p.rtsp.method,
      };
      // A path learned from the camera on an earlier cycle outranks any guess.
      const learned = ctx.history?.stream?.url ?? null;
      layers.rtsp = await rtspProbe(camera.host, {
        ...rtspOpts,
        paths: rtspPaths(camera, cfg),
        explicitUrl: camera.rtspUrl ?? learned ?? null,
      });

      // The template list is a guess written from documentation. When every guess
      // misses, ASK the camera over ONVIF rather than reporting a working camera as
      // a dead stream - `no-such-stream` against a healthy encoder is a false alarm,
      // and a false alarm on 162 cameras is how an operator learns to ignore this.
      // The answer is cached on the camera's state, so this costs two SOAP calls
      // once, not every cycle.
      const guessMissed = !layers.rtsp.ok
        && layers.rtsp.reason !== 'auth'
        && !camera.rtspUrl
        && p.onvif.enabled;
      if (guessMissed) {
        const discovered = await onvifStreamUri(camera.host, {
          port: camera.onvifPort ?? p.onvif.port,
          username, password, timeoutMs: p.onvif.timeoutMs,
        }).catch(() => ({ ok: false }));
        if (discovered.ok && discovered.uri && discovered.uri !== learned) {
          const retry = await rtspProbe(camera.host, { ...rtspOpts, paths: [], explicitUrl: discovered.uri });
          if (retry.ok) {
            layers.rtsp = { ...retry, via: 'onvif-getstreamuri', discovered: { url: discovered.uri, at: Date.now() } };
          }
        } else if (learned) {
          // A cached path that no longer works must not be retried forever.
          layers.rtsp.discovered = {};
        }
      }
      streamOk = layers.rtsp.ok;
      if (layers.rtsp.hostAlive) hostAlive = true;
      if (layers.rtsp.ok) {
        // Configuration drift: a camera that silently reverted to a lower profile
        // after a power event still "works" and is quietly useless as evidence.
        if (camera.expectedCodec && layers.rtsp.videoCodec && layers.rtsp.videoCodec !== camera.expectedCodec) {
          finding('CODEC_DRIFT', `codec changed: expected ${camera.expectedCodec}, serving ${layers.rtsp.videoCodec}`, layers.rtsp.videoCodec);
        }
        if (camera.expectedResolution && layers.rtsp.videoDimensions && layers.rtsp.videoDimensions !== camera.expectedResolution) {
          finding('RESOLUTION_DRIFT', `resolution changed: expected ${camera.expectedResolution}, serving ${layers.rtsp.videoDimensions}`, layers.rtsp.videoDimensions);
        }
      } else if (layers.rtsp.reason === 'auth') {
        finding('AUTH_FAIL', 'RTSP credentials rejected');
      }
    }

    /* ---- Layer 4: vendor health (storage, NTP, uptime) ---------------------- */
    if (p.vendor.enabled && hostAlive && (camera.vendor || p.vendor.defaultVendor)) {
      const adapter = getAdapter(camera.vendor ?? p.vendor.defaultVendor);
      if (adapter) {
        try {
          layers.vendor = await adapter.health(camera.host, {
            port: camera.httpPort ?? 80,
            username: camera.httpUser ?? username,
            password: camera.httpPass ?? password,
            timeoutMs: p.vendor.timeoutMs,
          });
          if (layers.vendor.ok) {
            hostAlive = true;
            for (const f of layers.vendor.findings ?? []) finding(f.code, f.detail, f.value);
            // Adapters without structured findings still surface their prose warnings.
            if (!layers.vendor.findings) for (const w of layers.vendor.warnings ?? []) warnings.push(w);
            if (layers.vendor.reason === 'auth') finding('AUTH_FAIL', 'vendor API credentials rejected');
            // Uptime running backwards means the camera restarted between cycles.
            const prevUptime = ctx.history?.uptimeSec;
            if (Number.isFinite(layers.vendor.uptimeSec) && Number.isFinite(prevUptime)
                && layers.vendor.uptimeSec < prevUptime - 60) {
              finding('REBOOT', `camera restarted (uptime went from ${prevUptime}s to ${layers.vendor.uptimeSec}s)`, layers.vendor.uptimeSec);
            }
            result.uptimeSec = layers.vendor.uptimeSec ?? null;
          }
        } catch (err) {
          layers.vendor = { ok: false, reason: 'error', detail: String(err?.message ?? err) };
        }
      }
    }

    /* ---- Layer 5: snapshot (black / flat / frozen) -------------------------- */
    const dueForSnapshot = p.snapshot.enabled
      && hostAlive
      && (ctx.cycle ?? 0) % Math.max(1, p.snapshot.everyNCycles) === 0;
    if (dueForSnapshot) {
      layers.snapshot = await snapshotProbe(camera, {
        username: camera.httpUser ?? username,
        password: camera.httpPass ?? password,
        timeoutMs: p.snapshot.timeoutMs,
        blackLumaMax: p.snapshot.blackLumaMax,
        blurVarianceMin: p.snapshot.blurVarianceMin,
        minBytes: p.snapshot.minBytes,
        frozenCycles: p.snapshot.frozenCycles,
        history: ctx.history?.snapshot ?? {},
      });
      if (layers.snapshot.degraded) {
        const measured = layers.snapshot.meanLuma !== undefined
          ? ` (luma ${layers.snapshot.meanLuma}, variance ${layers.snapshot.variance})` : '';
        const code = {
          black: 'IMAGE_BLACK', frozen: 'IMAGE_FROZEN', flat: 'IMAGE_FLAT',
          'washed-out': 'IMAGE_WASHED_OUT', tiny: 'IMAGE_INVALID',
        }[layers.snapshot.verdict] ?? 'IMAGE_DEGRADED';
        finding(code, `image ${layers.snapshot.verdict}${measured}`, layers.snapshot.meanLuma ?? null);
      }
    }

    /* ---- Layer 6: the camera's own analytics (opt-in) ----------------------- */
    if (p.onvifEvents?.enabled && camera.onvifEvents && hostAlive) {
      layers.events = await pullOnvifEvents(camera.host, {
        port: camera.onvifPort ?? p.onvif.port,
        path: camera.onvifEventsPath ?? p.onvifEvents.path,
        username: camera.httpUser ?? username,
        password: camera.httpPass ?? password,
        timeoutMs: p.onvifEvents.timeoutMs,
      });
      for (const ev of layers.events.events ?? []) {
        if (!ev.active) continue;
        const code = { tamper: 'ONVIF_TAMPER', 'too-dark': 'IMAGE_BLACK', 'too-bright': 'IMAGE_WASHED_OUT',
          defocus: 'IMAGE_FLAT', 'signal-loss': 'STREAM_FAIL' }[ev.kind];
        if (code) finding(code, `${ev.detail} (${ev.topic})`, ev.topic);
      }
    }

    /* ---- Verdict ------------------------------------------------------------ */
    const authoritative = [layers.tcp?.ok, layers.onvif?.ok, layers.rtsp?.ok, layers.vendor?.ok]
      .filter((v) => v !== undefined);
    const anyAuthoritativeOk = authoritative.some(Boolean);
    const haveAuthoritativeLayer = authoritative.length > 0;

    if (!haveAuthoritativeLayer) {
      result.status = STATUS.UNKNOWN;
      result.reason = 'no-authoritative-layer';
      result.detail = 'every authoritative probe layer is disabled';
    } else if (anyAuthoritativeOk) {
      const imageBad = layers.snapshot?.degraded === true;
      const streamBad = p.rtsp.enabled && streamOk === false;
      if (imageBad || streamBad) {
        if (streamBad) finding('STREAM_FAIL', `RTSP ${layers.rtsp.reason ?? 'failed'} — the camera is not serving video`, layers.rtsp.reason);
        result.status = STATUS.DEGRADED;
        result.reason = imageBad ? `image-${layers.snapshot.verdict}` : `stream-${layers.rtsp.reason ?? 'failed'}`;
        result.detail = imageBad
          ? `reachable, but the picture is ${layers.snapshot.verdict}`
          : `reachable, but RTSP ${layers.rtsp.reason ?? 'failed'} — the camera is not serving video`;
      } else {
        result.status = STATUS.UP;
      }
    } else if (hostAlive) {
      // Something answered (a RST, a 401, a SOAP fault) but nothing served.
      result.status = STATUS.DEGRADED;
      result.reason = layers.rtsp?.reason === 'auth' || layers.vendor?.reason === 'auth' ? 'auth' : 'services-down';
      result.detail = result.reason === 'auth'
        ? 'host is up but rejected our credentials — check the camera password'
        : 'host is up but no camera service responded — the camera may be booting or its application has crashed';
      finding(result.reason === 'auth' ? 'AUTH_FAIL' : 'SERVICES_DOWN', result.detail);
    } else {
      result.status = STATUS.DOWN;
      const tcpReason = layers.tcp?.reason;
      result.reason = tcpReason === 'unreachable' || tcpReason === 'net-unreachable' ? 'unreachable' : 'no-response';
      result.detail = tcpReason === 'unreachable'
        ? 'no route to the camera — check the switch, VLAN or uplink'
        : 'no response on any port — check power, PoE and cabling';
    }
  } catch (err) {
    result.status = STATUS.UNKNOWN;
    result.reason = 'probe-error';
    result.detail = String(err?.message ?? err);
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

/** Probe with a hard wall-clock budget. A stuck camera must never stall a cycle. */
export function probeCameraBounded(camera, cfg, ctx) {
  return withTimeout(probeCamera(camera, cfg, ctx), cfg.monitor.cameraTimeoutMs, `probe ${camera.name ?? camera.host}`)
    .catch((err) => ({
      cameraId: camera.id, name: camera.name, host: camera.host, group: camera.group ?? null,
      at: Date.now(), status: STATUS.UNKNOWN, reason: 'budget-exceeded',
      detail: String(err?.message ?? err), layers: {}, warnings: [], findings: [], latencyMs: null,
      durationMs: cfg.monitor.cameraTimeoutMs,
    }));
}

/**
 * Is OUR network path alive?
 *
 * Run before declaring outages. If none of the reference hosts answer, the fault is
 * almost certainly on this side, and every camera is marked `unknown` rather than
 * `down`. This single check is the difference between a monitor that is trusted and
 * one that cries wolf every time the monitoring PC's uplink flaps.
 */
export async function checkNetwork(cfg) {
  const gw = cfg.monitor.gatewayCheck;
  if (!gw.enabled || !gw.hosts?.length) return { healthy: true, checked: false, reason: 'not-configured' };
  const results = await Promise.all(gw.hosts.map(async (host) => {
    const [h, portStr] = String(host).split(':');
    const port = Number(portStr) || gw.port;
    const tcp = await tcpLadder(h, [port], 2500);
    return { host: h, port, ok: tcp.hostAlive };
  }));
  const healthy = results.some((r) => r.ok);
  return {
    healthy, checked: true, results,
    reason: healthy ? null : 'no reference host reachable — the fault is on the monitoring side of the network',
  };
}

export { onvifDeviceInfo, detectVendor, tcpPorts };
