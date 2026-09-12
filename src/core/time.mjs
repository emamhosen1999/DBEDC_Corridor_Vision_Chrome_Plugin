/**
 * Time formatting.
 *
 * Every timestamp the operator sees is rendered in the *site's* timezone, not the
 * host's. A report pasted into an ops group is read as fact; stamping it with the
 * monitoring PC's accidental timezone (the old extension's bug M3) makes it a lie.
 */

const HOUR = 3600_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

/** Format an epoch-ms instant in `tz`, e.g. "2026-09-12 14:05". */
export function fmtTime(ts, tz = 'UTC', opts = {}) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
    ...opts,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** Clock only, e.g. "14:05". */
export function fmtClock(ts, tz = 'UTC') {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ts));
}

/** Short date+clock for timelines, e.g. "12 Sep 14:05". */
export function fmtShort(ts, tz = 'UTC') {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ts)).replace(',', '');
}

/**
 * Human duration that does not fall apart past a day — the old extension rendered a
 * five-day outage as "121h 30m" (finding M2).
 */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < MINUTE) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** Relative age, e.g. "4m ago". */
export function fmtAgo(ts, now = Date.now()) {
  if (!ts) return 'never';
  const delta = now - ts;
  if (delta < 5000) return 'just now';
  return `${fmtDuration(delta)} ago`;
}

/** The wall-clock minute-of-day (0..1439) at `ts` in timezone `tz`. */
export function minuteOfDay(ts, tz = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ts));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/** The local calendar day key ("2026-09-12") at `ts` in timezone `tz`. */
export function dayKey(ts, tz = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ts));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Parse "HH:MM" to a minute-of-day, or null. */
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is `ts` inside the window [from,to) expressed as "HH:MM" strings in `tz`?
 * Windows that wrap midnight (22:00 → 07:00) are handled.
 */
export function inWindow(ts, from, to, tz = 'UTC') {
  const a = parseHHMM(from); const b = parseHHMM(to);
  if (a === null || b === null) return false;
  const now = minuteOfDay(ts, tz);
  return a <= b ? now >= a && now < b : now >= a || now < b;
}

export const ms = { MINUTE, HOUR, DAY };
