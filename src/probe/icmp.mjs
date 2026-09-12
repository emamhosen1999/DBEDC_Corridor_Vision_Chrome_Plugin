/**
 * Layer 0 — ICMP echo, via the system `ping` binary.
 *
 * Raw ICMP sockets need root/Administrator, which a monitoring service should not
 * hold, so we shell out. `ping` exists on every Windows, Linux and macOS host.
 *
 * ICMP is treated as **advisory only** and never decides a camera is down on its own.
 * Plenty of cameras and most hardened surveillance VLANs drop echo requests while the
 * camera streams perfectly; trusting ICMP would manufacture outages. What it is good
 * for is the opposite direction: a successful ping with a rising RTT is an early
 * warning of a saturated uplink, well before the stream fails.
 */
import { execFile } from 'node:child_process';

const isWindows = process.platform === 'win32';

function pingArgs(host, timeoutMs) {
  if (isWindows) return ['-n', '1', '-w', String(timeoutMs), host];
  if (process.platform === 'darwin') return ['-c', '1', '-W', String(timeoutMs), host];
  return ['-c', '1', '-W', String(Math.max(1, Math.round(timeoutMs / 1000))), host];
}

const RTT = /time[=<]\s*([\d.]+)\s*ms/i;

export function icmpProbe(host, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(
      isWindows ? 'ping' : 'ping',
      pingArgs(host, timeoutMs),
      { timeout: timeoutMs + 1500, windowsHide: true },
      (err, stdout = '') => {
        const elapsed = Date.now() - started;
        // Windows `ping` exits 0 even for "Destination host unreachable", so the exit
        // code alone is not trustworthy — the reply line is what counts.
        const text = String(stdout);
        const rtt = RTT.exec(text);
        const replied = !!rtt || /bytes[ =]\d+.*(ttl|TTL)/i.test(text);
        const unreachable = /unreachable|100% packet loss|100% loss/i.test(text);
        resolve({
          ok: replied && !unreachable,
          rttMs: rtt ? Number(rtt[1]) : null,
          elapsedMs: elapsed,
          reason: replied && !unreachable ? null : (unreachable ? 'unreachable' : (err ? 'no-reply' : 'no-reply')),
          available: !(err && (err.code === 'ENOENT' || err.code === 127)),
        });
      },
    );
  });
}
