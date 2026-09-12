/**
 * Persisted delivery queue.
 *
 * An alert that failed to send because the ADSL line was down for ninety seconds must
 * not be lost — that is exactly the moment the alert mattered. Every outbound message
 * is written to `data/outbox.json` before the first send attempt and removed only on
 * confirmed success, so the queue survives a crash, a restart and a power cut.
 *
 * Retries use exponential backoff with jitter, and a message that is older than
 * `retention.outboxMaxAge` is dropped with a logged reason rather than retried
 * forever — a day-old "camera offline" message arriving now is misinformation.
 */
import fs from 'node:fs/promises';
import { FILES, ensureDirs } from '../core/paths.mjs';
import { createMutex } from '../core/pool.mjs';
import { log } from '../core/logger.mjs';

const logger = log('queue');
const lock = createMutex();

const BACKOFF_MS = [0, 15_000, 60_000, 300_000, 900_000, 3_600_000];
const MAX_QUEUE = 2000;

let queue = null;
let seq = 0;

async function read() {
  if (queue) return queue;
  ensureDirs();
  try {
    const raw = await fs.readFile(FILES.outbox, 'utf8');
    queue = JSON.parse(raw);
    if (!Array.isArray(queue.items)) queue = { items: [], history: [] };
  } catch {
    queue = { items: [], history: [] };
  }
  return queue;
}

async function persist() {
  const tmp = `${FILES.outbox}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(queue, null, 2));
  await fs.rename(tmp, FILES.outbox);
}

/** Add a message for a channel. Returns the queued item. */
export function enqueue({ channel, alertType, severity, title, text, payload }) {
  return lock(async () => {
    const q = await read();
    const item = {
      id: `${Date.now().toString(36)}-${(seq++).toString(36)}`,
      channel, alertType, severity, title, text, payload,
      createdAt: Date.now(),
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastError: null,
    };
    q.items.push(item);
    // Bound the queue: if a channel has been broken for a day, keep the newest.
    if (q.items.length > MAX_QUEUE) {
      const dropped = q.items.splice(0, q.items.length - MAX_QUEUE);
      logger.warn('outbox overflow, dropped oldest messages', { dropped: dropped.length });
    }
    await persist();
    return item;
  });
}

/** Items that are due for a send attempt right now. */
export function due(now = Date.now()) {
  return lock(async () => {
    const q = await read();
    return q.items.filter((i) => i.nextAttemptAt <= now);
  });
}

/** Mark an item delivered; it moves to the history ring for the dashboard. */
export function markSent(id, info = {}) {
  return lock(async () => {
    const q = await read();
    const i = q.items.findIndex((x) => x.id === id);
    if (i === -1) return null;
    const [item] = q.items.splice(i, 1);
    q.history.unshift({
      id: item.id, channel: item.channel, alertType: item.alertType, severity: item.severity,
      title: item.title, sentAt: Date.now(), attempts: item.attempts + 1, ok: true, ...info,
    });
    q.history = q.history.slice(0, 300);
    await persist();
    return item;
  });
}

/** Record a failure and schedule the next attempt, or give up. */
export function markFailed(id, error, { maxAgeMs = 86_400_000, permanent = false } = {}) {
  return lock(async () => {
    const q = await read();
    const item = q.items.find((x) => x.id === id);
    if (!item) return null;
    item.attempts += 1;
    item.lastError = String(error?.message ?? error).slice(0, 500);

    const tooOld = Date.now() - item.createdAt > maxAgeMs;
    const exhausted = item.attempts >= BACKOFF_MS.length;
    if (permanent || tooOld || exhausted) {
      q.items = q.items.filter((x) => x.id !== id);
      q.history.unshift({
        id: item.id, channel: item.channel, alertType: item.alertType, severity: item.severity,
        title: item.title, sentAt: Date.now(), attempts: item.attempts, ok: false,
        error: item.lastError,
        reason: permanent ? 'permanent-failure' : tooOld ? 'too-old-to-be-useful' : 'retries-exhausted',
      });
      q.history = q.history.slice(0, 300);
      logger.error('giving up on message', {
        channel: item.channel, type: item.alertType, attempts: item.attempts, error: item.lastError,
      });
    } else {
      const base = BACKOFF_MS[item.attempts] ?? BACKOFF_MS.at(-1);
      item.nextAttemptAt = Date.now() + base + Math.round(Math.random() * base * 0.3);
      logger.warn('delivery failed, will retry', {
        channel: item.channel, attempt: item.attempts, inMs: item.nextAttemptAt - Date.now(), error: item.lastError,
      });
    }
    await persist();
    return item;
  });
}

/** Queue depth and the recent delivery log, for the dashboard. */
export function stats() {
  return lock(async () => {
    const q = await read();
    const byChannel = {};
    for (const i of q.items) byChannel[i.channel] = (byChannel[i.channel] ?? 0) + 1;
    return {
      pending: q.items.length,
      byChannel,
      oldestAt: q.items.length ? Math.min(...q.items.map((i) => i.createdAt)) : null,
      history: q.history.slice(0, 100),
    };
  });
}

export function clearHistory() {
  return lock(async () => { const q = await read(); q.history = []; await persist(); });
}

export function _resetForTests() { queue = null; }
