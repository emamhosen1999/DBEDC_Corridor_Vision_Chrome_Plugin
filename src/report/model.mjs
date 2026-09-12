/**
 * The periodic report — data model.
 *
 * One report, four renderings. This module gathers the facts once; `render.mjs` turns
 * them into text, HTML, CSV or JSON. Separating them matters because the same report
 * must be readable on a phone in WhatsApp, printable for a monthly review, loadable
 * into a spreadsheet, and parseable by another system — and those must never disagree.
 *
 * Structure follows the conventions of an operational service report: a header block
 * that identifies the report uniquely, an executive summary, then evidence in
 * decreasing order of urgency, then the complete register as the record of what was
 * covered.
 *
 * The complete register is the point. A report that lists only the faults answers
 * "what is broken" but not "what was checked", and those are different questions. If
 * a camera silently vanished from the inventory a month ago, only a full register
 * shows it.
 */
import { loadState, readEvents } from '../core/store.mjs';
import { cameraAvailability, groupAvailability, fleetTrend, dailyAvailability } from '../monitor/metrics.mjs';
import { alarmKpis } from '../alarms/kpi.mjs';
import { getAlarmDef, priorityDistribution, PRIORITY_RANK } from '../alarms/catalog.mjs';
import { effectivePriority, ACTIVE_STATES, STATE } from '../alarms/register.mjs';
import { loadInventory } from '../core/store.mjs';
import { dayKey } from '../core/time.mjs';

const STATUS_RANK = { down: 0, degraded: 1, unknown: 2, up: 3 };

/**
 * Build the report.
 *
 * @param periodMs   the reporting period this report covers
 * @param sequence   { number, of } — the report's serial number for the day/period
 */
export async function buildReportModel({
  cfg, register, periodMs = 6 * 3_600_000, at = Date.now(), sequence = null, label = 'Scheduled report', trigger = 'schedule',
} = {}) {
  const periodStart = at - periodMs;
  const state = await loadState();
  const inventory = await loadInventory();

  /* ---- device register: EVERY device, monitored or not ---- */
  const monitored = new Map(Object.entries(state.cameras ?? {}));
  const devices = inventory.cameras.map((cam) => {
    const live = monitored.get(cam.id);
    const status = live?.status ?? (cam.enabled === false ? 'excluded' : 'not-yet-probed');
    const since = live?.since ?? null;
    return {
      id: cam.id,
      name: cam.name,
      group: cam.group ?? 'Ungrouped',
      host: cam.host,
      vendor: cam.vendor ?? null,
      model: cam.model ?? null,
      enabled: cam.enabled !== false,
      status,
      since,
      forMs: since ? at - since : null,
      downtimeMs: live && live.status !== 'up' && since ? at - since : 0,
      latencyMs: live?.latencyMs ?? null,
      lastProbeAt: live?.lastProbeAt ?? null,
      flapping: !!live?.flapping,
      reason: live?.lastReason ?? null,
      detail: live?.lastDetail ?? null,
      warnings: live?.warnings ?? [],
    };
  });

  // Devices in state but not in the inventory: they were removed while being watched.
  for (const [id, live] of monitored) {
    if (devices.some((d) => d.id === id)) continue;
    devices.push({
      id, name: live.name ?? id, group: live.group ?? 'Ungrouped', host: live.host,
      enabled: false, status: 'orphaned', since: live.since, forMs: live.since ? at - live.since : null,
      downtimeMs: 0, latencyMs: null, lastProbeAt: live.lastProbeAt, flapping: false,
      reason: 'not in inventory', detail: 'This device is being monitored but is not in the current inventory.',
      warnings: [],
    });
  }

  devices.sort((a, b) =>
    a.group.localeCompare(b.group)
    || (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
    || a.name.localeCompare(b.name, undefined, { numeric: true }));

  /* ---- availability over the period ---- */
  const availability = await cameraAvailability({ sinceTs: periodStart, untilTs: at, states: state.cameras ?? {} });
  const availabilityByCamera = new Map(availability.map((r) => [r.cameraId, r]));
  for (const d of devices) {
    const a = availabilityByCamera.get(d.id);
    d.uptimePct = a?.uptimePct ?? null;
    d.outages = a?.outages ?? 0;
    d.periodDownMs = a?.downMs ?? 0;
    d.longestOutageMs = a?.longestOutageMs ?? 0;
  }
  const trend = await fleetTrend({ sinceTs: periodStart, untilTs: at, buckets: 48 });
  const daily = await dailyAvailability({ days: 7, tz: cfg.site.timezone, states: state.cameras ?? {} });

  /* ---- alarms ---- */
  const instances = register ? [...register.instances.values()] : [];
  const annunciated = register ? register.annunciated() : [];
  const activeAlarms = instances.filter((i) => ACTIVE_STATES.has(i.state)).map(describeAlarm);
  const outstanding = annunciated.map(describeAlarm);
  const held = instances
    .filter((i) => i.state === STATE.SHELVED || i.state === STATE.OUT_OF_SERVICE || i.state === STATE.SUPPRESSED)
    .map(describeAlarm);

  const raisedThisPeriod = await readEvents({ sinceTs: periodStart, untilTs: at, limit: 20_000, types: ['alarm.raised'] });
  const clearedThisPeriod = await readEvents({ sinceTs: periodStart, untilTs: at, limit: 20_000, types: ['alarm.cleared'] });
  const kpis = await alarmKpis({
    sinceTs: periodStart, untilTs: at, register,
    operatorPositions: cfg.alarms?.operatorPositions ?? 1,
  });

  const byPriority = { critical: 0, high: 0, medium: 0, low: 0, diagnostic: 0 };
  for (const ev of raisedThisPeriod) byPriority[ev.priority ?? 'low'] = (byPriority[ev.priority ?? 'low'] ?? 0) + 1;

  const byClass = new Map();
  for (const ev of raisedThisPeriod) {
    const cls = ev.alarmClass ?? 'unknown';
    byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
  }

  /* ---- fleet and group rollups ---- */
  const fleet = state.fleet ?? { total: 0, up: 0, down: 0, degraded: 0, unknown: 0, healthyPct: 0, groups: [] };
  const groups = (fleet.groups ?? []).map((g) => {
    const gDevices = devices.filter((d) => d.group === g.name);
    const withUptime = gDevices.filter((d) => d.uptimePct !== null);
    return {
      ...g,
      uptimePct: withUptime.length
        ? Math.round((withUptime.reduce((s, d) => s + d.uptimePct, 0) / withUptime.length) * 100) / 100
        : null,
      outages: gDevices.reduce((s, d) => s + d.outages, 0),
      devices: gDevices.length,
    };
  });

  /* ---- monitoring coverage: were we actually watching for the whole period? ---- */
  const gaps = await readEvents({ sinceTs: periodStart, untilTs: at, limit: 200, types: ['monitor.recovered', 'alarm.raised'] });
  const coverageGaps = gaps
    .filter((e) => e.type === 'monitor.recovered' || e.tag === 'SYS_COVERAGE_GAP')
    .map((e) => ({ ts: e.ts, gapMs: e.gapMs ?? null, from: e.gapFrom ?? null, to: e.gapTo ?? null }));
  const cycle = state.cycle ?? {};
  const staleMs = cycle.lastFinishedAt ? at - cycle.lastFinishedAt : null;
  const expectedCycles = Math.floor(periodMs / (cfg.monitor.intervalSec * 1000));
  const coverage = {
    expectedCycles,
    lastCycleAt: cycle.lastFinishedAt ?? null,
    lastCycleDurationMs: cycle.lastDurationMs ?? null,
    staleMs,
    stale: staleMs === null || staleMs > cfg.alerts.watchdog.staleAfterSec * 1000,
    gaps: coverageGaps,
    // A report generated while the monitor is stale is describing history, not now —
    // and must say so at the top rather than be read as current.
    qualified: coverageGaps.length > 0 || staleMs === null || staleMs > cfg.alerts.watchdog.staleAfterSec * 1000,
  };

  /* ---- exceptions: what a reader must act on ---- */
  const exceptions = devices
    .filter((d) => d.status === 'down' || d.status === 'degraded' || d.status === 'orphaned' || d.flapping || (d.warnings?.length ?? 0) > 0)
    .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || (b.downtimeMs ?? 0) - (a.downtimeMs ?? 0));

  return {
    meta: {
      title: 'Camera System Status Report',
      reportId: reportId(at, cfg, sequence),
      sequence,
      label,
      trigger,                          // 'schedule' | 'manual' | 'api'
      site: cfg.site.name,
      operator: cfg.site.operator,
      timezone: cfg.site.timezone,
      generatedAt: at,
      periodStart,
      periodEnd: at,
      periodMs,
      standard: 'ISA-18.2 / EEMUA 191 alarm management; availability per period',
      version: 2,
    },
    summary: buildSummary({ fleet, devices, exceptions, kpis, coverage, trend }),
    fleet: { ...fleet, groups },
    devices,
    exceptions,
    alarms: {
      outstanding,
      active: activeAlarms,
      held,
      raisedInPeriod: raisedThisPeriod.length,
      clearedInPeriod: clearedThisPeriod.length,
      byPriority,
      byClass: Object.fromEntries(byClass),
      unacknowledged: outstanding.filter((a) => a.state === STATE.UNACK_ALARM || a.state === STATE.RTN_UNACK).length,
    },
    kpis,
    availability: {
      cameras: availability,
      groups: groupAvailability(availability),
      fleetPct: trend.availabilityPct,
      trend: trend.points,
      daily: daily.rows,
      samples: trend.samples,
    },
    coverage,
    catalogue: priorityDistribution(),
  };
}

function describeAlarm(i) {
  let def;
  try { def = getAlarmDef(i.tag); } catch { def = null; }
  return {
    key: i.key,
    tag: i.tag,
    name: def?.name ?? i.tag,
    class: def?.class ?? 'unknown',
    priority: effectivePriority(i),
    state: i.state,
    subject: i.subjectName,
    subjectId: i.subjectId,
    group: i.subjectGroup,
    raisedAt: i.raisedAt,
    firstRaisedAt: i.firstRaisedAt,
    ackedAt: i.ackedAt,
    ackedBy: i.ackedBy,
    occurrences: i.occurrences,
    detail: i.detail,
    shelvedUntil: i.shelvedUntil ?? null,
    shelveReason: i.shelveReason ?? null,
    outOfServiceReason: i.outOfServiceReason ?? null,
    correctiveAction: def?.correctiveAction ?? null,
    timeToRespond: def?.timeToRespond ?? null,
    consequence: def?.consequence ?? null,
  };
}

/**
 * The executive summary. Written as findings rather than numbers: a reader who stops
 * after this block should still know whether anything needs doing.
 */
function buildSummary({ fleet, devices, exceptions, kpis, coverage, trend }) {
  const findings = [];
  const total = fleet.total || devices.length;

  if (coverage.qualified) {
    findings.push({
      severity: 'critical',
      text: coverage.stale
        ? 'MONITORING IS NOT CURRENT. This report describes the last known state, not the present one. Camera status below must not be relied upon until monitoring is restored.'
        : `Monitoring was interrupted during this period (${coverage.gaps.length} gap${coverage.gaps.length === 1 ? '' : 's'}). Availability figures are incomplete and any outage confined to a gap is unrecorded.`,
    });
  }

  const down = devices.filter((d) => d.status === 'down').length;
  const degraded = devices.filter((d) => d.status === 'degraded').length;
  const unknown = devices.filter((d) => d.status === 'unknown').length;

  if (down + degraded === 0 && unknown === 0) {
    findings.push({ severity: 'info', text: `All ${total} cameras are serving video.` });
  } else {
    if (down) findings.push({ severity: 'warning', text: `${down} of ${total} cameras are offline.` });
    if (degraded) {
      findings.push({
        severity: 'warning',
        text: `${degraded} camera${degraded === 1 ? ' is' : 's are'} reachable but not serving usable video — these would appear healthy to the VMS.`,
      });
    }
    if (unknown) findings.push({ severity: 'warning', text: `${unknown} camera${unknown === 1 ? '' : 's'} could not be assessed this period.` });
  }

  const wiped = (fleet.groups ?? []).filter((g) => g.total > 1 && g.up === 0);
  for (const g of wiped) {
    findings.push({ severity: 'critical', text: `${g.name} has no cameras serving video (${g.total} devices) — treat as a single infrastructure fault.` });
  }

  const orphaned = devices.filter((d) => d.status === 'orphaned').length;
  if (orphaned) findings.push({ severity: 'warning', text: `${orphaned} device${orphaned === 1 ? ' is' : 's are'} being monitored but missing from the inventory.` });

  const notProbed = devices.filter((d) => d.status === 'not-yet-probed').length;
  if (notProbed) findings.push({ severity: 'warning', text: `${notProbed} device${notProbed === 1 ? ' has' : 's have'} never been probed.` });

  if (kpis.overall.status !== 'acceptable') {
    findings.push({ severity: kpis.overall.status === 'overloaded' ? 'critical' : 'warning', text: kpis.overall.summary });
  }
  if (kpis.acknowledgement.outstanding > 0) {
    findings.push({ severity: 'warning', text: `${kpis.acknowledgement.outstanding} alarm${kpis.acknowledgement.outstanding === 1 ? '' : 's'} outstanding and unacknowledged.` });
  }
  if (kpis.standing.count >= 5) {
    findings.push({ severity: 'warning', text: `${kpis.standing.count} standing alarms (EEMUA target is fewer than 5) — these are degrading the value of the annunciator.` });
  }

  return {
    headline: coverage.stale
      ? 'MONITORING STALE — report describes last known state'
      : `${fleet.up ?? 0} of ${total} cameras serving video (${fleet.healthyPct ?? 0}%)`,
    availabilityPct: trend.availabilityPct,
    findings,
    actionRequired: exceptions.length,
    counts: { total, up: fleet.up ?? 0, down, degraded, unknown, orphaned, notProbed },
  };
}

/**
 * A stable, sortable, human-quotable report id: CV-<site>-YYYYMMDD-NNN.
 *
 * A gap in the sequence is evidence that a scheduled report was missed, so previews
 * are labelled PREVIEW rather than consuming a number — otherwise every glance at the
 * dashboard would punch a hole in the audit trail.
 */
function reportId(at, cfg, sequence) {
  const day = dayKey(at, cfg.site.timezone).replace(/-/g, '');
  const siteCode = (cfg.site.code
    ?? cfg.site.name.split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 4))
    || 'SITE';
  if (!sequence?.number) return `CV-${siteCode}-${day}-PREVIEW`;
  return `CV-${siteCode}-${day}-${String(sequence.number).padStart(3, '0')}`;
}

export { describeAlarm, reportId, STATUS_RANK };
