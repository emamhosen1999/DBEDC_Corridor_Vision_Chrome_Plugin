/**
 * Alarm system performance metrics — EEMUA 191 / ISA-18.2 clause 16.
 *
 * The premise these standards rest on, which is worth stating because it is
 * counter-intuitive: **the performance of an alarm system is measured by how FEW
 * alarms it produces.** A system emitting 400 alarms a shift has not detected more
 * problems than one emitting 12; it has made itself unreadable, and its operators have
 * learned to ignore it. Every metric below is a rate you want low.
 *
 * Published targets (EEMUA 191 table, per operator position):
 *
 *   Average alarm rate          ≤  6 per hour   (1 per 10 minutes)  "acceptable"
 *                               ≤ 12 per hour                       "manageable"
 *   Peak in any 10 min          ≤ 10                                 above this is a flood
 *   Time in flood                <  1% of the period
 *   Standing alarms              <  5 at any time
 *   Top 10 contributors          ≤  5% of total alarm load
 *   Priority distribution      ~80% low / 15% medium / 5% high-or-above
 *
 * Each metric is reported with its target and a verdict, so the report says whether
 * the alarm system is healthy rather than leaving the reader to judge raw numbers.
 */
import { readEvents } from '../core/store.mjs';
import { getAlarmDef, PRIORITY_RANK } from './catalog.mjs';
import { STATE, ACTIVE_STATES, effectivePriority } from './register.mjs';

export const EEMUA_TARGETS = {
  alarmsPerHourAcceptable: 6,
  alarmsPerHourManageable: 12,
  peakPer10Min: 10,
  floodPctMax: 1,
  standingMax: 5,
  topTenPctMax: 5,
  priorityMix: { low: 80, medium: 15, highOrAbove: 5 },
};

const verdict = (ok, warn = false) => (ok ? 'acceptable' : warn ? 'manageable' : 'above target');

/**
 * Compute the KPI set over a window.
 *
 * Only `alarm.raised` events count toward the load: an acknowledgement or a clear is
 * not something the operator had to triage, and counting them would flatter the
 * numbers. That is the standard's definition and the reason the figures here are
 * comparable with anyone else's.
 */
export async function alarmKpis({ sinceTs, untilTs = Date.now(), register, operatorPositions = 1 } = {}) {
  const raised = await readEvents({ sinceTs, untilTs, limit: 100_000, types: ['alarm.raised'] });
  const acked = await readEvents({ sinceTs, untilTs, limit: 100_000, types: ['alarm.acknowledged'] });
  const windowMs = Math.max(1, untilTs - sinceTs);
  const hours = windowMs / 3_600_000;

  /* ---- rate ---- */
  const total = raised.length;
  const perHour = Math.round((total / hours / operatorPositions) * 10) / 10;

  /* ---- 10-minute bins, peak and flood ---- */
  const BIN = 600_000;
  const binCount = Math.max(1, Math.ceil(windowMs / BIN));
  const bins = new Array(binCount).fill(0);
  for (const ev of raised) {
    const i = Math.min(binCount - 1, Math.max(0, Math.floor((ev.ts - sinceTs) / BIN)));
    bins[i] += 1;
  }
  const peak = bins.length ? Math.max(...bins) : 0;
  const floodBins = bins.filter((n) => n > EEMUA_TARGETS.peakPer10Min).length;
  const floodPct = Math.round((floodBins / binCount) * 1000) / 10;

  /* ---- top contributors ---- */
  const byTag = new Map();
  for (const ev of raised) {
    const k = ev.tag ?? 'UNKNOWN';
    const e = byTag.get(k) ?? { tag: k, count: 0, subjects: new Set() };
    e.count += 1;
    if (ev.name) e.subjects.add(ev.name);
    byTag.set(k, e);
  }
  const contributors = [...byTag.values()]
    .map((e) => ({
      tag: e.tag,
      name: safeName(e.tag),
      count: e.count,
      pct: total ? Math.round((e.count / total) * 1000) / 10 : 0,
      distinctSubjects: e.subjects.size,
    }))
    .sort((a, b) => b.count - a.count);
  const topTen = contributors.slice(0, 10);
  const topTenPct = total ? Math.round((topTen.reduce((s, c) => s + c.count, 0) / total) * 1000) / 10 : 0;

  /* ---- worst offending devices ---- */
  const bySubject = new Map();
  for (const ev of raised) {
    if (!ev.cameraId) continue;
    const e = bySubject.get(ev.cameraId) ?? { id: ev.cameraId, name: ev.name, group: ev.group, count: 0, tags: new Set() };
    e.count += 1;
    e.tags.add(ev.tag);
    bySubject.set(ev.cameraId, e);
  }
  const worstDevices = [...bySubject.values()]
    .map((e) => ({ ...e, tags: [...e.tags] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  /* ---- priority mix of actual traffic (the target the standard really sets) ---- */
  const mix = { diagnostic: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const ev of raised) mix[ev.priority ?? 'low'] = (mix[ev.priority ?? 'low'] ?? 0) + 1;
  const annunciated = total - mix.diagnostic;
  const pctOf = (n) => (annunciated ? Math.round((n / annunciated) * 1000) / 10 : 0);
  const priorityMix = {
    counts: mix,
    percentages: {
      low: pctOf(mix.low), medium: pctOf(mix.medium),
      high: pctOf(mix.high), critical: pctOf(mix.critical),
      highOrAbove: pctOf(mix.high + mix.critical),
    },
    target: EEMUA_TARGETS.priorityMix,
    withinTarget: pctOf(mix.high + mix.critical) <= EEMUA_TARGETS.priorityMix.highOrAbove * 3,
  };

  /* ---- acknowledgement responsiveness ---- */
  const responseTimes = acked.map((e) => e.responseMs).filter((n) => Number.isFinite(n) && n >= 0);
  const meanAckMs = responseTimes.length
    ? Math.round(responseTimes.reduce((s, n) => s + n, 0) / responseTimes.length)
    : null;
  const medianAckMs = responseTimes.length ? median(responseTimes) : null;

  /* ---- live register state ---- */
  const instances = register ? [...register.instances.values()] : [];
  const standing = register ? register.standing(untilTs) : [];
  const chattering = instances.filter((i) => i.chattering);
  const shelved = instances.filter((i) => i.state === STATE.SHELVED);
  const outOfService = instances.filter((i) => i.state === STATE.OUT_OF_SERVICE);
  const suppressed = instances.filter((i) => i.state === STATE.SUPPRESSED);
  const unacked = register ? register.unacknowledged() : [];
  const active = instances.filter((i) => ACTIVE_STATES.has(i.state));

  return {
    window: { sinceTs, untilTs, hours: Math.round(hours * 10) / 10 },
    operatorPositions,

    rate: {
      total,
      perHour,
      per10Min: Math.round((total / (windowMs / BIN)) * 10) / 10,
      target: EEMUA_TARGETS.alarmsPerHourAcceptable,
      verdict: verdict(perHour <= EEMUA_TARGETS.alarmsPerHourAcceptable, perHour <= EEMUA_TARGETS.alarmsPerHourManageable),
    },
    peak: {
      value: peak,
      target: EEMUA_TARGETS.peakPer10Min,
      verdict: verdict(peak <= EEMUA_TARGETS.peakPer10Min),
    },
    flood: {
      periods: floodBins,
      totalPeriods: binCount,
      pct: floodPct,
      target: EEMUA_TARGETS.floodPctMax,
      verdict: verdict(floodPct < EEMUA_TARGETS.floodPctMax),
    },
    standing: {
      count: standing.length,
      target: EEMUA_TARGETS.standingMax,
      verdict: verdict(standing.length < EEMUA_TARGETS.standingMax),
      items: standing.slice(0, 20).map(summarise),
    },
    topContributors: {
      items: topTen,
      topTenPct,
      target: EEMUA_TARGETS.topTenPctMax,
      // A high concentration means a handful of conditions are producing most of the
      // load — which is good news: fixing a few things fixes most of the noise.
      verdict: topTenPct <= EEMUA_TARGETS.topTenPctMax ? 'acceptable' : 'concentrated — a few conditions dominate the load',
    },
    worstDevices,
    priorityMix,
    acknowledgement: {
      total: acked.length,
      meanMs: meanAckMs,
      medianMs: medianAckMs,
      outstanding: unacked.length,
    },
    registerState: {
      active: active.length,
      unacknowledged: unacked.length,
      chattering: chattering.length,
      shelved: shelved.length,
      suppressed: suppressed.length,
      outOfService: outOfService.length,
      chatteringItems: chattering.slice(0, 10).map(summarise),
      shelvedItems: shelved.map((i) => ({ ...summarise(i), until: i.shelvedUntil, reason: i.shelveReason, by: i.shelvedBy })),
      outOfServiceItems: outOfService.map((i) => ({ ...summarise(i), reason: i.outOfServiceReason, by: i.outOfServiceBy })),
    },

    /** One line the report can lead with. */
    overall: overallVerdict({ perHour, peak, floodPct, standingCount: standing.length }),
  };
}

function overallVerdict({ perHour, peak, floodPct, standingCount }) {
  const failures = [];
  if (perHour > EEMUA_TARGETS.alarmsPerHourManageable) failures.push(`alarm rate ${perHour}/h is above the manageable limit of ${EEMUA_TARGETS.alarmsPerHourManageable}`);
  else if (perHour > EEMUA_TARGETS.alarmsPerHourAcceptable) failures.push(`alarm rate ${perHour}/h exceeds the acceptable target of ${EEMUA_TARGETS.alarmsPerHourAcceptable}`);
  if (peak > EEMUA_TARGETS.peakPer10Min) failures.push(`peak of ${peak} alarms in 10 minutes exceeded the flood threshold`);
  if (floodPct >= EEMUA_TARGETS.floodPctMax) failures.push(`${floodPct}% of the period was in alarm flood`);
  if (standingCount >= EEMUA_TARGETS.standingMax) failures.push(`${standingCount} standing alarms (target below ${EEMUA_TARGETS.standingMax})`);

  if (!failures.length) {
    return { status: 'acceptable', summary: 'Alarm system performance is within EEMUA 191 targets.', failures };
  }
  return {
    status: failures.length >= 3 ? 'overloaded' : 'above target',
    summary: failures.length >= 3
      ? 'Alarm system is overloaded: operators cannot reliably triage at this rate, and important alarms will be missed.'
      : 'Alarm system performance is outside EEMUA 191 targets.',
    failures,
  };
}

function summarise(i) {
  return {
    key: i.key,
    tag: i.tag,
    name: safeName(i.tag),
    subject: i.subjectName,
    group: i.subjectGroup,
    priority: effectivePriority(i),
    state: i.state,
    raisedAt: i.raisedAt,
    occurrences: i.occurrences,
    detail: i.detail,
  };
}

function safeName(tag) {
  try { return getAlarmDef(tag).name; } catch { return tag; }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Rank annunciated alarms for display: priority, then age. */
export function rankAlarms(instances) {
  return [...instances].sort((a, b) =>
    PRIORITY_RANK[effectivePriority(b)] - PRIORITY_RANK[effectivePriority(a)]
    || (a.raisedAt ?? 0) - (b.raisedAt ?? 0));
}
