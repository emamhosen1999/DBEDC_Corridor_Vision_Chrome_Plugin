/**
 * Concurrency and retry primitives.
 *
 * Probing 500 cameras must not open 500 sockets at once — that trips connection
 * tracking on the corridor firewall and produces false "offline" verdicts, which is
 * the worst possible failure for a monitor. Everything fans out through a bounded
 * pool.
 */

/** Run `worker` over `items` with at most `limit` in flight. Order is preserved. */
export async function mapPool(items, limit, worker) {
  const list = [...items];
  const results = new Array(list.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit | 0 || 1, list.length || 1));

  async function run() {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      try {
        results[i] = { ok: true, value: await worker(list[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: width }, run));
  return results;
}

/**
 * Reject after `ms` unless `promise` settles first.
 *
 * The timer is deliberately NOT unref'd. An unref'd timer stops holding the event
 * loop open, so if this race is the only outstanding work — a probe hanging during
 * the shutdown drain, say — Node drains and the timeout never fires, leaving the
 * caller blocked on a promise that can no longer settle. `clearTimeout` in `finally`
 * means it can never hold the process open past the race either way.
 */
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Note: this timer is deliberately NOT unref'd. An unref'd sleep lets the process
 * exit mid-await, which silently truncates retry backoff and shutdown drains.
 */
export const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Retry with exponential backoff and full jitter. Jitter matters: without it, a
 * corridor-wide outage makes every camera retry in lockstep and the retries
 * themselves become the next outage.
 */
export async function retry(fn, { attempts = 3, baseMs = 500, maxMs = 30_000, onRetry } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) break;
      const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delay = Math.round(Math.random() * ceiling);
      onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Single-flight guard. Wraps an async function so overlapping calls share one
 * execution instead of racing — this is the fix for the extension's lost-event bug
 * (finding B3), where an alarm poll and a manual refresh both did read-modify-write.
 */
export function singleFlight(fn) {
  let inflight = null;
  const wrapped = (...args) => {
    if (inflight) return inflight;
    inflight = Promise.resolve(fn(...args)).finally(() => { inflight = null; });
    return inflight;
  };
  wrapped.busy = () => inflight !== null;
  return wrapped;
}

/** Serialise async sections that must not interleave (read-modify-write on a file). */
export function createMutex() {
  let tail = Promise.resolve();
  return function lock(fn) {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}
