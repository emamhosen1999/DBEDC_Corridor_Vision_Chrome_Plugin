/**
 * Structured logger with size-based rotation.
 *
 * Writes newline-delimited JSON to logs/corridor-<date>.log and a human line to
 * stdout. A Windows service has no console, so the file is the only record — it
 * rotates by size and prunes by age so an unattended box cannot fill its disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './paths.mjs';
import { dayKey } from './time.mjs';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const COLOURS = { trace: '\x1b[90m', debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', fatal: '\x1b[35m' };

let minLevel = LEVELS.info;
let toFile = true;
let maxBytes = 16 * 1024 * 1024;
let keepDays = 30;
let stream = null;
let streamDay = null;
let written = 0;

export function configureLogger({ level = 'info', file = true, maxFileBytes, retentionDays } = {}) {
  minLevel = LEVELS[level] ?? LEVELS.info;
  toFile = file;
  if (maxFileBytes) maxBytes = maxFileBytes;
  if (retentionDays) keepDays = retentionDays;
}

function openStream() {
  const day = dayKey(Date.now());
  if (stream && streamDay === day && written < maxBytes) return stream;
  if (stream) { try { stream.end(); } catch { /* already closed */ } }
  fs.mkdirSync(DIRS.logs, { recursive: true });
  let file = path.join(DIRS.logs, `corridor-${day}.log`);
  // Same-day rollover once the active file exceeds maxBytes.
  if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) {
    let n = 1;
    while (fs.existsSync(path.join(DIRS.logs, `corridor-${day}.${n}.log`))) n++;
    file = path.join(DIRS.logs, `corridor-${day}.${n}.log`);
  }
  written = fs.existsSync(file) ? fs.statSync(file).size : 0;
  stream = fs.createWriteStream(file, { flags: 'a' });
  stream.on('error', () => { toFile = false; }); // never let logging kill the service
  streamDay = day;
  pruneOld();
  return stream;
}

function pruneOld() {
  try {
    const cutoff = Date.now() - keepDays * 86_400_000;
    for (const name of fs.readdirSync(DIRS.logs)) {
      if (!name.startsWith('corridor-')) continue;
      const p = path.join(DIRS.logs, name);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch { /* pruning is best-effort */ }
}

function emit(level, scope, msg, fields) {
  if (LEVELS[level] < minLevel) return;
  const rec = { ts: new Date().toISOString(), level, scope, msg, ...fields };
  const colour = COLOURS[level] ?? '';
  const extra = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
  // eslint-disable-next-line no-console
  console[level === 'error' || level === 'fatal' ? 'error' : 'log'](
    `${colour}${level.toUpperCase().padEnd(5)}\x1b[0m [${scope}] ${msg}${extra}`,
  );
  if (!toFile) return;
  try {
    const line = JSON.stringify(rec) + '\n';
    written += Buffer.byteLength(line);
    openStream().write(line);
  } catch { /* disk full or locked — stdout already has it */ }
}

/** Create a logger bound to a scope, e.g. `log('probe')`. */
export function log(scope) {
  return {
    trace: (m, f) => emit('trace', scope, m, f),
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    fatal: (m, f) => emit('fatal', scope, m, f),
  };
}

/** Flush and close the log stream (called on shutdown). */
export async function closeLogger() {
  if (!stream) return;
  await new Promise((r) => stream.end(r));
  stream = null;
}
