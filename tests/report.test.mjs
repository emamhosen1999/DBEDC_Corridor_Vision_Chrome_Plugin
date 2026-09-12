import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-report-'));
process.env.CORRIDOR_HOME = HOME;

const { buildReportModel } = await import('../src/report/model.mjs');
const { render, renderText, renderCsv, renderHtml } = await import('../src/report/render.mjs');
const { nextDue, produceReport, listReports, readReport } = await import('../src/report/scheduler.mjs');
const { AlarmRegister } = await import('../src/alarms/register.mjs');
const { deepMerge, DEFAULTS } = await import('../src/core/config.mjs');
const { saveInventory, updateState } = await import('../src/core/store.mjs');
const { conditionsFor, systemConditions } = await import('../src/alarms/mapper.mjs');

const cfg = (patch = {}) => deepMerge(DEFAULTS, deepMerge({
  site: { name: 'Dhaka Bypass Expressway', timezone: 'Asia/Dhaka' },
}, patch));

/** A fleet of N cameras across two zones, with a few faults. */
async function seedFleet(count = 40) {
  const cameras = Array.from({ length: count }, (_, i) => ({
    id: `cam${i}`, name: `Camera ${String(i + 1).padStart(2, '0')}`,
    group: i < count / 2 ? 'Zone 1 - Kanchpur' : 'Zone 3 - Bhulta',
    host: `10.0.0.${i + 10}`, enabled: true, vendor: 'uniview',
  }));
  await saveInventory({ cameras });

  const now = Date.now();
  const states = {};
  for (const [i, c] of cameras.entries()) {
    const status = i === 3 ? 'down' : i === 7 ? 'degraded' : i === 11 ? 'unknown' : 'up';
    states[c.id] = {
      status, since: now - (status === 'up' ? 86_400_000 : 3_600_000),
      name: c.name, group: c.group, host: c.host, latencyMs: 12 + i,
      lastProbeAt: now - 5000, flapping: i === 5,
      lastReason: status === 'down' ? 'no-response' : null,
      lastDetail: status === 'down' ? 'no response on any port' : status === 'degraded' ? 'reachable, but the picture is black' : null,
      warnings: i === 7 ? ['image black (luma 2.1)'] : [],
    };
  }
  const groups = ['Zone 1 - Kanchpur', 'Zone 3 - Bhulta'].map((name) => {
    const inGroup = Object.values(states).filter((s) => s.group === name);
    return {
      name, total: inGroup.length,
      up: inGroup.filter((s) => s.status === 'up').length,
      down: inGroup.filter((s) => s.status === 'down').length,
      degraded: inGroup.filter((s) => s.status === 'degraded').length,
      unknown: inGroup.filter((s) => s.status === 'unknown').length,
    };
  });
  await updateState((s) => {
    s.cameras = states;
    s.fleet = {
      total: count,
      up: Object.values(states).filter((x) => x.status === 'up').length,
      down: 1, degraded: 1, unknown: 1, flapping: 1,
      healthyPct: Math.round((Object.values(states).filter((x) => x.status === 'up').length / count) * 1000) / 10,
      groups,
    };
    s.cycle = { count: 100, lastStartedAt: now - 6000, lastFinishedAt: now - 5000, lastDurationMs: 850, lastError: null };
    s.network = { healthy: true, since: now - 86_400_000, lastCheck: now };
  });
  return { cameras, states, count };
}

/* ------------------------------------------------------------ scheduling --- */

test('fixed-time scheduling picks the next slot and the period it covers', () => {
  const c = cfg({ reporting: { enabled: true, mode: 'times', times: ['06:00', '14:00', '22:00'] } });
  const at = (local) => Date.parse(`${local}+06:00`);   // Dhaka is UTC+6
  const hrs = (ms) => ms / 3_600_000;
  const local = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: false }).format(ts);

  assert.equal(local(nextDue(c, { now: at('2026-09-12T03:00:00') }).dueAt), '06:00');
  assert.equal(local(nextDue(c, { now: at('2026-09-12T09:00:00') }).dueAt), '14:00');
  assert.equal(hrs(nextDue(c, { now: at('2026-09-12T09:00:00') }).periodMs), 8);
  // Past the last slot, it must roll to tomorrow's first, still with an 8h period.
  const wrap = nextDue(c, { now: at('2026-09-12T23:30:00') });
  assert.equal(local(wrap.dueAt), '06:00');
  assert.equal(hrs(wrap.periodMs), 8);
});

test('interval scheduling counts from the last report, not from now', () => {
  const c = cfg({ reporting: { enabled: true, mode: 'interval', intervalMinutes: 360 } });
  const last = Date.parse('2026-09-12T06:00:00Z');
  const d = nextDue(c, { lastIssuedAt: last, now: last + 3_600_000 });
  assert.equal(d.dueAt, last + 6 * 3_600_000);
  assert.equal(d.periodMs, 6 * 3_600_000);
});

test('scheduling is off when reporting is disabled', () => {
  assert.equal(nextDue(cfg({ reporting: { enabled: false } })), null);
});

/* ----------------------------------------------------------------- model --- */

test('the register includes EVERY device, not just the broken ones', async () => {
  const { count } = await seedFleet(40);
  const model = await buildReportModel({ cfg: cfg(), register: null, periodMs: 6 * 3_600_000 });
  assert.equal(model.devices.length, count, 'a report that lists only faults cannot evidence what was checked');
  assert.ok(model.exceptions.length < count, 'exceptions must be a subset');
  assert.ok(model.exceptions.length >= 3, 'the seeded faults must all appear as exceptions');
});

test('devices in the inventory that were never probed are still listed', async () => {
  await seedFleet(10);
  const inv = JSON.parse(fs.readFileSync(path.join(HOME, 'data', 'inventory.json'), 'utf8'));
  inv.cameras.push({ id: 'brand-new', name: 'Newly added', group: 'Zone 9', host: '10.9.9.9', enabled: true });
  await saveInventory(inv);
  const model = await buildReportModel({ cfg: cfg(), register: null });
  const row = model.devices.find((d) => d.id === 'brand-new');
  assert.ok(row, 'a camera nobody has probed must not silently vanish from the register');
  assert.equal(row.status, 'not-yet-probed');
  assert.ok(model.summary.findings.some((f) => /never been probed/.test(f.text)));
});

test('a device being monitored but missing from the inventory is flagged as orphaned', async () => {
  await seedFleet(6);
  await updateState((s) => {
    s.cameras.ghost = { status: 'up', since: Date.now(), name: 'Ghost camera', group: 'Zone 1 - Kanchpur', host: '10.0.0.99' };
  });
  const model = await buildReportModel({ cfg: cfg(), register: null });
  const ghost = model.devices.find((d) => d.id === 'ghost');
  assert.equal(ghost.status, 'orphaned');
  assert.ok(model.summary.findings.some((f) => /missing from the inventory/.test(f.text)));
});

test('the summary states findings, not just numbers', async () => {
  await seedFleet(20);
  const model = await buildReportModel({ cfg: cfg(), register: null });
  assert.ok(model.summary.findings.length > 0);
  assert.ok(model.summary.findings.every((f) => typeof f.text === 'string' && f.text.length > 20));
  assert.ok(model.summary.findings.some((f) => /would appear healthy to the VMS/.test(f.text)),
    'a degraded camera must be explained, not just counted');
});

test('a stale monitor qualifies the whole report at the top', async () => {
  await seedFleet(5);
  await updateState((s) => { s.cycle.lastFinishedAt = Date.now() - 6 * 3_600_000; });
  const model = await buildReportModel({ cfg: cfg(), register: null });
  assert.equal(model.coverage.stale, true);
  assert.match(model.summary.headline, /STALE/);
  assert.equal(model.summary.findings[0].severity, 'critical');
  assert.match(model.summary.findings[0].text, /must not be relied upon/);
});

test('alarms from the register appear in the report with their required action', async () => {
  await seedFleet(8);
  const register = new AlarmRegister({ cfg: cfg(), notify: () => {} });
  register.assert('VID_FROZEN', true, { id: 'cam1', name: 'Camera 02', group: 'Zone 1 - Kanchpur' }, { detail: 'image frozen' });
  register.assert('NET_ZONE_DOWN', true, { id: 'group:Zone 3 - Bhulta', name: 'Zone 3 - Bhulta', group: 'Zone 3 - Bhulta' }, { detail: 'all dark' });
  const model = await buildReportModel({ cfg: cfg(), register });
  assert.equal(model.alarms.outstanding.length, 2);
  const zone = model.alarms.outstanding.find((a) => a.tag === 'NET_ZONE_DOWN');
  assert.equal(zone.priority, 'critical');
  assert.match(zone.correctiveAction, /DO NOT dispatch/);
  assert.ok(zone.timeToRespond);
});

/* ------------------------------------------------------------- rendering --- */

test('the text report contains every device and every required section', async () => {
  const { cameras } = await seedFleet(30);
  const model = await buildReportModel({ cfg: cfg(), register: null, sequence: { number: 7 } });
  const parts = renderText(model, { fullRegister: true, maxChars: 1e9 });
  const text = parts.join('\n');
  for (const section of ['1. SUMMARY', '2. FLEET STATUS', '3. ALARM SUMMARY', '4. ZONE BREAKDOWN',
    '5. ACTION REQUIRED', '6. DEVICE REGISTER', '7. AVAILABILITY',
    '8. ALARM SYSTEM PERFORMANCE', '9. MONITORING SYSTEM']) {
    assert.ok(text.includes(section), `missing section: ${section}`);
  }
  for (const c of cameras) {
    assert.ok(text.includes(c.name), `device register is missing ${c.name}`);
  }
  assert.match(text, /CV-DBE-\d{8}-007/, 'the report id must carry its sequence number');
});

test('a long report is split on section boundaries, and every part is labelled', async () => {
  await seedFleet(200);
  const model = await buildReportModel({ cfg: cfg(), register: null, sequence: { number: 1 } });
  const parts = renderText(model, { fullRegister: true, maxChars: 3500 });
  assert.ok(parts.length > 1, 'a 200-device register must be split for chat delivery');
  for (const [i, p] of parts.entries()) {
    assert.ok(p.length <= 3700, `part ${i + 1} is ${p.length} chars — too long for a chat message`);
    assert.match(p, /part \d+ of \d+/);
  }
  // Nothing may be lost in the split.
  const joined = parts.join('\n');
  assert.ok(joined.includes('Camera 200'), 'the last device must survive the split');
});

test('previews do not consume a report number', async () => {
  await seedFleet(3);
  const model = await buildReportModel({ cfg: cfg(), register: null, sequence: { number: 0 }, trigger: 'preview' });
  assert.match(model.meta.reportId, /PREVIEW$/, 'a preview must not punch a hole in the audit sequence');
});

test('the CSV register has one row per device plus a header', async () => {
  const { count } = await seedFleet(25);
  const model = await buildReportModel({ cfg: cfg(), register: null });
  const csv = renderCsv(model);
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines.length, count + 1);
  assert.match(lines[0], /^Report,Site,/);
  // Fields containing commas must be quoted, or the spreadsheet silently misaligns.
  assert.ok(lines.some((l) => l.includes('"Zone 1 - Kanchpur"') || l.includes('Zone 1 - Kanchpur')));
});

test('CSV quoting survives a camera name containing a comma and a quote', async () => {
  await seedFleet(2);
  const inv = JSON.parse(fs.readFileSync(path.join(HOME, 'data', 'inventory.json'), 'utf8'));
  inv.cameras[0].name = 'PTZ, "North" gate';
  await saveInventory(inv);
  const model = await buildReportModel({ cfg: cfg(), register: null });
  const csv = renderCsv(model);
  assert.ok(csv.includes('"PTZ, ""North"" gate"'), 'RFC 4180 quoting is required or the columns shift');
});

test('the HTML report escapes device names and is self-contained', async () => {
  await seedFleet(3);
  const inv = JSON.parse(fs.readFileSync(path.join(HOME, 'data', 'inventory.json'), 'utf8'));
  inv.cameras[0].name = '<script>alert(1)</script>';
  await saveInventory(inv);
  const model = await buildReportModel({ cfg: cfg(), register: null });
  const html = renderHtml(model);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'device names come from an operator-edited CSV and must be escaped');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!/https?:\/\/(?!www\.w3)/.test(html.replace(/<style>[\s\S]*?<\/style>/, '')), 'the report must not load anything external');
  assert.ok(html.includes('EEMUA 191'));
});

test('every format renders without throwing', async () => {
  await seedFleet(12);
  const register = new AlarmRegister({ cfg: cfg(), notify: () => {} });
  register.assert('CAM_COMM_LOSS', true, { id: 'cam3', name: 'Camera 04', group: 'Zone 1 - Kanchpur' }, { detail: 'no response' });
  const model = await buildReportModel({ cfg: cfg(), register });
  for (const format of ['text', 'html', 'csv', 'alarm-csv', 'json']) {
    const out = render(model, format, format === 'text' ? { maxChars: 1e9 } : undefined);
    const body = Array.isArray(out) ? out.join('') : out;
    assert.ok(body.length > 200, `${format} produced almost nothing`);
  }
  assert.throws(() => render(model, 'pdf'), /Unknown report format/);
});

/* ------------------------------------------------------ report of record --- */

test('issuing a report writes it to disk and numbers it sequentially', async () => {
  await seedFleet(5);
  const c = cfg({ reporting: { enabled: true, mode: 'interval', intervalMinutes: 60, formats: ['text', 'html', 'csv', 'json'] } });
  const first = await produceReport({ cfg: c, register: null, label: 'Test' });
  const second = await produceReport({ cfg: c, register: null, label: 'Test' });

  assert.match(first.model.meta.reportId, /-001$/);
  assert.match(second.model.meta.reportId, /-002$/);
  for (const file of Object.values(first.files)) {
    assert.ok(fs.existsSync(file), `${file} was not written`);
    assert.ok(fs.statSync(file).size > 100);
  }
  const listed = await listReports({ limit: 10 });
  assert.ok(listed.length >= 2);
  const back = await readReport(first.model.meta.reportId, 'json');
  assert.equal(JSON.parse(back).meta.reportId, first.model.meta.reportId);
});

test('the second report covers only the ground since the first', async () => {
  await seedFleet(4);
  const c = cfg({ reporting: { enabled: true, mode: 'interval', intervalMinutes: 60, formats: ['json'] } });
  const t0 = Date.now();
  await produceReport({ cfg: c, register: null, now: t0 });
  const second = await produceReport({ cfg: c, register: null, now: t0 + 30 * 60_000 });
  assert.ok(Math.abs(second.model.meta.periodMs - 30 * 60_000) < 2000,
    `expected a 30-minute period, got ${Math.round(second.model.meta.periodMs / 60_000)} minutes`);
});

/* ----------------------------------------------------------------- mapper --- */

test('the mapper asserts absence as well as presence', () => {
  const result = { cameraId: 'c1', name: 'A', group: 'Z', status: 'up', findings: [] };
  const { conditions } = conditionsFor(result, { since: Date.now() }, cfg());
  assert.ok(conditions.length > 10);
  assert.ok(conditions.every((c) => c.present === false), 'a healthy camera must clear every condition');
});

test('an unknown verdict asserts nothing at all', () => {
  const out = conditionsFor({ cameraId: 'c1', status: 'unknown', findings: [] }, {}, cfg());
  assert.equal(out.conditions.length, 0);
  assert.equal(out.skipped, 'status-unknown');
});

test('structured findings map to catalogue tags', () => {
  const result = {
    cameraId: 'c1', name: 'A', group: 'Z', status: 'degraded', reason: 'image-black',
    findings: [{ code: 'IMAGE_BLACK', detail: 'image black' }, { code: 'STORAGE_FAIL', detail: 'sd failed' }],
  };
  const on = conditionsFor(result, { since: Date.now() }, cfg()).conditions.filter((c) => c.present).map((c) => c.tag);
  assert.deepEqual(on.sort(), ['STO_FAIL', 'VID_LOSS_BLACK']);
});

test('a reboot finding becomes a latching event, not a condition', () => {
  const result = { cameraId: 'c1', name: 'A', status: 'up', findings: [{ code: 'REBOOT', detail: 'uptime reset' }] };
  const out = conditionsFor(result, {}, cfg());
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].tag, 'CAM_REBOOT');
});

test('a wiped zone becomes one group alarm', () => {
  const fleet = { total: 20, down: 10, degraded: 0, groups: [
    { name: 'Zone 1', total: 10, up: 10, down: 0, degraded: 0, unknown: 0 },
    { name: 'Zone 3', total: 10, up: 0, down: 10, degraded: 0, unknown: 0 },
  ] };
  const { conditions, groupConditions } = systemConditions({ fleet, network: { healthy: true }, coverage: {}, queue: {}, cfg: cfg() });
  const zone = groupConditions.find((g) => g.subject.name === 'Zone 3');
  assert.equal(zone.present, true);
  assert.equal(groupConditions.find((g) => g.subject.name === 'Zone 1').present, false);
  assert.equal(conditions.find((c) => c.tag === 'NET_SITE_OUTAGE').present, true, '50% down is a site-level fault');
});

test('a stuck delivery queue raises the alarm that alarms are not arriving', () => {
  const { conditions } = systemConditions({
    fleet: { total: 5, groups: [] }, network: { healthy: true }, coverage: {},
    queue: { pending: 12, oldestAt: Date.now() - 60 * 60_000 },
    cfg: cfg(),
  });
  const stuck = conditions.find((c) => c.tag === 'SYS_CHANNEL_FAIL');
  assert.equal(stuck.present, true);
  assert.match(stuck.evidence.detail, /not reaching anyone/);
});
