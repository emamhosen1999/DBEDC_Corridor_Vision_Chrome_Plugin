/**
 * Dahua adapter — the `/cgi-bin/*.cgi` API (key=value text over HTTP Digest).
 */
import { digestFetch } from '../digest.mjs';

async function cgi(host, path, { port = 80, username, password, timeoutMs = 4000, scheme = 'http' } = {}) {
  const res = await digestFetch(`${scheme}://${host}:${port}${path}`, { username, password, timeoutMs });
  if (res.status === 401) return { ok: false, reason: 'auth', status: 401 };
  if (!res.ok) return { ok: false, reason: `http-${res.status}`, status: res.status };
  const text = await res.text();
  const kv = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { ok: true, kv, text };
}

export const dahua = {
  name: 'dahua',
  snapshotPaths: ['/cgi-bin/snapshot.cgi?channel=1', '/cgi-bin/snapshot.cgi'],
  rtspPaths: ['/cam/realmonitor?channel=1&subtype=0', '/cam/realmonitor?channel=1&subtype=1'],

  async identify(host, opts) {
    const r = await cgi(host, '/cgi-bin/magicBox.cgi?action=getSystemInfo', opts);
    if (!r.ok) return r;
    return {
      ok: true, vendor: 'dahua',
      model: r.kv.deviceType ?? null,
      serial: r.kv.serialNumber ?? null,
      firmware: r.kv['updateSerial'] ?? null,
    };
  },

  async health(host, opts) {
    const [info, version, storage] = await Promise.all([
      cgi(host, '/cgi-bin/magicBox.cgi?action=getSystemInfo', opts),
      cgi(host, '/cgi-bin/magicBox.cgi?action=getSoftwareVersion', opts).catch(() => ({ ok: false })),
      cgi(host, '/cgi-bin/storageDevice.cgi?action=getDeviceAllInfo', opts).catch(() => ({ ok: false })),
    ]);
    if (!info.ok) return { ok: false, vendor: 'dahua', reason: info.reason, status: info.status };

    const out = { ok: true, vendor: 'dahua', warnings: [], findings: [], model: info.kv.deviceType ?? null, serial: info.kv.serialNumber ?? null };
    const finding = (code, detail, value) => { out.findings.push({ code, detail, value }); out.warnings.push(detail); };
    if (version.ok) out.firmware = version.kv['version'] ?? Object.values(version.kv)[0] ?? null;
    if (storage.ok) {
      const total = Number(storage.kv['list[0].Detail[0].TotalBytes']);
      const used = Number(storage.kv['list[0].Detail[0].UsedBytes']);
      const state = storage.kv['list[0].State'] ?? null;
      if (Number.isFinite(total)) {
        out.storage = [{ name: 'sd1', status: state, totalMB: Math.round(total / 1e6), freeMB: Math.round((total - used) / 1e6) }];
        if (total > 0 && (total - used) / total < 0.02) finding('STORAGE_FULL', 'storage is nearly full', Math.round(((total - used) / total) * 100));
      }
      if (state && !/^(Running|Normal)$/i.test(state)) finding('STORAGE_FAIL', `storage reports "${state}"`, state);
    }
    return out;
  },
};
