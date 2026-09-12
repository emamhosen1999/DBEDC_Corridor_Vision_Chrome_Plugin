import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The queue reads paths at import time, so point CORRIDOR_HOME at a temp dir first.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-queue-'));
process.env.CORRIDOR_HOME = HOME;
const { enqueue, due, markSent, markFailed, stats, _resetForTests } = await import('../src/alerts/queue.mjs');

// Each test gets a clean outbox: the queue is a persisted file, so without this the
// items from one test are still "due" in the next.
test.beforeEach(() => {
  _resetForTests();
  fs.rmSync(path.join(HOME, 'data', 'outbox.json'), { force: true });
});

test('a queued message survives a restart', async () => {
  await enqueue({ channel: 'telegram', alertType: 'camera.down', severity: 'warning', title: 't', text: 'x' });
  _resetForTests();                                   // simulate a process restart: drop the in-memory copy only
  const items = await due();
  assert.equal(items.length, 1);
  assert.equal(items[0].channel, 'telegram');
});

test('a failure schedules a retry rather than dropping the alert', async () => {
  const item = await enqueue({ channel: 'telegram', alertType: 'camera.down', severity: 'warning', title: 't', text: 'x' });
  await markFailed(item.id, new Error('network down'));
  const pending = await due(Date.now());
  assert.equal(pending.length, 0, 'it should be waiting out its backoff, not due immediately');
  const later = await due(Date.now() + 3_600_000);
  assert.equal(later.length, 1);
  assert.equal(later[0].attempts, 1);
  assert.match(later[0].lastError, /network down/);
});

test('backoff grows between attempts', async () => {
  const item = await enqueue({ channel: 'x', alertType: 'a', severity: 'info', title: 't', text: 'x' });
  const delays = [];
  for (let i = 0; i < 3; i++) {
    const before = Date.now();
    const updated = await markFailed(item.id, new Error('again'));
    if (updated?.nextAttemptAt) delays.push(updated.nextAttemptAt - before);
  }
  assert.ok(delays[2] > delays[0], `backoff should grow: ${delays.join(', ')}`);
});

test('a permanent failure is not retried', async () => {
  const item = await enqueue({ channel: 'telegram', alertType: 'a', severity: 'info', title: 't', text: 'x' });
  await markFailed(item.id, new Error('bad token'), { permanent: true });
  assert.equal((await due(Date.now() + 86_400_000)).length, 0);
  const s = await stats();
  assert.equal(s.history[0].ok, false);
  assert.equal(s.history[0].reason, 'permanent-failure');
});

test('retries are abandoned once the message is too old to be useful', async () => {
  const item = await enqueue({ channel: 'x', alertType: 'a', severity: 'info', title: 't', text: 'x' });
  await markFailed(item.id, new Error('still down'), { maxAgeMs: -1 });
  assert.equal((await due(Date.now() + 86_400_000)).length, 0);
  assert.equal((await stats()).history[0].reason, 'too-old-to-be-useful');
});

test('a delivered message leaves the queue and lands in the history', async () => {
  const item = await enqueue({ channel: 'telegram', alertType: 'camera.up', severity: 'info', title: 'ok', text: 'x' });
  await markSent(item.id, { info: { messageIds: [7] } });
  assert.equal((await due(Date.now() + 1e9)).length, 0);
  const s = await stats();
  assert.equal(s.pending, 0);
  assert.equal(s.history[0].ok, true);
  assert.equal(s.history[0].channel, 'telegram');
});

test('queue stats break down by channel', async () => {
  await enqueue({ channel: 'telegram', alertType: 'a', severity: 'info', title: 't', text: 'x' });
  await enqueue({ channel: 'telegram', alertType: 'b', severity: 'info', title: 't', text: 'x' });
  await enqueue({ channel: 'email', alertType: 'c', severity: 'info', title: 't', text: 'x' });
  const s = await stats();
  assert.equal(s.pending, 3);
  assert.deepEqual(s.byChannel, { telegram: 2, email: 1 });
});
