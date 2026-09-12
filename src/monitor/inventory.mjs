/**
 * Camera inventory: import, normalise, and give every camera a stable identity.
 *
 * Identity is the part the old extension got wrong (audit finding B2): it keyed
 * downtime history on the camera *name*, so two cameras called "Gate-01" shared one
 * history, a rename looked like one camera vanishing and another appearing, and an
 * outage on one could be cancelled by its namesake being healthy.
 *
 * Here identity is resolved in this order, most stable first:
 *   1. an explicit `id` column from the source file
 *   2. the device serial number (survives IP changes, renames and re-cabling)
 *   3. the IP address (stable for fixed-address CCTV, which is the normal case)
 *   4. a hash of name+group, as a last resort
 *
 * The chosen key is recorded on the record so a later import that gains a serial can
 * migrate the record rather than duplicate it.
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { loadInventory, saveInventory } from '../core/store.mjs';
import { log } from '../core/logger.mjs';

const logger = log('inventory');

/** RFC 4180 CSV parser: handles quotes, embedded commas, newlines and CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, ''); // strip a BOM — Excel always adds one

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/**
 * Map source column headings to our fields. Deliberately generous: the point is that
 * an operator can export from AIV-MP, or hand over the spreadsheet they already keep,
 * and it works without editing.
 */
const COLUMN_ALIASES = {
  id:        ['id', 'cameraid', 'camera id', 'deviceid', 'device id', 'uuid'],
  name:      ['camera', 'cameraname', 'camera name', 'name', 'title', 'devicename', 'device name', 'description'],
  host:      ['ip', 'ipaddress', 'ip address', 'host', 'address', 'puip', 'deviceip', 'device ip'],
  // AIV-MP/VPAASPlat exports the zone as "Organization Name", not "Organization".
  // Missing it is silent and expensive: every camera lands in "Ungrouped", which
  // disables the per-zone rollup and with it NET_ZONE_DOWN - the alarm that turns
  // twelve camera faults into one "the zone is dark".
  group:     ['organization', 'organisation', 'org', 'group', 'zone', 'site', 'area', 'location', 'chainage',
              'organization name', 'organisation name', 'org name', 'group name', 'zone name',
              'area name', 'site name'],
  vendor:    ['vendor', 'manufacturer', 'make', 'brand', 'device manufacturer'],
  model:     ['model', 'device', 'devicetype', 'device type', 'maindevname', 'device model'],
  serial:    ['serial', 'serialnumber', 'serial number', 'sn'],
  rtspPort:  ['rtspport', 'rtsp port'],
  httpPort:  ['httpport', 'http port', 'webport', 'port'],
  onvifPort: ['onvifport', 'onvif port'],
  rtspPath:  ['rtsppath', 'rtsp path', 'streampath', 'stream path'],
  rtspUrl:   ['rtspurl', 'rtsp url', 'streamurl', 'stream url'],
  httpUser:  ['user', 'username', 'login', 'httpuser'],
  httpPass:  ['pass', 'password', 'httppass'],
  snapshotUrl: ['snapshoturl', 'snapshot url'],
  expectedCodec: ['codec', 'expectedcodec'],
  expectedResolution: ['resolution', 'expectedresolution'],
  enabled:   ['enabled', 'active', 'monitor'],
  onvifEvents: ['onvifevents', 'onvif events', 'tamper', 'analytics'],
  notes:     ['notes', 'note', 'comment', 'remarks'],
};

const normaliseHeader = (h) => String(h).trim().toLowerCase().replace(/[_\-\s]+/g, ' ').trim();

export function mapColumns(headers) {
  const map = {};
  headers.forEach((raw, index) => {
    const h = normaliseHeader(raw);
    const compact = h.replace(/\s+/g, '');
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (map[field] !== undefined) continue;
      if (aliases.includes(h) || aliases.includes(compact)) { map[field] = index; break; }
    }
  });
  return map;
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export function isValidHost(host) {
  const h = String(host ?? '').trim();
  if (!h) return false;
  if (IPV4.test(h)) return h.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(h);
}

/**
 * Derive a stable id. `keySource` is recorded so imports can migrate, not duplicate.
 *
 * `discriminate` is set only when a plain host key would collide — see
 * `assignIds()`. Cameras behind one NVR share an IP and are separated by port, so the
 * bare-IP key is correct for the common case and wrong for that one; discriminating
 * only on collision keeps existing ids stable instead of churning them.
 */
export function deriveId(rec, { discriminate = false } = {}) {
  // Only a user-supplied `id` counts as explicit; callers strip derived ids first.
  if (rec.id) return { id: String(rec.id).trim(), keySource: 'explicit' };
  if (rec.serial) return { id: `sn-${slug(rec.serial)}`, keySource: 'serial' };
  if (rec.host) {
    const host = String(rec.host).trim().replace(/[^\w.]/g, '-');
    if (!discriminate) return { id: `ip-${host}`, keySource: 'host' };
    const port = rec.rtspPort ?? rec.httpPort ?? rec.onvifPort;
    if (port) return { id: `ip-${host}-${port}`, keySource: 'host+port' };
    return { id: `ip-${host}-${slug(rec.name ?? 'cam')}`, keySource: 'host+name' };
  }
  const digest = crypto.createHash('sha1').update(`${rec.name ?? ''}|${rec.group ?? ''}`).digest('hex').slice(0, 10);
  return { id: `nm-${digest}`, keySource: 'name' };
}

/**
 * Assign ids across a whole import, re-deriving only those that collide.
 * Returns `{ cameras, collisions }`.
 */
export function assignIds(records) {
  // normaliseCamera() has already stamped a derived id on each record. Re-deriving
  // must ignore that, or every record short-circuits on the `explicit` branch and the
  // discriminator never applies. A genuinely user-supplied id (keySource 'explicit')
  // is authoritative and is left alone.
  const keyOf = (rec) => (rec.keySource === 'explicit' ? { id: rec.id, keySource: 'explicit' } : null);
  const strip = (rec) => { const { id, keySource, ...rest } = rec; return rest; };

  const counts = new Map();
  for (const rec of records) {
    const { id } = keyOf(rec) ?? deriveId(strip(rec));
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const collisions = [];
  const used = new Set();
  const cameras = records.map((rec) => {
    const explicit = keyOf(rec);
    const plain = explicit ?? deriveId(strip(rec));
    const needsDiscriminator = !explicit && counts.get(plain.id) > 1;
    let { id, keySource } = needsDiscriminator ? deriveId(strip(rec), { discriminate: true }) : plain;
    if (needsDiscriminator) collisions.push({ name: rec.name, host: rec.host, id });
    // Absolute last resort: two rows that are genuinely indistinguishable.
    let n = 2;
    while (used.has(id)) { id = `${id}-${n++}`; keySource = `${keySource}+seq`; }
    used.add(id);
    return { ...rec, id, keySource };
  });
  return { cameras, collisions };
}

const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const TRUEISH = /^(1|y|yes|true|on|enabled|online)$/i;

/** Manufacturer values that mean "not identified", not a make. */
const PLACEHOLDER_VENDORS = new Set(['others', 'other', 'unknown', 'unknwon', 'n-a', 'na', 'none', 'generic', 'default', '-']);

/** Turn a raw row object into a validated camera record. */
export function normaliseCamera(raw, { defaults = {} } = {}) {
  const rec = { ...raw };
  const errors = [];

  rec.name = String(rec.name ?? '').trim() || null;
  rec.host = String(rec.host ?? '').trim();
  rec.group = String(rec.group ?? '').trim() || 'Ungrouped';

  if (!rec.host) errors.push('missing IP/host');
  else if (!isValidHost(rec.host)) errors.push(`invalid IP/host "${rec.host}"`);
  if (!rec.name) rec.name = rec.host || 'unnamed camera';

  for (const key of ['rtspPort', 'httpPort', 'onvifPort']) {
    if (rec[key] === '' || rec[key] === undefined || rec[key] === null) { delete rec[key]; continue; }
    const n = Number(rec[key]);
    if (!Number.isInteger(n) || n < 1 || n > 65535) { errors.push(`invalid ${key} "${rec[key]}"`); delete rec[key]; }
    else rec[key] = n;
  }

  rec.enabled = rec.enabled === undefined || rec.enabled === '' ? true : TRUEISH.test(String(rec.enabled));
  if (rec.onvifEvents !== undefined) rec.onvifEvents = TRUEISH.test(String(rec.onvifEvents));
  // A VMS export routinely carries a placeholder in the manufacturer column - AIV-MP
  // writes "Others" for every camera it did not identify. Treating that as a vendor
  // name would both pollute the device register and shadow the `--vendor` default,
  // so a placeholder counts as absent.
  const vendorRaw = rec.vendor ? slug(rec.vendor) : '';
  rec.vendor = (vendorRaw && !PLACEHOLDER_VENDORS.has(vendorRaw))
    ? vendorRaw
    : (defaults.vendor ?? null);

  // A bare label like "cam-3" is a legal hostname but almost never resolves on a
  // camera VLAN — accept it, but say so rather than letting it fail silently later.
  const warnings = [];
  if (rec.host && !IPV4.test(rec.host) && !rec.host.includes('.')) {
    warnings.push(`"${rec.host}" is an unqualified name, not an IP — it will only work if DNS resolves it`);
  }

  const { id, keySource } = deriveId(rec);
  rec.id = id;
  rec.keySource = keySource;

  return { camera: rec, errors, warnings };
}

/**
 * Import cameras from a CSV file.
 *
 * `merge: true` (the default) preserves fields already known about a camera — a
 * re-export from AIV-MP has no credentials or stream paths in it, and must not wipe
 * the ones an operator typed in.
 */
export async function importCsv(file, { merge = true, defaults = {} } = {}) {
  const text = await fs.readFile(file, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error(`${file} has no data rows`);

  const map = mapColumns(rows[0]);
  if (map.host === undefined) {
    throw new Error(
      `Could not find an IP/host column in ${file}. Headers seen: ${rows[0].join(', ')}. ` +
      'Rename the column to "IP" (or one of: address, host, device ip).',
    );
  }

  const parsed = [];
  const rejected = [];
  const warnings = [];
  for (const [i, row] of rows.slice(1).entries()) {
    const raw = {};
    for (const [field, index] of Object.entries(map)) {
      const v = row[index];
      if (v !== undefined && String(v).trim() !== '') raw[field] = String(v).trim();
    }
    const { camera, errors, warnings: rowWarnings } = normaliseCamera(raw, { defaults });
    if (errors.length) rejected.push({ line: i + 2, name: raw.name ?? raw.host ?? '(blank)', errors });
    else {
      parsed.push(camera);
      for (const w of rowWarnings ?? []) warnings.push({ line: i + 2, name: camera.name, warning: w });
    }
  }

  // Give every camera a distinct identity, discriminating only where a plain host
  // key would collide (multiple channels behind one NVR address).
  const { cameras: imported, collisions } = assignIds(parsed);

  // De-duplicate genuinely identical rows — AIV-MP exports repeat a camera that
  // belongs to two organisations.
  const seen = new Map();
  const duplicates = [];
  for (const cam of imported) {
    if (seen.has(cam.id)) { duplicates.push(cam); continue; }
    seen.set(cam.id, cam);
  }

  const existing = await loadInventory();
  const byId = new Map(existing.cameras.map((c) => [c.id, c]));
  const merged = [];
  let added = 0;
  let updated = 0;

  for (const cam of seen.values()) {
    const prev = byId.get(cam.id);
    if (prev && merge) {
      // Incoming wins for fields it actually carries; everything else is preserved.
      const next = { ...prev };
      for (const [k, v] of Object.entries(cam)) if (v !== null && v !== undefined && v !== '') next[k] = v;
      merged.push(next);
      updated++;
    } else {
      merged.push(cam);
      if (prev) updated++; else added++;
    }
    byId.delete(cam.id);
  }

  // Cameras that were in the inventory but not in this import.
  const missing = [...byId.values()];
  if (merge) merged.push(...missing);

  const inv = await saveInventory({ cameras: merged.sort((a, b) => a.name.localeCompare(b.name)) });
  const summary = {
    file, total: rows.length - 1, imported: seen.size, added, updated,
    duplicates: duplicates.length, rejected, warnings, collisions,
    missing: missing.map((c) => ({ id: c.id, name: c.name })),
    inventorySize: inv.cameras.length,
  };
  logger.info('CSV import complete', {
    imported: summary.imported, added, updated, rejected: rejected.length,
    duplicates: duplicates.length, collisions: collisions.length,
  });
  return summary;
}

/** Cameras that should be probed this cycle. */
export async function activeCameras() {
  const inv = await loadInventory();
  return inv.cameras.filter((c) => c.enabled !== false);
}

export async function upsertCamera(patch) {
  const inv = await loadInventory();
  const i = inv.cameras.findIndex((c) => c.id === patch.id);
  if (i === -1) inv.cameras.push(patch); else inv.cameras[i] = { ...inv.cameras[i], ...patch };
  return saveInventory(inv);
}

export async function removeCamera(id) {
  const inv = await loadInventory();
  inv.cameras = inv.cameras.filter((c) => c.id !== id);
  return saveInventory(inv);
}
