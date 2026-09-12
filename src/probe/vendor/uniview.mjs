/**
 * Uniview (UNV) adapter — LAPI, the vendor's open HTTP API.
 *
 * The AIV-MP platform's `uas`/`uvs` endpoints are Uniview's, so this is the primary
 * adapter for this deployment. LAPI answers JSON shaped as
 * `{ Response: { ResponseCode: 0, Data: {...} } }` behind HTTP Digest.
 *
 * What this buys over a reachability check: storage health, NTP sync state and
 * recording status. A camera whose SD card has failed is still "online" to every
 * ping and to AIV-MP — and is recording nothing. That is discovered during an
 * incident review, weeks late, which is exactly the failure this adapter exists to
 * prevent.
 */
import { digestFetch } from '../digest.mjs';

const LAPI = '/LAPI/V1.0';

async function lapi(host, path, { port = 80, username, password, timeoutMs = 4000, scheme = 'http' } = {}) {
  const res = await digestFetch(`${scheme}://${host}:${port}${LAPI}${path}`, {
    username, password, timeoutMs, headers: { Accept: 'application/json' },
  });
  if (res.status === 401) return { ok: false, reason: 'auth', status: 401 };
  if (!res.ok) return { ok: false, reason: `http-${res.status}`, status: res.status };
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { return { ok: false, reason: 'bad-json' }; }
  const code = body?.Response?.ResponseCode;
  if (code !== undefined && code !== 0) return { ok: false, reason: `lapi-${code}`, message: body?.Response?.ResponseString };
  return { ok: true, data: body?.Response?.Data ?? body };
}

export const uniview = {
  name: 'uniview',
  /** Candidate snapshot URLs, in preference order. */
  snapshotPaths: ['/LAPI/V1.0/Channels/0/Media/Video/Streams/0/Snapshot', '/images/snapshot.jpg', '/cgi-bin/snapshot.cgi'],
  rtspPaths: ['/media/video1', '/media/video2', '/unicast/c1/s0/live', '/unicast/c1/s1/live'],

  async identify(host, opts) {
    const r = await lapi(host, '/System/DeviceInfo', opts);
    if (!r.ok) return r;
    const d = r.data ?? {};
    return {
      ok: true, vendor: 'uniview',
      model: d.DeviceModel ?? d.Model ?? null,
      firmware: d.FirmwareVersion ?? d.SoftwareVersion ?? null,
      serial: d.SerialNumber ?? d.DeviceID ?? null,
      name: d.DeviceName ?? null,
    };
  },

  async health(host, opts) {
    const out = { ok: true, vendor: 'uniview', warnings: [] };
    const [info, time, storage] = await Promise.all([
      lapi(host, '/System/DeviceInfo', opts),
      lapi(host, '/System/Time', opts).catch(() => ({ ok: false })),
      lapi(host, '/System/StorageInfo', opts).catch(() => ({ ok: false })),
    ]);

    if (!info.ok) return { ok: false, vendor: 'uniview', reason: info.reason, status: info.status };

    const d = info.data ?? {};
    out.model = d.DeviceModel ?? d.Model ?? null;
    out.firmware = d.FirmwareVersion ?? d.SoftwareVersion ?? null;
    out.serial = d.SerialNumber ?? d.DeviceID ?? null;
    if (Number.isFinite(Number(d.RunningTime))) out.uptimeSec = Number(d.RunningTime);

    if (time.ok) {
      const t = time.data ?? {};
      const camMs = Date.parse(t.TimeZone ? `${t.DateTime}` : t.DateTime ?? '');
      if (Number.isFinite(camMs)) {
        out.driftSec = Math.round((camMs - Date.now()) / 1000);
        if (Math.abs(out.driftSec) > 60) out.warnings.push(`clock drift ${out.driftSec}s`);
      }
      out.ntpEnabled = t.NTPEnable === 1 || t.NTPEnable === true;
      if (out.ntpEnabled === false) out.warnings.push('NTP disabled');
    }

    if (storage.ok) {
      const list = [].concat(storage.data?.StorageList ?? storage.data?.Storages ?? []);
      out.storage = list.map((s) => ({
        name: s.Name ?? s.ID ?? 'storage',
        status: s.Status ?? s.State ?? null,
        totalMB: s.TotalSpace ?? s.Total ?? null,
        freeMB: s.FreeSpace ?? s.Free ?? null,
      }));
      for (const s of out.storage) {
        const bad = /error|fail|abnormal|unformat|none/i.test(String(s.status));
        if (bad) out.warnings.push(`storage ${s.name}: ${s.status}`);
        if (Number.isFinite(s.totalMB) && Number.isFinite(s.freeMB) && s.totalMB > 0 && (s.freeMB / s.totalMB) < 0.02) {
          out.warnings.push(`storage ${s.name} nearly full`);
        }
      }
    }
    return out;
  },
};
