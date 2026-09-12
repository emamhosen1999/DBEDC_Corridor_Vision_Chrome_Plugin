/**
 * Durable state.
 *
 * Three stores, deliberately boring:
 *   1. `data/state.json`               — current truth. Small, rewritten atomically.
 *   2. `data/events/events-*.jsonl`    — append-only transition log, rotated daily.
 *   3. `data/snapshots/samples-*.jsonl`— one fleet count per cycle, for SLA + trends.
 *
 * No database. A monitoring box that will sit untouched for a year should not have a
 * binary file format that can corrupt, or a native dependency that can fail to build
 * after a Node upgrade. JSONL survives partial writes (you lose at most the last
 * line), is greppable from a support session, and rsyncs incrementally.
 *
 * The old extension wrote 2,100 trend snapshots and never read one (finding H8).
 * Here every sample feeds the SLA figures in the daily digest.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DIRS, FILES, ensureDirs } from './paths.mjs';
import { dayKey } from './time.mjs';
import { createMutex } from './pool.mjs';
import { log } from './logger.mjs';

const logger = log('store');
const stateLock = createMutex();

/** Atomic write: a torn state.json on a power cut would lose the whole fleet history. */
async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, file);
}

/* ------------------------------------------------------------------ state --- */

const EMPTY_STATE = {
  version: 2,
  cameras: {},        // id -> { status, since, lastChange, consecutiveDown, consecutiveUp, flapEvents: [], escalated: [], lastProbe, detail }
  fleet: { total: 0, up: 0, down: 0, degraded: 0, unknown: 0 },
  cycle: { count: 0, lastStartedAt: 0, lastFinishedAt: 0, lastDurationMs: 0, lastError: null },
  network: { healthy: true, since: 0, lastCheck: 0 },
  alerts: { lastSentAt: {}, sentThisHour: {}, hourKey: '', lastDigestDay: {}, watchdogNotifiedAt: 0 },
  startedAt: 0,
};

let stateCache = null;

export async function loadState() {
  if (stateCache) return stateCache;
  ensureDirs();
  try {
    const raw = await fsp.readFile(FILES.state, 'utf8');
    const parsed = JSON.parse(raw);
    stateCache = { ...structuredClone(EMPTY_STATE), ...parsed };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // A corrupt state file must not stop monitoring — quarantine it and start clean.
      logger.error('state.json unreadable, starting from empty state', { error: err.message });
      try { await fsp.rename(FILES.state, `${FILES.state}.corrupt-${Date.now()}`); } catch { /* best effort */ }
    }
    stateCache = structuredClone(EMPTY_STATE);
  }
  return stateCache;
}

/**
 * Read-modify-write under a mutex. Every mutation of shared state goes through here,
 * which is precisely what the old extension lacked (finding B3: concurrent alarm poll
 * and manual refresh silently overwrote each other's events).
 */
export function updateState(mutator) {
  return stateLock(async () => {
    const state = await loadState();
    const result = await mutator(state);
    await writeAtomic(FILES.state, JSON.stringify(state, null, 2));
    stateCache = state;
    return result;
  });
}

/* ------------------------------------------------------------------ events --- */

function eventFile(ts) {
  return path.join(DIRS.events, `events-${dayKey(ts)}.jsonl`);
}

let eventSeq = 0;

/** Append one event. Never throws — losing the log must not stop the monitor. */
export async function appendEvent(event) {
  ensureDirs();
  const rec = { id: `${Date.now().toString(36)}-${(eventSeq++).toString(36)}`, ts: Date.now(), ...event };
  try {
    await fsp.appendFile(eventFile(rec.ts), JSON.stringify(rec) + '\n');
  } catch (err) {
    logger.error('failed to append event', { error: err.message, type: rec.type });
  }
  return rec;
}

/** Read events newest-first, optionally filtered. Reads only the days it needs. */
export async function readEvents({ sinceTs = 0, untilTs = Date.now(), limit = 500, types, cameraId } = {}) {
  ensureDirs();
  let files;
  try {
    files = (await fsp.readdir(DIRS.events)).filter((f) => f.startsWith('events-') && f.endsWith('.jsonl')).sort().reverse();
  } catch { return []; }

  const typeSet = types ? new Set([].concat(types)) : null;
  const out = [];
  for (const name of files) {
    // events-YYYY-MM-DD.jsonl — skip whole days that cannot contain matches.
    const day = name.slice(7, 17);
    if (sinceTs && Date.parse(`${day}T23:59:59Z`) < sinceTs - 86_400_000) break;
    let text;
    try { text = await fsp.readFile(path.join(DIRS.events, name), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; } // tolerate a torn final line
      if (rec.ts < sinceTs || rec.ts > untilTs) continue;
      if (typeSet && !typeSet.has(rec.type)) continue;
      if (cameraId && rec.cameraId !== cameraId) continue;
      out.push(rec);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/* ----------------------------------------------------------------- samples --- */

function sampleFile(ts) {
  return path.join(DIRS.snapshots, `samples-${dayKey(ts)}.jsonl`);
}

export async function appendSample(sample) {
  ensureDirs();
  const rec = { ts: Date.now(), ...sample };
  try {
    await fsp.appendFile(sampleFile(rec.ts), JSON.stringify(rec) + '\n');
  } catch (err) {
    logger.error('failed to append sample', { error: err.message });
  }
  return rec;
}

/** Read samples in chronological order for a time range. */
export async function readSamples({ sinceTs = Date.now() - 86_400_000, untilTs = Date.now() } = {}) {
  ensureDirs();
  let files;
  try {
    files = (await fsp.readdir(DIRS.snapshots)).filter((f) => f.startsWith('samples-')).sort();
  } catch { return []; }
  const out = [];
  for (const name of files) {
    const day = name.slice(8, 18);
    if (Date.parse(`${day}T23:59:59Z`) < sinceTs - 86_400_000) continue;
    if (Date.parse(`${day}T00:00:00Z`) > untilTs + 86_400_000) continue;
    let text;
    try { text = await fsp.readFile(path.join(DIRS.snapshots, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.ts >= sinceTs && rec.ts <= untilTs) out.push(rec);
      } catch { /* torn line */ }
    }
  }
  return out;
}

/* --------------------------------------------------------------- inventory --- */

export async function loadInventory() {
  try {
    // Strip a UTF-8 BOM: inventory.json is routinely hand-edited on Windows, where
    // Notepad and PowerShell 5.1 both prepend one. Without this, a BOM would be
    // indistinguishable from a corrupt file and the whole fleet would read as empty.
    const text = (await fsp.readFile(FILES.inventory, 'utf8')).replace(/^﻿/, '');
    return JSON.parse(text);
  } catch (err) {
    if (err.code !== 'ENOENT') logger.error('inventory unreadable', { error: err.message });
    return { version: 2, updatedAt: 0, cameras: [] };
  }
}

export async function saveInventory(inv) {
  ensureDirs();
  const payload = { ...inv, version: 2, updatedAt: Date.now() };
  await writeAtomic(FILES.inventory, JSON.stringify(payload, null, 2));
  return payload;
}

/* ---------------------------------------------------------------- retention --- */

/** Delete event/sample files older than the configured retention. */
export async function prune(retention) {
  ensureDirs();
  const jobs = [
    [DIRS.events, 'events-', retention.eventDays],
    [DIRS.snapshots, 'samples-', retention.snapshotDays],
  ];
  let removed = 0;
  for (const [dir, prefix, days] of jobs) {
    const cutoff = Date.now() - days * 86_400_000;
    let names;
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const file = path.join(dir, name);
      try {
        if ((await fsp.stat(file)).mtimeMs < cutoff) { await fsp.unlink(file); removed++; }
      } catch { /* best effort */ }
    }
  }
  if (removed) logger.info('pruned old data files', { removed });
  return removed;
}

/** Free-space guard: a monitoring box that fills its disk stops monitoring silently. */
export async function diskPressure() {
  try {
    const stat = await fsp.statfs(DIRS.data);
    const freeBytes = stat.bavail * stat.bsize;
    const totalBytes = stat.blocks * stat.bsize;
    return { freeBytes, totalBytes, freePct: totalBytes ? (freeBytes / totalBytes) * 100 : 100 };
  } catch {
    return { freeBytes: Infinity, totalBytes: Infinity, freePct: 100 };
  }
}

export function _resetForTests() { stateCache = null; }
export { EMPTY_STATE };
