/**
 * Configuration: defaults, deep merge, validation, migration.
 *
 * Nothing that an operator might need to change is a literal anywhere else in this
 * codebase — that was finding M4 against the old extension, where the server address
 * appeared in four files and the site name was hard-coded inside a page script.
 *
 * Secrets are NOT stored here. `config.json` is plain text and safe to commit to a
 * runbook; every credential lives in the encrypted vault (see secrets.mjs) and is
 * referenced from config by name, e.g. "apiToken": "@vault:telegram.token".
 */
import fs from 'node:fs';
import { FILES, ensureDirs } from './paths.mjs';
import { parseHHMM } from './time.mjs';

export const CONFIG_VERSION = 2;

export const DEFAULTS = {
  version: CONFIG_VERSION,

  site: {
    name: 'Dhaka Bypass Expressway',
    operator: 'DBEDC Corridor Vision',
    timezone: 'Asia/Dhaka',
  },

  server: {
    host: '127.0.0.1',      // never bind 0.0.0.0 by default: the dashboard is unauthenticated on loopback
    port: 8477,
    // Set a token to expose the dashboard beyond loopback. Required if host !== 127.0.0.1.
    accessToken: '',
  },

  monitor: {
    intervalSec: 60,          // main probe cycle
    jitterPct: 10,            // spread probes so the corridor switch is not hammered on the second
    concurrency: 40,          // simultaneous camera probes
    cameraTimeoutMs: 8000,    // wall-clock budget for one camera's full ladder
    cycleTimeoutMs: 55_000,   // a cycle must finish before the next one starts
    pauseWhenUnreachable: true, // if the gateway itself is down, do not declare 500 outages
    gatewayCheck: {
      enabled: true,
      // Hosts that prove the network path is alive. If ALL fail, the monitor
      // declares a NETWORK fault instead of blaming every camera.
      hosts: [],              // e.g. ["192.189.6.1", "192.189.6.5"] — core switch, NVR
      port: 443,
    },
  },

  probe: {
    // The ladder. Each layer only runs if enabled; a cheaper layer failing escalates
    // to the next so a single slow RTSP handshake never gates the whole fleet.
    icmp:     { enabled: true,  timeoutMs: 1200, advisoryOnly: true },
    tcp:      { enabled: true,  timeoutMs: 2000, ports: [554, 80, 8000] },
    onvif:    { enabled: true,  timeoutMs: 3000, port: 80, path: '/onvif/device_service' },
    rtsp:     { enabled: true,  timeoutMs: 4000, port: 554, method: 'DESCRIBE',
                pathTemplates: ['/media/video1', '/unicast/c1/s0/live', '/cam/realmonitor?channel=1&subtype=0', '/Streaming/Channels/101'] },
    vendor:   { enabled: true,  timeoutMs: 4000, defaultVendor: 'uniview' },
    snapshot: { enabled: true,  timeoutMs: 6000, everyNCycles: 10,
                blackLumaMax: 18, frozenCycles: 3, minBytes: 2048, blurVarianceMin: 12 },
  },

  detect: {
    // A transition is only real once it has been seen this many cycles running.
    // This is the fix for the old extension's notification storms (finding B4).
    confirmDownCycles: 2,
    confirmUpCycles: 1,
    // A camera that changes state more than `flapCount` times inside `flapWindowMin`
    // is marked FLAPPING and stops generating individual up/down alerts.
    flapWindowMin: 30,
    flapCount: 4,
    flapCooldownMin: 60,
    // Degraded = reachable but the stream or image is not serviceable.
    treatDegradedAsDown: false,
  },

  alerts: {
    enabled: true,
    minSeverity: 'warning',         // info | warning | critical
    // Roll up alerts raised inside this window into one message per channel.
    coalesceSec: 90,
    maxPerHour: 30,                 // hard rate limit per channel; overflow is summarised
    requireInteraction: true,       // desktop toasts for critical alerts do not auto-dismiss
    quietHours: {
      enabled: false,
      from: '22:00',
      to: '07:00',
      // Severities that ignore quiet hours entirely.
      overrideAtOrAbove: 'critical',
    },
    maintenance: [],                // [{ name, from: ISO, to: ISO, groups: [], cameras: [] }]
    escalation: [
      { afterMin: 60,  severity: 'critical', label: 'Down 1 hour' },
      { afterMin: 360, severity: 'critical', label: 'Down 6 hours' },
      { afterMin: 1440, severity: 'critical', label: 'Down 24 hours' },
    ],
    massOutage: {
      enabled: true,
      // A single alert saying "Zone 3 is entirely dark" beats 60 alerts saying
      // "camera N is offline" (finding M8).
      groupWipeout: true,           // every camera in a group down => one group alert
      fleetPctThreshold: 25,        // >=25% of the fleet down => site-level alert
      minCameras: 5,
    },
    digest: {
      enabled: true,
      times: ['09:00', '18:00'],    // site-local
      includeSla: true,
      skipIfAllHealthy: false,
    },
    watchdog: {
      enabled: true,
      // If no cycle has completed in this long, the monitor alerts about ITSELF.
      // The old extension had no equivalent and could be dead for days (finding B1).
      staleAfterSec: 300,
      repeatEveryMin: 60,
    },
    inventoryChanges: true,         // alert when cameras appear in / vanish from inventory
    slaBreach: { enabled: true, dailyUptimePct: 95 },
  },

  channels: {
    // Every channel is off until configured. `routes` narrows a channel to specific
    // alert types, severities or camera groups.
    dashboard:   { enabled: true,  routes: {} },
    console:     { enabled: true,  routes: { minSeverity: 'info' } },
    desktop:     { enabled: true,  routes: {} },

    whatsappWeb:      { enabled: false, groupName: '', sessionDir: '', routes: {} },
    whatsappGreen:    { enabled: false, apiUrl: 'https://api.green-api.com', idInstance: '', apiToken: '@vault:whatsappGreen.apiToken', chatId: '', routes: {} },
    whatsappWaha:     { enabled: false, baseUrl: 'http://127.0.0.1:3000', session: 'default', apiKey: '@vault:whatsappWaha.apiKey', chatId: '', routes: {} },
    whatsappCloud:    { enabled: false, phoneNumberId: '', accessToken: '@vault:whatsappCloud.accessToken', to: '', recipientType: 'individual', apiVersion: 'v21.0', routes: {} },
    whatsappCallmebot:{ enabled: false, phone: '', apiKey: '@vault:whatsappCallmebot.apiKey', routes: {} },

    telegram:    { enabled: false, botToken: '@vault:telegram.botToken', chatId: '', threadId: '', routes: {} },
    slack:       { enabled: false, webhookUrl: '@vault:slack.webhookUrl', routes: {} },
    teams:       { enabled: false, webhookUrl: '@vault:teams.webhookUrl', routes: {} },
    discord:     { enabled: false, webhookUrl: '@vault:discord.webhookUrl', routes: {} },
    webhook:     { enabled: false, url: '', method: 'POST', headers: {}, secret: '@vault:webhook.secret', routes: {} },
    email:       { enabled: false, host: '', port: 587, secure: false, user: '', pass: '@vault:email.pass', from: '', to: [], routes: {} },
  },

  retention: {
    eventDays: 180,
    snapshotDays: 14,
    logDays: 30,
    outboxMaxAge: 86_400_000,
  },

  logging: { level: 'info', file: true, maxFileBytes: 16_777_216 },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Deep merge `patch` onto `base`. Arrays replace wholesale; objects merge by key. */
export function deepMerge(base, patch) {
  if (!isObj(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/**
 * Validate a merged config. Returns `{ errors, warnings }` — errors block startup,
 * warnings are logged. Being strict here is deliberate: a typo'd quiet-hours string
 * that silently disables alerting is how monitors get trusted and then fail.
 */
export function validate(cfg) {
  const errors = [];
  const warnings = [];
  const sev = ['info', 'warning', 'critical'];

  if (!cfg.site?.timezone) errors.push('site.timezone is required');
  else {
    try { new Intl.DateTimeFormat('en', { timeZone: cfg.site.timezone }); }
    catch { errors.push(`site.timezone "${cfg.site.timezone}" is not a valid IANA zone`); }
  }

  const port = cfg.server?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('server.port must be 1..65535');
  if (cfg.server?.host && cfg.server.host !== '127.0.0.1' && cfg.server.host !== 'localhost' && !cfg.server.accessToken) {
    errors.push('server.accessToken is required when server.host is not loopback — refusing to expose an unauthenticated dashboard');
  }

  const iv = cfg.monitor?.intervalSec;
  if (!Number.isFinite(iv) || iv < 10) errors.push('monitor.intervalSec must be >= 10');
  else if (iv < 30) warnings.push(`monitor.intervalSec=${iv} is aggressive; verify the platform tolerates it`);
  if (cfg.monitor?.cycleTimeoutMs >= iv * 1000 + 60_000) {
    warnings.push('monitor.cycleTimeoutMs is far larger than the interval; cycles may queue');
  }
  if (!Number.isInteger(cfg.monitor?.concurrency) || cfg.monitor.concurrency < 1) {
    errors.push('monitor.concurrency must be a positive integer');
  }

  if (!sev.includes(cfg.alerts?.minSeverity)) errors.push(`alerts.minSeverity must be one of ${sev.join(', ')}`);
  const qh = cfg.alerts?.quietHours;
  if (qh?.enabled) {
    if (parseHHMM(qh.from) === null) errors.push(`alerts.quietHours.from "${qh.from}" must be HH:MM`);
    if (parseHHMM(qh.to) === null) errors.push(`alerts.quietHours.to "${qh.to}" must be HH:MM`);
  }
  for (const t of cfg.alerts?.digest?.times ?? []) {
    if (parseHHMM(t) === null) errors.push(`alerts.digest.times entry "${t}" must be HH:MM`);
  }
  for (const [i, esc] of (cfg.alerts?.escalation ?? []).entries()) {
    if (!Number.isFinite(esc?.afterMin)) errors.push(`alerts.escalation[${i}].afterMin must be a number`);
    if (!sev.includes(esc?.severity)) errors.push(`alerts.escalation[${i}].severity must be one of ${sev.join(', ')}`);
  }
  if (cfg.detect?.confirmDownCycles < 1) errors.push('detect.confirmDownCycles must be >= 1');
  if (cfg.detect?.confirmDownCycles === 1) {
    warnings.push('detect.confirmDownCycles=1 disables flap protection — a single slow response will page the operator');
  }

  if (cfg.probe?.tcp?.enabled && !(cfg.probe.tcp.ports?.length)) errors.push('probe.tcp.ports must not be empty when tcp is enabled');
  if (!cfg.probe?.tcp?.enabled && !cfg.probe?.onvif?.enabled && !cfg.probe?.rtsp?.enabled && !cfg.probe?.vendor?.enabled) {
    errors.push('at least one authoritative probe layer (tcp/onvif/rtsp/vendor) must be enabled — ICMP alone cannot decide a camera is down');
  }

  const enabled = Object.entries(cfg.channels ?? {}).filter(([, c]) => c?.enabled).map(([k]) => k);
  const remote = enabled.filter((k) => !['dashboard', 'console', 'desktop'].includes(k));
  if (cfg.alerts?.enabled && remote.length === 0) {
    warnings.push('no off-box alert channel is enabled — alerts will not leave this PC. Enable WhatsApp, Telegram or email.');
  }
  if (cfg.channels?.whatsappCloud?.enabled && cfg.channels.whatsappCloud.recipientType === 'group') {
    warnings.push("WhatsApp Cloud API groups are capped at 8 participants and require an Official Business Account; most ops groups exceed this");
  }
  return { errors, warnings };
}

/** Apply migrations from older config versions. */
export function migrate(raw) {
  const cfg = { ...raw };
  if (!cfg.version || cfg.version < 2) {
    // v1 (the Chrome extension) kept a flat shape; lift the few fields that carried over.
    if (cfg.pollMinutes) cfg.monitor = { ...(cfg.monitor ?? {}), intervalSec: cfg.pollMinutes * 60 };
    if (cfg.siteName) cfg.site = { ...(cfg.site ?? {}), name: cfg.siteName };
    delete cfg.pollMinutes; delete cfg.siteName;
    cfg.version = 2;
  }
  return cfg;
}

let cached = null;

/** Load, migrate, merge over defaults and validate. Throws on validation errors. */
export function loadConfig({ force = false } = {}) {
  if (cached && !force) return cached;
  ensureDirs();
  let onDisk = {};
  if (fs.existsSync(FILES.config)) {
    const text = fs.readFileSync(FILES.config, 'utf8');
    try {
      onDisk = JSON.parse(text);
    } catch (err) {
      throw new Error(`config/config.json is not valid JSON: ${err.message}`);
    }
  }
  const cfg = deepMerge(DEFAULTS, migrate(onDisk));
  const { errors, warnings } = validate(cfg);
  if (errors.length) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
  cfg.__warnings = warnings;
  cached = cfg;
  return cfg;
}

/** Persist a patch to config.json (validated before it is written). */
export function saveConfig(patch) {
  ensureDirs();
  const current = fs.existsSync(FILES.config) ? JSON.parse(fs.readFileSync(FILES.config, 'utf8')) : {};
  const next = deepMerge(current, patch);
  const merged = deepMerge(DEFAULTS, migrate(next));
  const { errors } = validate(merged);
  if (errors.length) throw new Error(`Refusing to save invalid configuration:\n  - ${errors.join('\n  - ')}`);
  // Atomic write: a half-written config.json on a power cut would brick the service.
  const tmp = `${FILES.config}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, FILES.config);
  cached = null;
  return loadConfig({ force: true });
}
