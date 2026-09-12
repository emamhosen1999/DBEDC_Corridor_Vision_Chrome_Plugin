/**
 * Camera discovery: ONVIF WS-Discovery multicast plus a bounded subnet sweep.
 *
 * Useful in two situations: bootstrapping an inventory when no export exists, and
 * auditing an existing one — a camera physically on the network that is NOT in the
 * inventory is a blind spot nobody knows about, and it is worth finding.
 */
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { mapPool } from '../core/pool.mjs';
import { tcpLadder } from '../probe/tcp.mjs';
import { onvifAlive, onvifDeviceInfo, pick } from '../probe/onvif.mjs';
import { vendorFromManufacturer } from '../probe/vendor/index.mjs';
import { log } from '../core/logger.mjs';

const logger = log('discovery');

const WS_DISCOVERY_ADDR = '239.255.255.250';
const WS_DISCOVERY_PORT = 3702;

/** Multicast an ONVIF Probe and collect whatever answers. */
export function wsDiscover({ timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const uuid = crypto.randomUUID();
    const probe = `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
 xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
 xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
 xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
<e:Header>
<w:MessageID>uuid:${uuid}</w:MessageID>
<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
</e:Header>
<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>
</e:Envelope>`;

    socket.on('message', (msg, rinfo) => {
      const xml = msg.toString('utf8');
      const xaddrs = pick(xml, 'XAddrs') ?? '';
      const scopes = pick(xml, 'Scopes') ?? '';
      const name = /onvif:\/\/www\.onvif\.org\/name\/([^\s]+)/.exec(scopes)?.[1];
      const hardware = /onvif:\/\/www\.onvif\.org\/hardware\/([^\s]+)/.exec(scopes)?.[1];
      found.set(rinfo.address, {
        host: rinfo.address,
        xaddrs: xaddrs.split(/\s+/).filter(Boolean),
        name: name ? decodeURIComponent(name.replace(/_/g, ' ')) : null,
        hardware: hardware ? decodeURIComponent(hardware) : null,
        via: 'ws-discovery',
      });
    });

    socket.on('error', (err) => { logger.warn('WS-Discovery socket error', { error: err.message }); });

    socket.bind(() => {
      try { socket.setBroadcast(true); socket.setMulticastTTL(2); } catch { /* platform default */ }
      socket.send(probe, WS_DISCOVERY_PORT, WS_DISCOVERY_ADDR);
      setTimeout(() => {
        try { socket.close(); } catch { /* already closed */ }
        resolve([...found.values()]);
      }, timeoutMs);
    });
  });
}

/** Expand an IPv4 CIDR to its host addresses. Refuses anything larger than a /16. */
export function expandCidr(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr).trim());
  if (!m) throw new Error(`"${cidr}" is not a valid IPv4 CIDR, e.g. 192.168.10.0/24`);
  const bits = Number(m[5]);
  if (bits < 16 || bits > 32) throw new Error('prefix must be between /16 and /32 — a wider sweep would take hours and alarm the network team');
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) throw new Error(`"${cidr}" has an octet above 255`);
  const base = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
  const size = 2 ** (32 - bits);
  const network = base & (size === 2 ** 32 ? 0 : ~(size - 1) >>> 0);
  const hosts = [];
  // Skip the network and broadcast addresses for prefixes that have them.
  const first = bits >= 31 ? 0 : 1;
  const last = bits >= 31 ? size : size - 1;
  for (let i = first; i < last; i++) {
    const addr = (network + i) >>> 0;
    hosts.push(`${(addr >>> 24) & 255}.${(addr >>> 16) & 255}.${(addr >>> 8) & 255}.${addr & 255}`);
  }
  return hosts;
}

/** Sweep a subnet for anything that looks like a camera. */
export async function discoverSubnet(cidr, {
  ports = [554, 80, 8000], concurrency = 64, timeoutMs = 1200, username, password,
} = {}) {
  const hosts = expandCidr(cidr);
  logger.info('sweeping subnet', { cidr, hosts: hosts.length, concurrency });

  const results = await mapPool(hosts, concurrency, async (host) => {
    const tcp = await tcpLadder(host, ports, timeoutMs);
    if (!tcp.ok) return null;
    const onvif = await onvifAlive(host, { timeoutMs: 2500 });
    const info = onvif.ok && username
      ? await onvifDeviceInfo(host, { username, password, timeoutMs: 3000 })
      : { ok: false };
    return {
      host,
      openPorts: tcp.ports.filter((p) => p.ok).map((p) => p.port),
      onvif: onvif.ok,
      driftSec: onvif.driftSec ?? null,
      manufacturer: info.manufacturer ?? null,
      model: info.model ?? null,
      serial: info.serial ?? null,
      vendor: vendorFromManufacturer(info.manufacturer, info.model),
      likelyCamera: onvif.ok || tcp.ports.some((p) => p.ok && p.port === 554),
    };
  });

  const found = results.filter((r) => r.ok && r.value).map((r) => r.value);
  const discovery = await wsDiscover({ timeoutMs: 4000 }).catch(() => []);

  // Merge the multicast answers in — they carry names the sweep cannot see.
  const byHost = new Map(found.map((f) => [f.host, f]));
  for (const d of discovery) {
    const existing = byHost.get(d.host);
    if (existing) Object.assign(existing, { name: d.name ?? existing.name, hardware: d.hardware, via: 'both' });
    else byHost.set(d.host, { ...d, likelyCamera: true, openPorts: [] });
  }

  const all = [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
  logger.info('sweep complete', { scanned: hosts.length, responded: all.length, cameras: all.filter((c) => c.likelyCamera).length });
  return { cidr, scanned: hosts.length, found: all, cameras: all.filter((c) => c.likelyCamera) };
}
