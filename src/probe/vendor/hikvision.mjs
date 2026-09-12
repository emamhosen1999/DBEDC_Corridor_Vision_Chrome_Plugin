/**
 * Hikvision adapter — ISAPI (XML over HTTP Digest).
 * Present so a mixed-vendor corridor does not silently lose health detail.
 */
import { digestFetch } from '../digest.mjs';
import { pick } from '../onvif.mjs';

async function isapi(host, path, { port = 80, username, password, timeoutMs = 4000, scheme = 'http' } = {}) {
  const res = await digestFetch(`${scheme}://${host}:${port}${path}`, { username, password, timeoutMs });
  if (res.status === 401) return { ok: false, reason: 'auth', status: 401 };
  if (!res.ok) return { ok: false, reason: `http-${res.status}`, status: res.status };
  return { ok: true, xml: await res.text() };
}

export const hikvision = {
  name: 'hikvision',
  snapshotPaths: ['/ISAPI/Streaming/channels/101/picture', '/Streaming/channels/1/picture'],
  rtspPaths: ['/Streaming/Channels/101', '/Streaming/Channels/102', '/h264/ch1/main/av_stream'],

  async identify(host, opts) {
    const r = await isapi(host, '/ISAPI/System/deviceInfo', opts);
    if (!r.ok) return r;
    return {
      ok: true, vendor: 'hikvision',
      model: pick(r.xml, 'model'),
      firmware: pick(r.xml, 'firmwareVersion'),
      serial: pick(r.xml, 'serialNumber'),
      name: pick(r.xml, 'deviceName'),
    };
  },

  async health(host, opts) {
    const [info, status, storage] = await Promise.all([
      isapi(host, '/ISAPI/System/deviceInfo', opts),
      isapi(host, '/ISAPI/System/status', opts).catch(() => ({ ok: false })),
      isapi(host, '/ISAPI/ContentMgmt/Storage', opts).catch(() => ({ ok: false })),
    ]);
    if (!info.ok) return { ok: false, vendor: 'hikvision', reason: info.reason, status: info.status };

    const out = {
      ok: true, vendor: 'hikvision', warnings: [],
      model: pick(info.xml, 'model'),
      firmware: pick(info.xml, 'firmwareVersion'),
      serial: pick(info.xml, 'serialNumber'),
    };
    if (status.ok) {
      const up = Number(pick(status.xml, 'deviceUpTime'));
      if (Number.isFinite(up)) out.uptimeSec = up;
      const cpu = Number(pick(status.xml, 'cpuUtilization'));
      if (Number.isFinite(cpu)) { out.cpuPct = cpu; if (cpu > 92) out.warnings.push(`CPU ${cpu}%`); }
      const mem = Number(pick(status.xml, 'memoryUsage'));
      if (Number.isFinite(mem)) out.memoryUsage = mem;
    }
    if (storage.ok) {
      const status1 = pick(storage.xml, 'status');
      const free = Number(pick(storage.xml, 'freeSpace'));
      const cap = Number(pick(storage.xml, 'capacity'));
      out.storage = [{ name: 'hdd1', status: status1, totalMB: cap, freeMB: free }];
      if (status1 && !/ok|正常/i.test(status1)) out.warnings.push(`storage ${status1}`);
      if (Number.isFinite(free) && Number.isFinite(cap) && cap > 0 && free / cap < 0.02) out.warnings.push('storage nearly full');
    }
    return out;
  },
};
