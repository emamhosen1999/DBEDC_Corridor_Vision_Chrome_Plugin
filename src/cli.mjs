#!/usr/bin/env node
/**
 * Corridor Vision command line.
 *
 *   run          start the monitor and dashboard (what the Windows service invokes)
 *   import       import a camera inventory from CSV
 *   discover     sweep a subnet for cameras
 *   probe        probe one camera and print the full ladder result
 *   secret       store a credential in the encrypted vault
 *   test-alert   send a test message through one channel
 *   report       print the shareable status report
 *   doctor       check the configuration end to end and say what is wrong
 *   wa-login     link WhatsApp Web by QR (only for the whatsappWeb channel)
 */
import process from 'node:process';
import { loadConfig, saveConfig } from './core/config.mjs';
import { configureLogger, log, closeLogger } from './core/logger.mjs';
import { ensureDirs, FILES, DIRS } from './core/paths.mjs';
import { setSecret, listSecrets } from './core/secrets.mjs';
import { importCsv, activeCameras } from './monitor/inventory.mjs';
import { discoverSubnet } from './monitor/discovery.mjs';
import { probeCamera, checkNetwork } from './probe/index.mjs';
import { Engine } from './monitor/engine.mjs';
import { DashboardServer } from './server/http.mjs';
import { validateChannels, whatsappWeb } from './alerts/channels/index.mjs';
import { renderAlert } from './core/format.mjs';
import { loadState, diskPressure } from './core/store.mjs';
import { stats as queueStats } from './alerts/queue.mjs';
import { fmtDuration } from './core/time.mjs';
import fs from 'node:fs';

const logger = log('cli');

/** Minimal flag parser: `--key value`, `--flag`, and positional arguments. */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const print = (s) => process.stdout.write(`${s}\n`);

/* ----------------------------------------------------------------- run --- */

async function cmdRun(args) {
  const cfg = loadConfig();
  configureLogger({ ...cfg.logging, retentionDays: cfg.retention.logDays });
  ensureDirs();

  for (const w of cfg.__warnings ?? []) logger.warn(w);

  // Refuse to run twice: two monitors probing the same fleet double the network load
  // and race on the same state file.
  try {
    if (fs.existsSync(FILES.pid)) {
      const prev = Number(fs.readFileSync(FILES.pid, 'utf8').trim());
      if (prev && prev !== process.pid) {
        try {
          process.kill(prev, 0);
          logger.fatal('another Corridor Vision instance is already running', { pid: prev });
          process.exitCode = 1;
          return;
        } catch { /* stale pid file from a crash — carry on */ }
      }
    }
    fs.writeFileSync(FILES.pid, String(process.pid));
  } catch (err) { logger.warn('could not write the pid file', { error: err.message }); }

  const engine = new Engine({ cfg });
  const server = new DashboardServer({ cfg, engine });
  engine.broadcast = (event, data) => server.broadcast(event, data);

  await server.listen();
  await engine.start();

  print(`\n  Corridor Vision is running.`);
  print(`  Dashboard:  http://${cfg.server.host}:${cfg.server.port}`);
  print(`  Site:       ${cfg.site.name} (${cfg.site.timezone})`);
  print(`  Cameras:    ${(await activeCameras()).length}`);
  print(`  Interval:   ${cfg.monitor.intervalSec}s\n`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    await engine.stop();
    await server.close();
    try { await whatsappWeb.stop(); } catch { /* not started */ }
    try { fs.unlinkSync(FILES.pid); } catch { /* already gone */ }
    await closeLogger();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // A crash in an unattended service must leave a trace, not vanish.
  process.on('uncaughtException', (err) => { logger.fatal('uncaught exception', { error: err.message, stack: err.stack }); });
  process.on('unhandledRejection', (err) => { logger.error('unhandled rejection', { error: String(err?.message ?? err) }); });

  if (args.once) { await engine.runCycle(); await shutdown('once'); }
}

/* -------------------------------------------------------------- import --- */

async function cmdImport(args) {
  const file = args.csv ?? args.file ?? args._[0];
  if (!file) { print('Usage: npm run import -- --csv <path> [--vendor uniview] [--replace]'); process.exitCode = 1; return; }
  const summary = await importCsv(file, {
    merge: !args.replace,
    defaults: { vendor: args.vendor ?? loadConfig().probe.vendor.defaultVendor },
  });
  print(`\nImported ${summary.imported} cameras (${summary.added} new, ${summary.updated} updated).`);
  if (summary.duplicates) print(`${summary.duplicates} duplicate rows were collapsed.`);
  if (summary.collisions?.length) {
    print(`\n${summary.collisions.length} cameras share an address and were separated by port/name:`);
    for (const c of summary.collisions.slice(0, 20)) print(`  ${c.name} (${c.host}) → ${c.id}`);
  }
  if (summary.warnings?.length) {
    print(`\n${summary.warnings.length} warnings:`);
    for (const w of summary.warnings.slice(0, 20)) print(`  line ${w.line} (${w.name}): ${w.warning}`);
  }
  if (summary.rejected.length) {
    print(`\n${summary.rejected.length} rows were rejected:`);
    for (const r of summary.rejected.slice(0, 20)) print(`  line ${r.line} (${r.name}): ${r.errors.join('; ')}`);
  }
  if (summary.missing.length) {
    print(`\n${summary.missing.length} cameras are in the inventory but were NOT in this file:`);
    for (const m of summary.missing.slice(0, 20)) print(`  ${m.name}`);
    print('  (kept — re-run with --replace to drop them)');
  }
  print(`\nInventory now holds ${summary.inventorySize} cameras.`);
}

/* ------------------------------------------------------------ discover --- */

async function cmdDiscover(args) {
  const cidr = args.cidr ?? args._[0];
  if (!cidr) { print('Usage: npm run discover -- --cidr 192.168.10.0/24'); process.exitCode = 1; return; }
  const out = await discoverSubnet(cidr, { username: args.user, password: args.pass });
  print(`\nScanned ${out.scanned} addresses, ${out.found.length} responded, ${out.cameras.length} look like cameras.\n`);
  for (const c of out.cameras) {
    print(`  ${c.host.padEnd(16)} ${(c.manufacturer ?? c.name ?? '').padEnd(18)} ${(c.model ?? c.hardware ?? '').padEnd(16)} ports=${c.openPorts.join(',') || '—'}${c.onvif ? ' onvif' : ''}`);
  }
  print('\nTo monitor these, add them to your CSV and run: npm run import -- --csv <file>');
}

/* --------------------------------------------------------------- probe --- */

async function cmdProbe(args) {
  const host = args.host ?? args._[0];
  if (!host) { print('Usage: npm run probe -- --host 192.168.10.11 [--user admin --pass secret]'); process.exitCode = 1; return; }
  const cfg = loadConfig();
  configureLogger({ level: args.verbose ? 'debug' : 'warn', file: false });
  const result = await probeCamera(
    { id: 'adhoc', name: host, host, vendor: args.vendor },
    cfg,
    { cycle: 0, credentials: { username: args.user, password: args.pass } },
  );
  print(`\n  ${host} → ${result.status.toUpperCase()}${result.detail ? `\n  ${result.detail}` : ''}\n`);
  for (const [layer, data] of Object.entries(result.layers)) {
    const mark = data.ok ? '✓' : '✗';
    print(`  ${mark} ${layer.padEnd(9)} ${JSON.stringify(data).slice(0, 220)}`);
  }
  if (result.warnings.length) {
    print('\n  Warnings:');
    for (const w of result.warnings) print(`    ⚠ ${w}`);
  }
  print('');
}

/* -------------------------------------------------------------- secret --- */

async function cmdSecret(args) {
  const [action, path, ...rest] = args._;
  if (action === 'list') { print(listSecrets().join('\n') || '(no secrets stored)'); return; }
  if (action !== 'set' || !path) {
    print('Usage:\n  npm start -- secret set <name> <value>\n  npm start -- secret list\n');
    print('Common names: cameras.username, cameras.password, telegram.botToken,');
    print('              whatsappGreen.apiToken, whatsappWaha.apiKey, email.pass, webhook.secret');
    process.exitCode = 1;
    return;
  }
  const value = args.value ?? rest.join(' ');
  if (!value) { print('A value is required.'); process.exitCode = 1; return; }
  setSecret(path, value);
  print(`Stored "${path}" in the encrypted vault (${FILES.secrets}).`);
  print('Reference it from config.json as: "@vault:' + path + '"');
}

/* ---------------------------------------------------------- test-alert --- */

async function cmdTestAlert(args) {
  const cfg = loadConfig();
  configureLogger({ level: 'info', file: false });
  const { createChannels } = await import('./alerts/channels/index.mjs');
  const channels = createChannels();
  const name = args.channel ?? args._[0];

  if (!name) {
    print('\nEnabled channels:');
    for (const r of validateChannels(channels, cfg)) {
      print(`  ${r.ok ? '✓' : '✗'} ${r.channel.padEnd(18)} ${r.describe}`);
      for (const p of r.problems) print(`      ${p}`);
    }
    print('\nUsage: npm run test-alert -- --channel telegram');
    return;
  }

  const channel = channels[name];
  if (!channel) { print(`Unknown channel "${name}". Available: ${Object.keys(channels).join(', ')}`); process.exitCode = 1; return; }
  const rendered = renderAlert({ type: 'channel.test', channel: name, at: Date.now() }, cfg);
  try {
    const info = await channel.send({ ...rendered, alertType: 'channel.test' }, cfg.channels[name]);
    print(`✓ Sent via ${name}: ${JSON.stringify(info)}`);
  } catch (err) {
    print(`✗ ${name} failed: ${err.message}`);
    process.exitCode = 1;
  }
}

/* -------------------------------------------------------------- report --- */

async function cmdReport(args) {
  const cfg = loadConfig();
  configureLogger({ level: 'error', file: false });
  const engine = new Engine({ cfg });
  print(await engine.buildReport(args.format ?? 'full'));
}

/* -------------------------------------------------------------- alarms --- */

async function cmdAlarms(args) {
  const cfg = loadConfig();
  configureLogger({ level: 'error', file: false });
  const { AlarmRegister, effectivePriority } = await import('./alarms/register.mjs');
  const { CATALOG, TAGS, byClass } = await import('./alarms/catalog.mjs');
  const { alarmKpis } = await import('./alarms/kpi.mjs');
  const state = await loadState();
  const register = new AlarmRegister({ cfg, notify: () => {} }).load(state.alarms ?? {});

  if (args.catalog) {
    print('\nAlarm catalogue — what this system can annunciate, and why.\n');
    for (const [cls, defs] of byClass()) {
      print(`  ${String(cls).toUpperCase()}`);
      for (const d of defs) {
        print(`    ${d.priority.padEnd(10)} ${d.tag.padEnd(24)} ${d.name}`);
        if (args.verbose) {
          print(`               cause:  ${d.cause}`);
          print(`               action: ${d.correctiveAction}`);
          print(`               within: ${d.timeToRespond}\n`);
        }
      }
      print('');
    }
    print(`${TAGS.length} alarm types defined.`);
    return;
  }

  const icon = { critical: '🚨', high: '🔴', medium: '🟠', low: '🟡', diagnostic: '🔵' };
  const list = args.all ? [...register.instances.values()] : register.annunciated();
  print('');
  if (!list.length) {
    print('  ✅ No alarms requiring attention.');
  } else {
    for (const i of list) {
      const p = effectivePriority(i);
      print(`  ${icon[p] ?? '•'} ${p.padEnd(9)} ${i.tag.padEnd(22)} ${(i.subjectName ?? '—').padEnd(24)} ${i.state}`);
      if (args.verbose && CATALOG[i.tag]) print(`      ➤ ${CATALOG[i.tag].correctiveAction}`);
    }
  }

  const k = await alarmKpis({ sinceTs: Date.now() - 86_400_000, register, operatorPositions: cfg.alarms?.operatorPositions ?? 1 });
  print('');
  print('  Alarm system performance (last 24h, EEMUA 191)');
  print(`    ${k.overall.status === 'acceptable' ? '✓' : '✗'} ${k.overall.summary}`);
  print(`      rate ${k.rate.perHour}/h (target ≤${k.rate.target}) · peak ${k.peak.value} (≤${k.peak.target}) · flood ${k.flood.pct}% (<${k.flood.target}%) · standing ${k.standing.count} (<${k.standing.target})`);
  print('');
}

/* ------------------------------------------------------------- reports --- */

async function cmdReports(args) {
  const cfg = loadConfig();
  configureLogger({ level: 'error', file: false });
  const { listReports, readReport, nextDue, produceReport } = await import('./report/scheduler.mjs');
  const { buildReportModel } = await import('./report/model.mjs');
  const { render } = await import('./report/render.mjs');
  const { AlarmRegister } = await import('./alarms/register.mjs');
  const state = await loadState();
  const register = new AlarmRegister({ cfg, notify: () => {} }).load(state.alarms ?? {});

  if (args.list) {
    const reports = await listReports({ limit: Number(args.limit) || 30 });
    if (!reports.length) { print('\nNo reports have been issued yet.'); return; }
    print('\nReports of record:\n');
    for (const r of reports) print(`  ${r.reportId.padEnd(26)} ${r.formats.join(', ')}`);
    const due = nextDue(cfg, { lastIssuedAt: state.reporting?.lastIssuedAt ?? 0 });
    if (due) print(`\nNext scheduled report: ${new Date(due.dueAt).toISOString()}`);
    return;
  }

  if (args.read) {
    const body = await readReport(args.read, args.format ?? 'text');
    if (body === null) { print(`No stored report "${args.read}" in format "${args.format ?? 'text'}".`); process.exitCode = 1; return; }
    print(body);
    return;
  }

  if (args.issue) {
    // Writes the report of record and numbers it, but does not send it — sending is
    // the service's job, and a CLI run should not silently page the whole duty roster.
    const out = await produceReport({ cfg, register, label: 'Manual report (CLI)', trigger: 'manual' });
    print(`\nIssued ${out.model.meta.reportId} covering ${out.model.devices.length} devices.`);
    for (const [format, file] of Object.entries(out.files)) print(`  ${format.padEnd(10)} ${file}`);
    print('\nThis was written to disk but NOT sent. Use the dashboard, or POST /api/reports/send, to send it.');
    return;
  }

  const hours = Number(args.hours) || 6;
  const model = await buildReportModel({
    cfg, register, periodMs: hours * 3_600_000, label: 'Preview', trigger: 'preview', sequence: { number: 0 },
  });
  const body = render(model, args.format ?? 'text', { fullRegister: true, maxChars: 1e9 });
  print(Array.isArray(body) ? body.join('\n') : body);
}

/* -------------------------------------------------------------- doctor --- */

async function cmdDoctor() {
  configureLogger({ level: 'error', file: false });
  let cfg;
  print('\nCorridor Vision — configuration check\n');

  try {
    cfg = loadConfig();
    print('  ✓ config/config.json parses and validates');
  } catch (err) {
    print(`  ✗ ${err.message}`);
    process.exitCode = 1;
    return;
  }
  for (const w of cfg.__warnings ?? []) print(`  ⚠ ${w}`);

  const cameras = await activeCameras();
  if (cameras.length) print(`  ✓ inventory holds ${cameras.length} enabled cameras`);
  else { print('  ✗ inventory is empty — run: npm run import -- --csv <file>'); process.exitCode = 1; }

  const badHosts = cameras.filter((c) => !c.host);
  if (badHosts.length) print(`  ✗ ${badHosts.length} cameras have no address`);

  const net = await checkNetwork(cfg);
  if (!net.checked) print('  ⚠ monitor.gatewayCheck.hosts is empty — set it to your core switch and NVR so the monitor can tell its own outage from a camera outage');
  else if (net.healthy) print('  ✓ network reference hosts are reachable');
  else print(`  ✗ ${net.reason}`);

  const { createChannels } = await import('./alerts/channels/index.mjs');
  const channels = createChannels();
  const report = validateChannels(channels, cfg);
  const remote = report.filter((r) => !['console', 'dashboard', 'desktop'].includes(r.channel));
  if (!remote.length) print('  ✗ no off-box alert channel is enabled — alerts will never leave this PC');
  for (const r of report) {
    print(`  ${r.ok ? '✓' : '✗'} channel ${r.channel}`);
    for (const p of r.problems) print(`      ${p}`);
  }
  for (const r of remote) {
    const channel = channels[r.channel];
    if (!channel?.health || !r.ok) continue;
    try {
      const h = await channel.health(cfg.channels[r.channel]);
      print(`  ${h.ok ? '✓' : '⚠'} ${r.channel} health: ${h.detail ?? h.status}`);
    } catch (err) { print(`  ⚠ ${r.channel} health check failed: ${err.message}`); }
  }

  const state = await loadState();
  if (state.cycle.lastFinishedAt) {
    const age = Date.now() - state.cycle.lastFinishedAt;
    print(`  ${age < cfg.alerts.watchdog.staleAfterSec * 1000 ? '✓' : '✗'} last cycle ${fmtDuration(age)} ago`);
  } else print('  ⚠ no monitoring cycle has completed yet');

  const q = await queueStats();
  print(`  ${q.pending === 0 ? '✓' : '⚠'} delivery queue: ${q.pending} pending`);

  if (cfg.alarms?.enabled) {
    const { AlarmRegister } = await import('./alarms/register.mjs');
    const register = new AlarmRegister({ cfg, notify: () => {} }).load(state.alarms ?? {});
    const ann = register.annunciated().length;
    const standing = register.standing().length;
    print(`  ${ann === 0 ? '✓' : '⚠'} alarms: ${ann} needing attention, ${standing} standing`);
    if (standing >= 5) print('      EEMUA 191 targets fewer than 5 standing alarms — these are degrading the annunciator');
  }

  if (cfg.reporting?.enabled) {
    const { nextDue } = await import('./report/scheduler.mjs');
    const due = nextDue(cfg, { lastIssuedAt: state.reporting?.lastIssuedAt ?? 0 });
    const last = state.reporting?.lastIssuedAt;
    print(`  ${last ? '✓' : '⚠'} reporting: ${last ? `last ${fmtDuration(Date.now() - last)} ago` : 'none issued yet'}`
      + `${due ? `, next ${fmtDuration(Math.max(0, due.dueAt - Date.now()))} from now` : ''}`);
    if (!cfg.reporting.formats?.includes('text')) {
      print('      reporting.formats has no "text" — chat channels cannot send this report');
    }
  } else {
    print('  ⚠ scheduled reporting is disabled — nobody receives a regular all-device report');
  }

  const disk = await diskPressure();
  print(`  ${disk.freePct > 10 ? '✓' : '✗'} disk: ${Math.round(disk.freePct)}% free at ${DIRS.data}`);

  print('');
}

/* ----------------------------------------------------------- wa-groups --- */

async function cmdWaGroups() {
  const cfg = loadConfig();
  configureLogger({ level: 'error', file: false });
  const { createChannels } = await import('./alerts/channels/index.mjs');
  const channel = createChannels().whatsappCloud;
  const groups = await channel.listGroups(cfg.channels.whatsappCloud);
  if (!groups.length) {
    print('\nThis business number is not in any groups yet.');
    print('Create one in WhatsApp Manager, add the duty roster (max 8 participants),');
    print('then re-run this command to read its id.');
    return;
  }
  print('\nGroups this business number can post to:\n');
  for (const g of groups) {
    print(`  ${String(g.id).padEnd(28)} ${g.subject ?? g.name ?? '(no subject)'}`);
  }
  print('\nSet the one you want as channels.whatsappCloud.to, with recipientType "group".');
}

/* ------------------------------------------------------------ wa-login --- */

async function cmdWaLogin() {
  const cfg = loadConfig();
  configureLogger({ level: 'info', file: false });
  print('\nLinking WhatsApp Web. Scan the QR code below with the phone that should send alerts.\n');
  let qrcode = null;
  try { qrcode = (await import('qrcode-terminal')).default; }
  catch { print('(install qrcode-terminal to render the QR in this terminal: npm i qrcode-terminal)\n'); }

  await whatsappWeb.start(cfg.channels.whatsappWeb, {
    onQr: (qr) => { if (qrcode) qrcode.generate(qr, { small: true }); else print(qr); },
  });

  for (let i = 0; i < 180 && !whatsappWeb.isReady(); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!whatsappWeb.isReady()) { print('\nTimed out waiting for the link. Run the command again.'); process.exitCode = 1; return; }

  print('\n✓ WhatsApp Web is linked. The session persists, so this is a one-off.');
  if (cfg.channels.whatsappWeb.groupName) {
    try {
      const id = await whatsappWeb.resolveGroupId(cfg.channels.whatsappWeb.groupName);
      print(`✓ Group "${cfg.channels.whatsappWeb.groupName}" resolved to ${id}`);
      saveConfig({ channels: { whatsappWeb: { chatId: id } } });
      print('  Saved as channels.whatsappWeb.chatId so lookups are skipped from now on.');
    } catch (err) { print(`⚠ ${err.message}`); }
  }
  await whatsappWeb.stop();
}

/* ----------------------------------------------------------------- main --- */

const COMMANDS = {
  run: cmdRun,
  import: cmdImport,
  discover: cmdDiscover,
  probe: cmdProbe,
  secret: cmdSecret,
  'test-alert': cmdTestAlert,
  report: cmdReport,
  doctor: cmdDoctor,
  alarms: cmdAlarms,
  reports: cmdReports,
  'wa-login': cmdWaLogin,
  'wa-groups': cmdWaGroups,
};

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run';
const args = parseArgs(argv[0] === command ? argv.slice(1) : argv);

const handler = COMMANDS[command];
if (!handler) {
  print(`Unknown command "${command}".\n\nAvailable: ${Object.keys(COMMANDS).join(', ')}`);
  process.exitCode = 1;
} else {
  handler(args).catch((err) => {
    logger.fatal(`${command} failed`, { error: err.message, stack: err.stack });
    process.stderr.write(`\n${err.message}\n`);
    process.exitCode = 1;
  });
}
