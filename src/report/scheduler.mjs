/**
 * Report scheduling and the report of record.
 *
 * Two things this does that a plain timer would not:
 *
 * 1. **Sequential numbering that survives restarts.** Reports are numbered per local
 *    day (CV-DBE-20260912-003). A gap in the sequence is evidence that a report was
 *    missed, which is exactly the kind of thing an auditor asks about — so the counter
 *    is persisted, not derived from an in-memory tick.
 *
 * 2. **Catch-up without spam.** If the service was down over two scheduled slots, it
 *    does not fire two reports on restart. It issues one, covering the whole elapsed
 *    period, and says in the report that coverage was interrupted. Reporting a period
 *    you were not watching as though you were is worse than not reporting it.
 *
 * Both fixed intervals ("every 6 hours") and wall-clock times ("06:00, 14:00, 22:00")
 * are supported, because sites want one or the other and arguing about it wastes time.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DIRS, ensureDirs } from '../core/paths.mjs';
import { updateState, loadState } from '../core/store.mjs';
import { dayKey, minuteOfDay, parseHHMM } from '../core/time.mjs';
import { buildReportModel } from './model.mjs';
import { render } from './render.mjs';
import { log } from '../core/logger.mjs';

const logger = log('report');

/**
 * When is the next report due?
 * Returns `{ dueAt, periodMs, reason }`, or null when reporting is off.
 */
export function nextDue(cfg, { lastIssuedAt = 0, now = Date.now() } = {}) {
  const r = cfg.reporting;
  if (!r?.enabled) return null;
  const tz = cfg.site.timezone;

  if (r.mode === 'times' && r.times?.length) {
    // Wall-clock slots. Find the next slot strictly after `now`, in site-local time.
    const minutes = [...new Set(r.times.map(parseHHMM).filter((m) => m !== null))].sort((a, b) => a - b);
    if (!minutes.length) return null;
    const nowMin = minuteOfDay(now, tz);
    // Local midnight, derived from the site-local minute-of-day so it is correct in
    // any timezone offset, including the half-hour ones.
    const midnight = now - nowMin * 60_000 - (now % 60_000);

    const upcomingIdx = minutes.findIndex((m) => m > nowMin);
    const nextMin = upcomingIdx === -1 ? minutes[0] + 1440 : minutes[upcomingIdx];
    const dueAt = midnight + nextMin * 60_000;

    // The period this report will cover runs from the preceding slot to that one.
    const prevMin = upcomingIdx === -1
      ? minutes.at(-1)                                  // wrapping past midnight
      : (upcomingIdx === 0 ? minutes.at(-1) - 1440 : minutes[upcomingIdx - 1]);
    return {
      dueAt,
      periodMs: (nextMin - prevMin) * 60_000,
      reason: 'scheduled time',
    };
  }

  const intervalMs = Math.max(60_000, (r.intervalMinutes ?? 360) * 60_000);
  const base = lastIssuedAt || now;
  return { dueAt: base + intervalMs, periodMs: intervalMs, reason: 'interval' };
}

/** Claim the next sequence number for the local day. Persisted, so gaps are visible. */
async function claimSequence(cfg, now) {
  const day = dayKey(now, cfg.site.timezone);
  return updateState((s) => {
    s.reporting ??= {};
    if (s.reporting.day !== day) { s.reporting.day = day; s.reporting.counter = 0; }
    s.reporting.counter += 1;
    return { number: s.reporting.counter, day };
  });
}

/**
 * Produce a report and persist it as the record.
 *
 * `periodMs` defaults to the time since the last report actually issued, so a report
 * always covers the ground since the previous one rather than a nominal window that
 * may not match reality.
 */
export async function produceReport({
  cfg, register, now = Date.now(), periodMs, label = 'Scheduled report', trigger = 'schedule', formats,
} = {}) {
  ensureDirs();
  const state = await loadState();
  const lastIssuedAt = state.reporting?.lastIssuedAt ?? 0;
  const effectivePeriod = periodMs
    ?? (lastIssuedAt ? Math.max(60_000, now - lastIssuedAt) : (cfg.reporting?.intervalMinutes ?? 360) * 60_000);

  const sequence = await claimSequence(cfg, now);
  const model = await buildReportModel({ cfg, register, periodMs: effectivePeriod, at: now, sequence, label, trigger });

  const due = nextDue(cfg, { lastIssuedAt: now, now });
  if (due) model.meta.nextReportAt = due.dueAt;

  const wanted = formats ?? cfg.reporting?.formats ?? ['text', 'html', 'csv', 'json'];
  const rendered = {};
  for (const format of wanted) {
    try {
      rendered[format] = render(model, format, format === 'text' ? { fullRegister: cfg.reporting?.fullRegister !== false, maxChars: cfg.reporting?.maxChars ?? 3500 } : undefined);
    } catch (err) {
      logger.error('renderer failed', { format, error: err.message });
    }
  }

  const files = await persist(model, rendered, cfg);

  await updateState((s) => {
    s.reporting ??= {};
    s.reporting.lastIssuedAt = now;
    s.reporting.lastReportId = model.meta.reportId;
    s.reporting.lastFiles = files;
  });

  logger.info('report issued', {
    reportId: model.meta.reportId,
    devices: model.devices.length,
    exceptions: model.exceptions.length,
    outstandingAlarms: model.alarms.outstanding.length,
    formats: Object.keys(rendered),
  });

  return { model, rendered, files, sequence };
}

/** Write the report of record to disk and prune old ones. */
async function persist(model, rendered, cfg) {
  const dir = path.join(DIRS.exports, 'reports', dayKey(model.meta.generatedAt, cfg.site.timezone));
  await fsp.mkdir(dir, { recursive: true });
  const ext = { text: 'txt', html: 'html', csv: 'csv', 'alarm-csv': 'alarms.csv', json: 'json' };
  const files = {};
  for (const [format, content] of Object.entries(rendered)) {
    const body = Array.isArray(content) ? content.join('\n\n') : content;
    const file = path.join(dir, `${model.meta.reportId}.${ext[format] ?? format}`);
    try {
      await fsp.writeFile(file, body);
      files[format] = file;
    } catch (err) {
      logger.error('could not write report file', { file, error: err.message });
    }
  }
  await pruneReports(cfg).catch(() => {});
  return files;
}

async function pruneReports(cfg) {
  const root = path.join(DIRS.exports, 'reports');
  const keepDays = cfg.reporting?.retentionDays ?? 365;
  const cutoff = Date.now() - keepDays * 86_400_000;
  let dirs;
  try { dirs = await fsp.readdir(root); } catch { return; }
  for (const name of dirs) {
    const full = path.join(root, name);
    try {
      if ((await fsp.stat(full)).mtimeMs < cutoff) await fsp.rm(full, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

/** List reports of record, newest first. */
export async function listReports({ limit = 50 } = {}) {
  const root = path.join(DIRS.exports, 'reports');
  const out = [];
  let days;
  try { days = (await fsp.readdir(root)).sort().reverse(); } catch { return out; }
  for (const day of days) {
    let files;
    try { files = await fsp.readdir(path.join(root, day)); } catch { continue; }
    const byId = new Map();
    for (const f of files) {
      const id = f.split('.')[0];
      const entry = byId.get(id) ?? { reportId: id, day, formats: [] };
      entry.formats.push(f.slice(id.length + 1));
      byId.set(id, entry);
    }
    for (const entry of [...byId.values()].sort((a, b) => b.reportId.localeCompare(a.reportId))) {
      let stat = null;
      try { stat = await fsp.stat(path.join(root, day, `${entry.reportId}.json`)); } catch { /* ignore */ }
      out.push({ ...entry, at: stat?.mtimeMs ?? null });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Read one stored report back in a given format. */
export async function readReport(reportId, format = 'html') {
  const ext = { text: 'txt', html: 'html', csv: 'csv', 'alarm-csv': 'alarms.csv', json: 'json' }[format] ?? format;
  const root = path.join(DIRS.exports, 'reports');
  let days;
  try { days = await fsp.readdir(root); } catch { return null; }
  for (const day of days) {
    const file = path.join(root, day, `${reportId}.${ext}`);
    try { return await fsp.readFile(file, 'utf8'); } catch { /* next day */ }
  }
  return null;
}
