/**
 * Availability and SLA maths.
 *
 * The old extension wrote a trend snapshot every poll for fourteen days and never
 * read one (audit finding H8). Here every sample and every transition event feeds
 * real numbers: per-camera uptime, per-group uptime, fleet availability, MTBF and
 * MTTR — the figures a corridor operator is actually asked for in a monthly review.
 */
import { readEvents, readSamples } from '../core/store.mjs';
import { TRANSITION } from './detector.mjs';
import { dayKey } from '../core/time.mjs';

const DOWN_TYPES = new Set([TRANSITION.DOWN, TRANSITION.DEGRADED]);
const UP_TYPES = new Set([TRANSITION.UP, TRANSITION.RECOVERED_DEGRADED]);

/**
 * Reconstruct per-camera outage intervals from the event log, clipped to the window.
 *
 * Events only record *changes*, so an outage that began before the window opened has
 * no `down` event inside it. `currentStates` supplies that missing context: a camera
 * currently down since before `sinceTs` is counted as down from the window's start.
 */
export function buildOutageIntervals(events, { sinceTs, untilTs, currentStates = {} }) {
  const byCamera = new Map();
  for (const ev of [...events].sort((a, b) => a.ts - b.ts)) {
    if (!ev.cameraId) continue;
    if (!DOWN_TYPES.has(ev.type) && !UP_TYPES.has(ev.type)) continue;
    const list = byCamera.get(ev.cameraId) ?? [];
    list.push(ev);
    byCamera.set(ev.cameraId, list);
  }

  const intervals = new Map();
  const ids = new Set([...byCamera.keys(), ...Object.keys(currentStates)]);

  for (const id of ids) {
    const evs = byCamera.get(id) ?? [];
    const out = [];
    const state = currentStates[id];

    // Was it already down when the window opened? The first event in the window tells
    // us: if the first thing that happened was a recovery, it must have been down.
    let openedAt = null;
    const firstInWindow = evs[0];
    if (firstInWindow && UP_TYPES.has(firstInWindow.type)) openedAt = sinceTs;

    for (const ev of evs) {
      if (DOWN_TYPES.has(ev.type)) { openedAt ??= ev.ts; }
      else if (UP_TYPES.has(ev.type) && openedAt !== null) { out.push([openedAt, ev.ts]); openedAt = null; }
    }
    // Still open at the end of the window.
    if (openedAt !== null) out.push([openedAt, untilTs]);
    else if (!evs.length && state && (state.status === 'down' || state.status === 'degraded')) {
      out.push([Math.max(sinceTs, state.since ?? sinceTs), untilTs]);
    }

    intervals.set(id, out
      .map(([a, b]) => [Math.max(a, sinceTs), Math.min(b, untilTs)])
      .filter(([a, b]) => b > a));
  }
  return intervals;
}

/** Per-camera availability over a window. */
export async function cameraAvailability({ sinceTs, untilTs = Date.now(), states = {} }) {
  const events = await readEvents({ sinceTs, untilTs, limit: 100_000, types: [...DOWN_TYPES, ...UP_TYPES] });
  const intervals = buildOutageIntervals(events, { sinceTs, untilTs, currentStates: states });
  const windowMs = Math.max(1, untilTs - sinceTs);

  const rows = [];
  for (const [id, list] of intervals) {
    const downMs = list.reduce((sum, [a, b]) => sum + (b - a), 0);
    const outages = list.length;
    const state = states[id];
    rows.push({
      cameraId: id,
      name: state?.name ?? id,
      group: state?.group ?? 'Ungrouped',
      status: state?.status ?? 'unknown',
      downMs,
      outages,
      uptimePct: Math.round(((windowMs - downMs) / windowMs) * 10000) / 100,
      mttrMs: outages ? Math.round(downMs / outages) : 0,
      mtbfMs: outages ? Math.round((windowMs - downMs) / outages) : null,
      longestOutageMs: list.reduce((max, [a, b]) => Math.max(max, b - a), 0),
    });
  }
  return rows.sort((a, b) => a.uptimePct - b.uptimePct);
}

/** Group rollup from per-camera rows. */
export function groupAvailability(rows) {
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.group) ?? { group: r.group, cameras: 0, downMs: 0, outages: 0, worst: 100 };
    g.cameras++;
    g.downMs += r.downMs;
    g.outages += r.outages;
    g.worst = Math.min(g.worst, r.uptimePct);
    groups.set(r.group, g);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    uptimePct: Math.round((rows.filter((r) => r.group === g.group).reduce((s, r) => s + r.uptimePct, 0) / g.cameras) * 100) / 100,
  })).sort((a, b) => a.uptimePct - b.uptimePct);
}

/** Fleet availability over time, from the per-cycle samples. */
export async function fleetTrend({ sinceTs, untilTs = Date.now(), buckets = 96 }) {
  const samples = await readSamples({ sinceTs, untilTs });
  if (!samples.length) return { points: [], availabilityPct: null, samples: 0 };

  const width = Math.max(1, Math.round((untilTs - sinceTs) / buckets));
  const acc = new Map();
  for (const s of samples) {
    const key = Math.floor((s.ts - sinceTs) / width);
    const a = acc.get(key) ?? { ts: sinceTs + key * width, up: 0, down: 0, degraded: 0, total: 0, n: 0 };
    a.up += s.up ?? 0;
    a.down += s.down ?? 0;
    a.degraded += s.degraded ?? 0;
    a.total += s.total ?? 0;
    a.n++;
    acc.set(key, a);
  }
  const points = [...acc.values()].sort((a, b) => a.ts - b.ts).map((a) => ({
    ts: a.ts,
    up: Math.round(a.up / a.n),
    down: Math.round(a.down / a.n),
    degraded: Math.round(a.degraded / a.n),
    total: Math.round(a.total / a.n),
    healthyPct: a.total ? Math.round((a.up / a.total) * 1000) / 10 : null,
  }));

  const totalSlots = samples.reduce((s, x) => s + (x.total ?? 0), 0);
  const upSlots = samples.reduce((s, x) => s + (x.up ?? 0), 0);
  return {
    points,
    availabilityPct: totalSlots ? Math.round((upSlots / totalSlots) * 10000) / 100 : null,
    samples: samples.length,
  };
}

/** Daily availability rows, for the digest and for monthly reporting. */
export async function dailyAvailability({ days = 7, tz = 'UTC', states = {} }) {
  const untilTs = Date.now();
  const sinceTs = untilTs - days * 86_400_000;
  const samples = await readSamples({ sinceTs, untilTs });
  const byDay = new Map();
  for (const s of samples) {
    const key = dayKey(s.ts, tz);
    const d = byDay.get(key) ?? { day: key, up: 0, total: 0, n: 0, worstDown: 0 };
    d.up += s.up ?? 0;
    d.total += s.total ?? 0;
    d.worstDown = Math.max(d.worstDown, s.down ?? 0);
    d.n++;
    byDay.set(key, d);
  }
  const rows = [...byDay.values()].map((d) => ({
    day: d.day,
    samples: d.n,
    uptimePct: d.total ? Math.round((d.up / d.total) * 10000) / 100 : null,
    worstConcurrentDown: d.worstDown,
  })).sort((a, b) => a.day.localeCompare(b.day));

  // Availability for today so far, for the SLA-breach check.
  const today = rows.at(-1) ?? null;
  return { rows, today, cameras: Object.keys(states).length };
}
