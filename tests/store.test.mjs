import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-store-'));
process.env.CORRIDOR_HOME = HOME;
const store = await import('../src/core/store.mjs');

test('concurrent state updates never lose a write (audit finding B3)', async () => {
  await store.updateState((s) => { s.fleet.up = 0; });
  await Promise.all(Array.from({ length: 100 }, () => store.updateState((s) => { s.fleet.up += 1; })));
  assert.equal((await store.loadState()).fleet.up, 100);
});

test('state is written atomically and survives a reload', async () => {
  await store.updateState((s) => { s.cameras.x = { status: 'down', since: 123 }; });
  store._resetForTests();
  assert.equal((await store.loadState()).cameras.x.status, 'down');
});

test('a corrupt state file is quarantined, not fatal', async () => {
  fs.writeFileSync(path.join(HOME, 'data', 'state.json'), '{ this is not json');
  store._resetForTests();
  const s = await store.loadState();
  assert.equal(s.fleet.total, 0, 'falls back to an empty state');
  const quarantined = fs.readdirSync(path.join(HOME, 'data')).filter((f) => f.includes('corrupt'));
  assert.ok(quarantined.length, 'the bad file should be kept for diagnosis');
});

test('events round-trip and filter by type and camera', async () => {
  await store.appendEvent({ type: 'camera.down', cameraId: 'a', name: 'A' });
  await store.appendEvent({ type: 'camera.up', cameraId: 'a', name: 'A' });
  await store.appendEvent({ type: 'camera.down', cameraId: 'b', name: 'B' });
  assert.equal((await store.readEvents({ limit: 50 })).length, 3);
  assert.equal((await store.readEvents({ types: 'camera.down' })).length, 2);
  assert.equal((await store.readEvents({ cameraId: 'b' })).length, 1);
  const newest = await store.readEvents({ limit: 1 });
  assert.equal(newest[0].cameraId, 'b', 'events come back newest first');
});

test('a torn final line does not break the event reader', async () => {
  const { dayKey } = await import('../src/core/time.mjs');
  const file = path.join(HOME, 'data', 'events', `events-${dayKey(Date.now())}.jsonl`);
  fs.appendFileSync(file, '{"ts":1,"type":"trunc');       // a power cut mid-write
  const events = await store.readEvents({ limit: 50 });
  assert.ok(events.length >= 3, 'the intact lines must still be readable');
});

test('samples round-trip within a time window', async () => {
  await store.appendSample({ total: 10, up: 9, down: 1 });
  const samples = await store.readSamples({ sinceTs: 0 });
  assert.equal(samples.at(-1).up, 9);
  assert.equal((await store.readSamples({ sinceTs: Date.now() + 60_000 })).length, 0);
});

test('inventory round-trips', async () => {
  await store.saveInventory({ cameras: [{ id: 'a', name: 'A', host: '1.1.1.1' }] });
  const inv = await store.loadInventory();
  assert.equal(inv.cameras.length, 1);
  assert.ok(inv.updatedAt > 0);
});
