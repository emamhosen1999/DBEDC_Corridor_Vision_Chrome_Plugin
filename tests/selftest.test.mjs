import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(args, env = {}, timeout = 90_000) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(repo, 'src', 'cli.mjs'), ...args],
      { cwd: repo, timeout, env: { ...process.env, ...env }, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
}

test('the self-test passes end to end', { timeout: 120_000 }, async () => {
  const { code, stdout } = await run(['selftest']);
  assert.equal(code, 0, `self-test failed:\n${stdout}`);
  assert.match(stdout, /Self-test PASSED/);
  for (const stage of ['Environment', 'Simulated cameras', 'Inventory', 'Monitoring pipeline',
    'Alarm system', 'Reporting', 'Alert delivery']) {
    assert.ok(stdout.includes(stage), `self-test skipped the "${stage}" stage`);
  }
});

test('the self-test runs in isolation and never touches the real installation', { timeout: 120_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-isolation-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  // A deliberately distinctive real config: if the self-test reads it, we will see it.
  fs.writeFileSync(path.join(home, 'config', 'config.json'), JSON.stringify({
    site: { name: 'REAL-INSTALLATION-DO-NOT-TOUCH', timezone: 'UTC' },
    server: { port: 9911 },
  }));
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'inventory.json'),
    JSON.stringify({ version: 2, cameras: [{ id: 'real', name: 'Real Camera', host: '10.1.1.1', enabled: true }] }));

  const { code, stdout } = await run(['selftest'], { CORRIDOR_HOME: home });
  assert.equal(code, 0, stdout);
  assert.ok(!stdout.includes('REAL-INSTALLATION-DO-NOT-TOUCH'),
    'the self-test must not load the live configuration');
  assert.ok(!stdout.includes('Real Camera'), 'the self-test must not probe the real inventory');

  // The real inventory must be exactly as it was.
  const after = JSON.parse(fs.readFileSync(path.join(home, 'data', 'inventory.json'), 'utf8'));
  assert.equal(after.cameras.length, 1);
  assert.equal(after.cameras[0].name, 'Real Camera');
  // And no alarm register or report should have been written into it.
  assert.ok(!fs.existsSync(path.join(home, 'data', 'exports', 'reports')),
    'the self-test must not write reports into the live installation');

  fs.rmSync(home, { recursive: true, force: true });
});

test('the support bundle contains no plaintext credentials', { timeout: 60_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-support-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'config.json'), JSON.stringify({
    site: { name: 'Support Test', timezone: 'UTC' },
    channels: { telegram: { enabled: true, botToken: '@vault:telegram.botToken', chatId: '-100123' } },
  }));

  // Store a real secret, then prove it never leaves the vault.
  const secret = 'SUPER-SECRET-TOKEN-8f3a';
  await run(['secret', 'set', 'telegram.botToken', secret], { CORRIDOR_HOME: home });

  const out = path.join(home, 'bundle.json');
  const { code } = await run(['support', '--out', out], { CORRIDOR_HOME: home });
  assert.equal(code, 0);

  const raw = fs.readFileSync(out, 'utf8');
  assert.ok(!raw.includes(secret), 'the support bundle leaked a stored credential');
  const bundle = JSON.parse(raw);
  assert.ok(bundle.secretsStored.includes('telegram.botToken'), 'secret NAMES are useful for diagnosis');
  assert.equal(bundle.config.channels.telegram.botToken, '@vault:telegram.botToken');
  assert.ok(bundle.host.node, 'the bundle must record the Node version');

  fs.rmSync(home, { recursive: true, force: true });
});

test('support bundle masks camera addresses to their subnet', { timeout: 60_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-mask-'));
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'state.json'), JSON.stringify({
    version: 2,
    cameras: { c1: { name: 'Gate', group: 'Z', host: '192.168.44.77', status: 'up', since: Date.now() } },
    fleet: { total: 1, up: 1, down: 0, degraded: 0, unknown: 0 },
    cycle: {}, network: {}, alerts: {},
  }));
  const out = path.join(home, 'bundle.json');
  await run(['support', '--out', out], { CORRIDOR_HOME: home });
  const bundle = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(bundle.cameras[0].host, '192.168.44.x', 'the last octet must be masked');
  fs.rmSync(home, { recursive: true, force: true });
});
