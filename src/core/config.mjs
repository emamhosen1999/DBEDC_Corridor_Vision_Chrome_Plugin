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
    // The camera's own tamper/scene-change analytics. Opt-in PER CAMERA via
    // `onvifEvents: true` in the inventory: it costs three SOAP round trips per
    // camera per cycle, which is right for a few high-value cameras and wrong for
    // a whole fleet.
    onvifEvents: { enabled: true, timeoutMs: 5000, path: '/onvif/events_service' },
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
    whatsappCloud: {
      enabled: false,
      phoneNumberId: '',
      accessToken: '@vault:whatsappCloud.accessToken',
      to: '',                        // group id when recipientType is 'group', else a phone number
      recipientType: 'individual',   // 'group' | 'individual'
      apiVersion: 'v21.0',
      // Required for alarms raised outside Meta's 24-hour messaging window — which is
      // most overnight alarms. Body must be a single {{1}} variable.
      template: { name: '', languageCode: 'en' },
      routes: {},
    },
    whatsappCallmebot:{ enabled: false, phone: '', apiKey: '@vault:whatsappCallmebot.apiKey', routes: {} },

    telegram:    { enabled: false, botToken: '@vault:telegram.botToken', chatId: '', threadId: '', routes: {} },
    slack:       { enabled: false, webhookUrl: '@vault:slack.webhookUrl', routes: {} },
    teams:       { enabled: false, webhookUrl: '@vault:teams.webhookUrl', routes: {} },
    discord:     { enabled: false, webhookUrl: '@vault:discord.webhookUrl', routes: {} },
    webhook:     { enabled: false, url: '', method: 'POST', headers: {}, secret: '@vault:webhook.secret', routes: {} },
    email:       { enabled: false, host: '', port: 587, secure: false, user: '', pass: '@vault:email.pass', from: '', to: [], routes: {} },
  },

  /**
   * Alarm management — ISA-18.2 / EEMUA 191.
   */
  alarms: {
    enabled: true,
    // Operator positions the alarm load is shared across. EEMUA's rate targets are
    // per position, so a control room with two operators tolerates twice the rate.
    operatorPositions: 1,
    // Active longer than this and an alarm is "standing" — it has become wallpaper.
    standingAfterHours: 24,
    // Shelving is always temporary. This is the hard cap, whatever an operator asks for.
    maxShelveHours: 24,
    defaultShelveHours: 4,
    // Chattering: this many state changes inside the window marks the alarm unstable.
    chatterWindowMin: 10,
    chatterCount: 6,
    // Flood threshold per 10-minute period, per EEMUA 191.
    floodPer10Min: 10,
    // Drop finished alarm instances from the register after this long.
    pruneAfterDays: 7,
    // Alarms at or above this priority are annunciated to remote channels; the rest
    // are recorded and shown on the dashboard only.
    annunciateAtOrAbove: 'low',
  },

  /**
   * The periodic all-device report.
   */
  reporting: {
    enabled: true,
    // 'interval' — every N minutes; 'times' — at fixed site-local wall-clock times.
    mode: 'times',
    times: ['06:00', '14:00', '22:00'],
    intervalMinutes: 360,
    // Include every device in the text report, not just the faulty ones. This is the
    // difference between "what is broken" and "what was checked", and only the second
    // proves coverage.
    fullRegister: true,
    formats: ['text', 'html', 'csv', 'json'],
    // Channels the report is sent to. Empty means every enabled channel.
    channels: [],
    maxChars: 3500,
    retentionDays: 365,
    // Send the report even when nothing is wrong. Recommended: a report that only
    // arrives when there is bad news cannot be distinguished from a dead monitor.
    sendWhenHealthy: true,
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

const PRIORITY_TO_SEVERITY_KEYS = ['diagnostic', 'low', 'medium', 'high', 'critical'];
const remoteChannelNames = (cfg) => Object.entries(cfg.channels ?? {})
  .filter(([k, c]) => c?.enabled && !['dashboard', 'console', 'desktop'].includes(k))
  .map(([k]) => k);

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

  if (cfg.alarms?.enabled) {
    if (!Number.isInteger(cfg.alarms.operatorPositions) || cfg.alarms.operatorPositions < 1) {
      errors.push('alarms.operatorPositions must be a positive integer');
    }
    if (!sev.includes(PRIORITY_TO_SEVERITY_KEYS.includes(cfg.alarms.annunciateAtOrAbove) ? 'info' : 'info')
        && !['diagnostic', 'low', 'medium', 'high', 'critical'].includes(cfg.alarms.annunciateAtOrAbove)) {
      errors.push('alarms.annunciateAtOrAbove must be one of diagnostic, low, medium, high, critical');
    }
    if (cfg.alarms.maxShelveHours > 168) {
      warnings.push('alarms.maxShelveHours above a week effectively allows an alarm to be silenced indefinitely');
    }
    if (cfg.alarms.chatterCount < 3) {
      warnings.push('alarms.chatterCount below 3 will flag normal transitions as chattering');
    }
  }

  const rep = cfg.reporting;
  if (rep?.enabled) {
    if (!['interval', 'times'].includes(rep.mode)) errors.push("reporting.mode must be 'interval' or 'times'");
    if (rep.mode === 'times') {
      if (!rep.times?.length) errors.push('reporting.times must list at least one HH:MM time when mode is "times"');
      for (const t of rep.times ?? []) if (parseHHMM(t) === null) errors.push(`reporting.times entry "${t}" must be HH:MM`);
    } else if (!Number.isFinite(rep.intervalMinutes) || rep.intervalMinutes < 5) {
      errors.push('reporting.intervalMinutes must be at least 5');
    }
    const known = ['text', 'html', 'csv', 'alarm-csv', 'json'];
    for (const f of rep.formats ?? []) if (!known.includes(f)) errors.push(`reporting.formats entry "${f}" is not one of ${known.join(', ')}`);
    if (!rep.formats?.includes('text') && (rep.channels?.length || !remoteChannelNames(cfg).length === false)) {
      warnings.push('reporting.formats does not include "text"; chat channels such as WhatsApp and Telegram can only send the text rendering');
    }
    if (rep.fullRegister === false) {
      warnings.push('reporting.fullRegister is off — the report will list faults only, and will not evidence which devices were actually checked');
    }
  }

  const enabled = Object.entries(cfg.channels ?? {}).filter(([, c]) => c?.enabled).map(([k]) => k);
  const remote = enabled.filter((k) => !['dashboard', 'console', 'desktop'].includes(k));
  if (cfg.alerts?.enabled && remote.length === 0) {
    warnings.push('no off-box alert channel is enabled — alerts will not leave this PC. Enable WhatsApp, Telegram or email.');
  }
  const wac = cfg.channels?.whatsappCloud;
  if (wac?.enabled) {
    if (wac.recipientType === 'group') {
      warnings.push('WhatsApp Cloud API groups are capped at 8 participants — keep the group to a duty roster');
    }
    if (!wac.template?.name) {
      warnings.push(
        'channels.whatsappCloud has no template configured: Meta refuses free-form text outside its '
        + '24-hour messaging window, so overnight alarms will not be delivered. Configure an approved '
        + 'UTILITY template with a single {{1}} body variable.',
      );
    }
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

/**
 * Read a JSON file, tolerating a UTF-8 BOM.
 *
 * Notepad, `Set-Content -Encoding UTF8` on Windows PowerShell 5.1, and most Windows
 * editors prepend U+FEFF. `JSON.parse` rejects it, so a config edited on the very
 * platform this runs on would refuse to load. Strip it rather than bricking the
 * service over an invisible character.
 */
export function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

/** Load, migrate, merge over defaults and validate. Throws on validation errors. */
export function loadConfig({ force = false } = {}) {
  if (cached && !force) return cached;
  ensureDirs();
  let onDisk = {};
  if (fs.existsSync(FILES.config)) {
    try {
      onDisk = readJsonFile(FILES.config);
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
  const current = fs.existsSync(FILES.config) ? readJsonFile(FILES.config) : {};
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
