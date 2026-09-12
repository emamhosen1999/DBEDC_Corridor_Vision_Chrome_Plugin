/**
 * Layer 1 — TCP connect probe.
 *
 * The cheapest authoritative signal: can we complete a three-way handshake to a port
 * the camera should be serving? Unlike ICMP this is rarely filtered inside a
 * surveillance VLAN, and unlike a full RTSP handshake it costs one round trip.
 *
 * Reporting the *reason* matters. ECONNREFUSED means the host is alive but the
 * service is dead (camera rebooting, application crashed) — a different fault from
 * ETIMEDOUT, which means the host is not answering at all (power, cable, switch).
 * The old extension collapsed every failure into one opaque "Offline".
 */
import net from 'node:net';

export function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve({ port, latencyMs: Date.now() - started, ...result });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, reason: 'timeout', detail: `no SYN-ACK within ${timeoutMs}ms` }));
    socket.once('error', (err) => finish({
      ok: false,
      reason: err.code === 'ECONNREFUSED' ? 'refused'
        : err.code === 'EHOSTUNREACH' ? 'unreachable'
        : err.code === 'ENETUNREACH' ? 'net-unreachable'
        : 'error',
      detail: err.code || err.message,
    }));

    socket.connect(port, host);
  });
}

/**
 * Try several ports and return the first that answers, plus the full per-port detail.
 * `refused` on every port still proves the host is alive — that is a *degraded*
 * camera, not an absent one, and the caller is told so.
 */
export async function tcpLadder(host, ports, timeoutMs) {
  const results = await Promise.all(ports.map((p) => tcpProbe(host, p, timeoutMs)));
  const open = results.find((r) => r.ok);
  const anyRefused = results.some((r) => r.reason === 'refused');
  return {
    ok: !!open,
    hostAlive: !!open || anyRefused,   // a RST proves something answered
    openPort: open?.port ?? null,
    latencyMs: open?.latencyMs ?? null,
    ports: results,
    reason: open ? null : (anyRefused ? 'service-down' : results[0]?.reason ?? 'timeout'),
  };
}
