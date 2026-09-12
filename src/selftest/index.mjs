/**
 * Self-test — prove the install works before pointing it at real cameras.
 *
 * Spins up simulated cameras on loopback, runs the real engine against them, and
 * checks that every stage of the pipeline actually works on THIS machine: probing,
 * outage detection, alarm raising, acknowledgement, report generation in every format,
 * and delivery through whichever channels are configured.
 *
 * Why this exists: the gap between "the code is correct" and "it works on your PC" is
 * where deployments die — a blocked port, a missing PowerShell policy, an expired API
 * token, a read-only directory. Those fail at 3am on a real outage otherwise. This
 * turns all of them into a red line on a terminal, now.
 *
 * It never touches the real inventory or the real configuration: everything runs in a
 * scratch directory that is deleted afterwards.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startFakeCamera } from './fake-camera.mjs';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';
const DIM = (s) => `\x1b[90m${s}\x1b[0m`;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/**
 * Two inline JPEGs, so the image-analysis layer is exercised with no camera present
 * and no file to ship: a textured scene that must read as healthy, and a pure black
 * frame that must be caught as a video-loss fault.
 */
function sceneJpeg() {
  return Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8l'
    + 'JCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIo'
    + 'Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAAR'
    + 'CAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA'
    + 'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK'
    + 'FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWG'
    + 'h4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl'
    + '5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA'
    + 'AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYk'
    + 'NOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE'
    + 'hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk'
    + '5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCK1sXS3LRKml2mNvmvjzG4PA9CQc4HORwT'
    + 'Vyx07yVI0+GK1toyAbyfHIyMEBsBQSSOeuR0NNkv7C2uWS3jl1nUFypkJKxRnJ4z6A84Ubf9'
    + 'oVnXlxLfXzLeb72dGIFrBlIYOmRk5x0HTJyvJBoXPUbbsk/62f5t2Jj9WwrcEueXZfq3+u3Y'
    + '0I9RtIZtmk2jardsF3XdyT5fQY6/M3HGPlx71nTSXGo3waQnVLsKuGXAgiGOMbeDjPQYzk85'
    + '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',
    'base64',
  );
}

function blackJpeg() {
  return Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8l'
    + 'JCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIo'
    + 'Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAAR'
    + 'CAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA'
    + 'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK'
    + 'FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWG'
    + 'h4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl'
    + '5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA'
    + 'AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYk'
    + 'NOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE'
    + 'hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk'
    + '5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDxmiiigAooooAKKKKACiiigAooooAKKKKA'
    + 'CiiigAooooAKKKKACiiigAooooAKKKKAP//Z',
    'base64',
  );
}

const steps = [];
const record = (ok, name, detail, level = 'fail') => {
  steps.push({ ok, name, detail, level });
  const mark = ok ? PASS : (level === 'warn' ? WARN : FAIL);
  process.stdout.write(`  ${mark} ${name}${detail ? DIM(` — ${detail}`) : ''}\n`);
  return ok;
};

/**
 * @param options.channels  also send a real test message through every enabled channel
 * @param options.keepHome  leave the scratch directory behind for inspection
 */
async function execute({ channels = false, keepHome = false, realConfig = null, home } = {}) {
  const started = Date.now();
  const cleanup = [];
  process.stdout.write(`\nCorridor Vision self-test\n${DIM(`scratch: ${home}`)}\n\n`);

  let healthy; let broken; let dark; let engine; let server;
  const delivered = [];

  try {
    /* ---------------------------------------------------------- environment */
    process.stdout.write('Environment\n');
    const nodeOk = Number(process.versions.node.split('.')[0]) >= 20;
    record(nodeOk, `Node.js ${process.version}`, nodeOk ? 'meets the 20.11 minimum' : 'TOO OLD — install Node 20.11 or newer');
    record(true, `Platform ${process.platform} ${process.arch}`);

    // Writable data directory is the single most common Windows install failure:
    // an app folder under Program Files is read-only for a service account.
    try {
      await fsp.writeFile(path.join(home, '.probe'), 'x');
      record(true, 'Scratch directory is writable');
    } catch (err) {
      record(false, 'Scratch directory is writable', err.message);
    }

    /* ------------------------------------------------------- fake cameras */
    process.stdout.write('\nSimulated cameras\n');
    const scene = sceneJpeg();
    healthy = await startFakeCamera({ requireAuth: false, jpeg: scene });
    broken = await startFakeCamera({ requireAuth: false, behaviour: 'rtsp-dead', jpeg: scene });
    dark = await startFakeCamera({ requireAuth: false, jpeg: blackJpeg() });
    cleanup.push(() => healthy.stop(), () => broken.stop(), () => dark.stop());
    record(true, 'Started 3 simulated cameras', `RTSP ${healthy.rtspPort}, ${broken.rtspPort}, ${dark.rtspPort}`);

    /* -------------------------------------------------------------- config */
    const port = await freePort();
    fs.mkdirSync(path.join(home, 'config'), { recursive: true });
    fs.writeFileSync(path.join(home, 'config', 'config.json'), JSON.stringify({
      site: { name: 'Self-test', timezone: realConfig?.site?.timezone ?? 'UTC' },
      server: { host: '127.0.0.1', port },
      monitor: { intervalSec: 3600, concurrency: 4, gatewayCheck: { enabled: false } },
      probe: {
        icmp: { enabled: false }, vendor: { enabled: false }, onvifEvents: { enabled: false },
        tcp: { ports: [healthy.rtspPort, broken.rtspPort, dark.rtspPort], timeoutMs: 1500 },
        onvif: { timeoutMs: 2000 },
        rtsp: { timeoutMs: 2000, pathTemplates: ['/media/video1'] },
        snapshot: { enabled: true, everyNCycles: 1, minBytes: 100 },
      },
      detect: { confirmDownCycles: 1, confirmUpCycles: 1 },
      alerts: { coalesceSec: 0, minSeverity: 'info', digest: { enabled: false }, watchdog: { enabled: false } },
      reporting: { enabled: false, formats: ['text', 'html', 'csv', 'json'] },
      channels: { console: { enabled: false }, dashboard: { enabled: false }, desktop: { enabled: false },
        selftest: { enabled: true, routes: {} } },
    }, null, 2));

    // NOTE: this module is always executed in a CHILD PROCESS with CORRIDOR_HOME
    // already set in its environment (see runSelfTest below). That is deliberate:
    // paths.mjs resolves the data root once at import time, so setting the variable
    // in an already-running process has no effect — the first version of this
    // self-test silently ran against the REAL config and reported a false failure.
    // A separate process is the only way to be certain the scratch directory is
    // genuinely isolated.
    const { loadConfig } = await import('../core/config.mjs');
    const { configureLogger } = await import('../core/logger.mjs');
    const { importCsv } = await import('../monitor/inventory.mjs');
    const { Engine } = await import('../monitor/engine.mjs');
    const { DashboardServer } = await import('../server/http.mjs');
    const { drainQueue } = await import('../alerts/channels/index.mjs');
    const { produceReport } = await import('../report/scheduler.mjs');

    configureLogger({ level: 'error', file: false });
    const cfg = loadConfig({ force: true });

    /* ------------------------------------------------------------ inventory */
    process.stdout.write('\nInventory\n');
    const csv = path.join(home, 'selftest.csv');
    fs.writeFileSync(csv, [
      'Camera,Organization,IP,rtspPort,onvifPort,httpPort,snapshotUrl',
      `Simulated Healthy,Test Zone A,127.0.0.1,${healthy.rtspPort},${healthy.httpPort},${healthy.httpPort},http://127.0.0.1:${healthy.httpPort}/snapshot`,
      `Simulated Stream-Dead,Test Zone B,127.0.0.1,${broken.rtspPort},${broken.httpPort},${broken.httpPort},http://127.0.0.1:${broken.httpPort}/snapshot`,
      `Simulated Dark,Test Zone B,127.0.0.1,${dark.rtspPort},${dark.httpPort},${dark.httpPort},http://127.0.0.1:${dark.httpPort}/snapshot`,
    ].join('\n'));
    const imported = await importCsv(csv);
    record(imported.imported === 3, 'CSV import', `${imported.imported} cameras, ${imported.rejected.length} rejected`);

    /* --------------------------------------------------------------- engine */
    process.stdout.write('\nMonitoring pipeline\n');
    engine = new Engine({ cfg });
    engine.channels.selftest = {
      name: 'selftest', validate: () => [],
      send: async (m) => { delivered.push(m); return { target: 'selftest' }; },
    };
    server = new DashboardServer({ cfg, engine });
    engine.broadcast = (e, d) => server.broadcast(e, d);
    await server.listen();
    cleanup.push(() => server.close());
    await engine.start();
    cleanup.push(() => engine.stop());
    record(true, `Dashboard listening`, `http://127.0.0.1:${port}`);

    await engine.runCycle();
    const status = await engine.snapshotForApi();
    record(status.fleet.total === 3, 'Probe cycle completed', `${status.fleet.up} up, ${status.fleet.degraded} degraded, ${status.fleet.down} down`);
    record(status.fleet.up >= 1, 'Healthy camera detected as serving video');
    record(status.fleet.degraded >= 2, 'Faults detected as DEGRADED, not offline',
      'a dead stream and a black image both read as reachable-but-unusable');
    const darkCam = status.cameras.find((c) => c.name === 'Simulated Dark');
    record(darkCam?.status === 'degraded', 'Black image caught by image analysis',
      darkCam?.detail ?? 'not detected');

    /* --------------------------------------------------------------- alarms */
    process.stdout.write('\nAlarm system\n');
    const annunciated = engine.register.annunciated();
    record(annunciated.length > 0, 'Alarms raised from probe results',
      annunciated.map((a) => a.tag).join(', ') || 'none');
    const first = annunciated[0];
    if (first) {
      const acked = engine.register.acknowledge(first.key, { by: 'selftest' });
      record(!!acked, 'Alarm acknowledgement', `${first.tag} → ${acked?.state}`);
      const shelveNoReason = engine.register.shelve(first.key, { hours: 1 });
      record(shelveNoReason.ok === false, 'Shelving without a reason is refused');
      const shelved = engine.register.shelve(first.key, { hours: 1, reason: 'self-test' });
      record(shelved.ok === true, 'Shelving with a reason and an expiry', `expires in ${shelved.hours}h`);
    }
    const watchdogShelve = engine.register.shelve('SYS_MONITOR_STALLED', { hours: 1, reason: 'x' });
    record(watchdogShelve.ok === false, 'Watchdog alarm refuses to be silenced');

    const kpi = await engine.alarmKpis(24);
    record(typeof kpi.rate.perHour === 'number', 'EEMUA 191 metrics computed',
      `${kpi.rate.perHour}/h, peak ${kpi.peak.value}, ${kpi.overall.status}`);

    /* -------------------------------------------------------------- reports */
    process.stdout.write('\nReporting\n');
    const { model, rendered, files } = await produceReport({
      cfg, register: engine.register, label: 'Self-test report', trigger: 'manual',
      formats: ['text', 'html', 'csv', 'json'],
    });
    record(model.devices.length === 3, 'Report covers every device', `${model.devices.length} in the register`);
    for (const format of ['text', 'html', 'csv', 'json']) {
      const body = rendered[format];
      const size = Array.isArray(body) ? body.join('').length : (body?.length ?? 0);
      record(size > 200, `Rendered ${format}`, `${size} chars`);
    }
    const written = Object.values(files).filter((f) => fs.existsSync(f));
    record(written.length === Object.keys(files).length, 'Report written to disk',
      `${written.length} files under data/exports/reports/`);
    const textReport = [].concat(rendered.text).join('\n');
    record(textReport.includes('Simulated Healthy'), 'Full register includes healthy devices',
      'not just the faulty ones');

    /* -------------------------------------------------------------- delivery */
    process.stdout.write('\nAlert delivery\n');
    await engine.bus.flush();
    await drainQueue(engine.channels, cfg);
    record(delivered.length > 0, 'Alerts reached a delivery channel',
      `${delivered.length} message(s): ${[...new Set(delivered.map((d) => d.alertType))].join(', ')}`);
    const alarmMsg = delivered.find((d) => d.alertType === 'alarm.raised');
    if (alarmMsg) {
      record(/➤/.test(alarmMsg.text), 'Alarm messages carry their corrective action');
    }

    /* --------------------------------------------------- real channels (opt) */
    if (channels && realConfig) {
      process.stdout.write('\nConfigured alert channels (real send)\n');
      const { createChannels, validateChannels } = await import(`../alerts/channels/index.mjs${bust}`);
      const { renderAlert } = await import(`../core/format.mjs${bust}`);
      const live = createChannels();
      const report = validateChannels(live, realConfig);
      const remote = report.filter((r) => !['console', 'dashboard', 'desktop'].includes(r.channel));
      if (!remote.length) {
        record(false, 'At least one off-box channel is enabled',
          'no WhatsApp, Telegram or email configured — alarms cannot leave this PC', 'warn');
      }
      for (const r of remote) {
        if (!r.ok) { record(false, `${r.channel} configuration`, r.problems.join('; '), 'warn'); continue; }
        const msg = renderAlert({ type: 'channel.test', channel: r.channel, at: Date.now() }, realConfig);
        try {
          const info = await live[r.channel].send({ ...msg, alertType: 'channel.test' }, realConfig.channels[r.channel]);
          record(true, `${r.channel} delivered a real test message`, JSON.stringify(info).slice(0, 90));
        } catch (err) {
          record(false, `${r.channel} delivery`, err.message.slice(0, 160));
        }
      }
    }
  } catch (err) {
    record(false, 'Self-test crashed', `${err.message}\n${err.stack?.split('\n')[1]?.trim() ?? ''}`);
  } finally {
    for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* best effort */ } }
  }

  /* ------------------------------------------------------------- verdict */
  const failures = steps.filter((s) => !s.ok && s.level !== 'warn');
  const warnings = steps.filter((s) => !s.ok && s.level === 'warn');
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  process.stdout.write(`\n${'─'.repeat(64)}\n`);
  if (!failures.length) {
    process.stdout.write(`${PASS} Self-test PASSED — ${steps.filter((s) => s.ok).length} checks in ${elapsed}s\n`);
    if (warnings.length) {
      process.stdout.write(`${WARN} ${warnings.length} warning(s):\n`);
      for (const w of warnings) process.stdout.write(`    ${w.name}: ${w.detail}\n`);
    }
    process.stdout.write('\nThe pipeline works on this machine. Next: import your real camera CSV\n');
    process.stdout.write('and run "node src/cli.mjs doctor".\n');
    if (keepHome) process.stdout.write(`\nScratch directory kept for inspection.\n`);
  } else {
    process.stdout.write(`${FAIL} Self-test FAILED — ${failures.length} of ${steps.length} checks\n\n`);
    for (const f of failures) process.stdout.write(`    ${f.name}: ${f.detail ?? 'failed'}\n`);
    process.stdout.write('\nFix these before pointing the service at real cameras.\n');
  }
  process.stdout.write(`${'─'.repeat(64)}\n\n`);

  return { ok: failures.length === 0, steps, failures, warnings, elapsedSec: Number(elapsed) };
}

/**
 * Run the self-test in an isolated child process.
 *
 * The child inherits stdio so its output streams live, and gets CORRIDOR_HOME pointed
 * at a scratch directory from the moment it starts — which is the only way to
 * guarantee it cannot touch the real configuration, inventory or alarm register.
 */
export async function runSelfTest({ channels = false, keepHome = false } = {}) {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'corridor-selftest-'));
  const self = fileURLToPath(import.meta.url);

  const args = [self, '--child', home];
  if (channels) args.push('--channels');

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        CORRIDOR_HOME: home,
        // The live config is read from its real location for channel testing only.
        CORRIDOR_REAL_HOME: process.env.CORRIDOR_HOME ?? '',
      },
    });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', (err) => {
      process.stderr.write(`self-test could not start: ${err.message}\n`);
      resolve(1);
    });
  });

  if (keepHome) process.stdout.write(`Scratch directory kept: ${home}\n\n`);
  else { try { await fsp.rm(home, { recursive: true, force: true }); } catch { /* ignore */ } }

  return { ok: code === 0 };
}

/* Child-process entry point. */
if (process.argv[2] === '--child') {
  const home = process.argv[3];
  const wantChannels = process.argv.includes('--channels');
  let realConfig = null;
  if (wantChannels) {
    // Load the real configuration out-of-band: a separate process whose CORRIDOR_HOME
    // points at the live installation, so the scratch run stays isolated.
    try {
      const { execFileSync } = await import('node:child_process');
      const { fileURLToPath } = await import('node:url');
      const here = path.dirname(fileURLToPath(import.meta.url));
      const out = execFileSync(process.execPath, ['-e',
        `import('${path.join(here, '..', 'core', 'config.mjs').replace(/\\/g, '/')}')`
        + '.then(m => process.stdout.write(JSON.stringify(m.loadConfig())))'],
      { env: { ...process.env, CORRIDOR_HOME: process.env.CORRIDOR_REAL_HOME || undefined }, encoding: 'utf8' });
      realConfig = JSON.parse(out);
    } catch (err) {
      process.stdout.write(`\n${WARN} Could not load the live configuration for channel testing: ${err.message}\n`);
    }
  }
  const result = await execute({ channels: wantChannels, home, realConfig });
  process.exit(result.ok ? 0 : 1);
}
