/**
 * Report and message formatting — the single source of truth.
 *
 * The old extension built the same report in three places with three different sets
 * of details (audit finding M1), and generated a fourth version on every poll that
 * nothing ever read. Every message this system emits — WhatsApp, Telegram, email,
 * desktop toast, dashboard — is rendered from here.
 *
 * The WhatsApp-friendly shape from v1 is deliberately preserved: emoji status
 * markers, a grouped breakdown, then a numbered offline list. That format was well
 * judged for the audience and there was no reason to change it.
 */
import { fmtTime, fmtDuration, fmtShort } from './time.mjs';

export const SEVERITY = { INFO: 'info', WARNING: 'warning', CRITICAL: 'critical' };
export const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

export const SEVERITY_ICON = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };
const STATUS_ICON = { up: '🟢', down: '🔴', degraded: '🟠', unknown: '⚪', flapping: '🔁' };

/** Severity for each alert type. Escalations carry their own. */
export const TYPE_SEVERITY = {
  'camera.down': 'warning',
  'camera.degraded': 'warning',
  'camera.up': 'info',
  'camera.recovered': 'info',
  'camera.flapping': 'warning',
  'camera.stable': 'info',
  'camera.escalation': 'critical',
  'site.groupDown': 'critical',
  'site.groupRecovered': 'info',
  'site.massOutage': 'critical',
  'site.massOutageCleared': 'info',
  'monitor.stalled': 'critical',
  'monitor.recovered': 'info',
  'monitor.networkDown': 'critical',
  'monitor.networkUp': 'info',
  'monitor.started': 'info',
  'monitor.diskLow': 'critical',
  'inventory.added': 'info',
  'inventory.removed': 'info',
  'sla.breach': 'warning',
  'digest.scheduled': 'info',
  'report.manual': 'info',
  'channel.test': 'info',
  // Alarm-register annunciations. Severity comes from the alarm's own priority, so
  // these table entries are only the fallback when one is somehow missing.
  'alarm.raised': 'warning',
  'alarm.cleared': 'info',
  'alarm.acknowledged': 'info',
  'alarm.unshelved': 'info',
  'report.scheduled': 'info',
};

export const severityOf = (alert) => alert.severity ?? TYPE_SEVERITY[alert.type] ?? 'info';

const PRIORITY_ICON = { critical: '🚨', high: '🔴', medium: '🟠', low: '🟡', diagnostic: '🔵' };
const PRIORITY_WORD = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW', diagnostic: 'DIAGNOSTIC' };
export const atLeast = (severity, floor) => SEVERITY_RANK[severity] >= SEVERITY_RANK[floor];

const clean = (s) => String(s ?? '').trim();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Render one alert (or a coalesced batch) into a message.
 * Returns plain text plus a WhatsApp/Telegram-friendly variant.
 */
export function renderAlert(alert, cfg) {
  const tz = cfg.site.timezone;
  const site = cfg.site.name;
  const severity = severityOf(alert);
  const icon = SEVERITY_ICON[severity];
  const stamp = fmtTime(alert.at ?? Date.now(), tz);
  const L = [];
  let title;

  switch (alert.type) {
    case 'camera.down': {
      const items = alert.items ?? [alert];
      title = items.length === 1
        ? `${icon} Camera OFFLINE — ${clean(items[0].name)}`
        : `${icon} ${plural(items.length, 'camera')} OFFLINE`;
      L.push(title, '');
      for (const it of items.slice(0, 25)) {
        L.push(`🔴 ${clean(it.name)}${it.group ? ` — ${clean(it.group)}` : ''}`);
        if (it.host) L.push(`   ${it.host}${it.detail ? ` · ${it.detail}` : ''}`);
      }
      if (items.length > 25) L.push(`…and ${items.length - 25} more`);
      break;
    }
    case 'camera.degraded': {
      const items = alert.items ?? [alert];
      title = items.length === 1
        ? `${icon} Camera DEGRADED — ${clean(items[0].name)}`
        : `${icon} ${plural(items.length, 'camera')} DEGRADED`;
      L.push(title, '');
      L.push('These cameras are reachable but are NOT serving usable video:');
      L.push('');
      for (const it of items.slice(0, 25)) {
        L.push(`🟠 ${clean(it.name)}${it.group ? ` — ${clean(it.group)}` : ''}`);
        if (it.detail) L.push(`   ${it.detail}`);
        for (const w of (it.warnings ?? []).slice(0, 3)) L.push(`   • ${w}`);
      }
      if (items.length > 25) L.push(`…and ${items.length - 25} more`);
      break;
    }
    case 'camera.up':
    case 'camera.recovered': {
      const items = alert.items ?? [alert];
      title = items.length === 1
        ? `✅ Camera back online — ${clean(items[0].name)}`
        : `✅ ${plural(items.length, 'camera')} back online`;
      L.push(title, '');
      for (const it of items.slice(0, 25)) {
        L.push(`🟢 ${clean(it.name)}${it.downtimeMs ? ` (down ${fmtDuration(it.downtimeMs)})` : ''}`);
      }
      if (items.length > 25) L.push(`…and ${items.length - 25} more`);
      break;
    }
    case 'camera.flapping':
      title = `${icon} Unstable camera — ${clean(alert.name)}`;
      L.push(title, '');
      L.push(`🔁 ${clean(alert.name)}${alert.group ? ` — ${clean(alert.group)}` : ''}`);
      L.push(`${alert.changes} state changes in ${alert.windowMin} minutes.`);
      L.push('Per-change alerts for this camera are suppressed until it settles.');
      L.push('Likely cause: PoE power budget, a failing patch lead, or a switch port renegotiating.');
      break;
    case 'camera.stable':
      title = `✅ Camera stable again — ${clean(alert.name)}`;
      L.push(title, '', `${clean(alert.name)} has stopped flapping. Normal alerting resumed.`);
      break;
    case 'camera.escalation':
      title = `${icon} STILL DOWN ${fmtDuration(alert.downtimeMs)} — ${clean(alert.name)}`;
      L.push(title, '');
      L.push(`${STATUS_ICON[alert.status] ?? '🔴'} ${clean(alert.name)}${alert.group ? ` — ${clean(alert.group)}` : ''}`);
      L.push(`Offline since ${fmtTime(alert.since, tz)} (${fmtDuration(alert.downtimeMs)}).`);
      if (alert.detail) L.push(alert.detail);
      L.push('', 'This camera has not recovered on its own. Site attendance is required.');
      break;
    case 'site.groupDown':
      title = `${icon} ENTIRE ZONE DARK — ${clean(alert.group)}`;
      L.push(title, '');
      L.push(`All ${alert.total} cameras in ${clean(alert.group)} are unreachable.`);
      L.push('');
      L.push('This is one fault, not many: check the zone switch, its uplink, and power');
      L.push('before dispatching anyone to individual camera poles.');
      break;
    case 'site.groupRecovered':
      title = `✅ Zone restored — ${clean(alert.group)}`;
      L.push(title, '', `${clean(alert.group)} is reachable again.`);
      break;
    case 'site.massOutage':
      title = `${icon} SITE-WIDE OUTAGE — ${alert.pct}% of cameras down`;
      L.push(title, '');
      L.push(`${alert.down + alert.degraded} of ${alert.total} cameras are not serving video.`);
      L.push('');
      L.push('Treat this as a site-level fault (core switch, fibre, or power), not as');
      L.push('individual camera failures.');
      break;
    case 'site.massOutageCleared':
      title = '✅ Site-wide outage cleared';
      L.push(title, '', `${alert.total - alert.down - alert.degraded} of ${alert.total} cameras are serving video again.`);
      break;
    case 'monitor.stalled':
      title = `${icon} MONITORING HAS STOPPED`;
      L.push(title, '');
      L.push(`No successful monitoring cycle for ${fmtDuration(alert.staleMs)}.`);
      L.push(`Last successful check: ${alert.lastOkAt ? fmtTime(alert.lastOkAt, tz) : 'never'}.`);
      if (alert.reason) L.push(`Reason: ${alert.reason}`);
      L.push('');
      L.push('⚠️ Camera status shown anywhere right now is STALE and must not be trusted.');
      L.push('Check the Corridor Vision service on the monitoring PC.');
      break;
    case 'monitor.recovered':
      title = '✅ Monitoring resumed';
      L.push(title, '');
      L.push(`Monitoring is running again after a ${fmtDuration(alert.gapMs)} gap.`);
      L.push(`Coverage gap: ${fmtTime(alert.gapFrom, tz)} → ${fmtTime(alert.gapTo, tz)}.`);
      L.push('Camera status during that window was not observed.');
      break;
    case 'monitor.networkDown':
      title = `${icon} Monitoring network path is down`;
      L.push(title, '');
      L.push('None of the network reference hosts are reachable from the monitoring PC.');
      L.push('Camera status is being reported as UNKNOWN, not offline, until this clears.');
      break;
    case 'monitor.networkUp':
      title = '✅ Monitoring network path restored';
      L.push(title, '', 'Camera probing has resumed.');
      break;
    case 'monitor.diskLow':
      title = `${icon} Monitoring PC is low on disk`;
      L.push(title, '', `${alert.freePct}% free. History and logs will stop being written if this reaches zero.`);
      break;
    case 'monitor.started':
      title = '▶️ Corridor Vision started';
      L.push(title, '', `Monitoring ${alert.cameras} cameras every ${alert.intervalSec}s.`);
      break;
    case 'inventory.added': {
      const items = alert.items ?? [alert];
      title = `➕ ${plural(items.length, 'camera')} added to monitoring`;
      L.push(title, '');
      for (const it of items.slice(0, 20)) L.push(`• ${clean(it.name)}${it.group ? ` — ${clean(it.group)}` : ''} (${it.host})`);
      break;
    }
    case 'inventory.removed': {
      const items = alert.items ?? [alert];
      title = `➖ ${plural(items.length, 'camera')} removed from monitoring`;
      L.push(title, '');
      for (const it of items.slice(0, 20)) L.push(`• ${clean(it.name)} (${it.host})`);
      break;
    }
    case 'sla.breach':
      title = `${icon} Availability below target — ${alert.uptimePct}%`;
      L.push(title, '');
      L.push(`Today's availability is ${alert.uptimePct}%, below the ${alert.targetPct}% target.`);
      if (alert.worst?.length) {
        L.push('', 'Worst performers:');
        for (const w of alert.worst.slice(0, 10)) L.push(`• ${clean(w.name)} — ${w.uptimePct}% (${plural(w.outages, 'outage')})`);
      }
      break;
    case 'alarm.raised': {
      const items = alert.items ?? [alert];
      const worst = items.reduce((w, a) => (SEVERITY_RANK[severityOf(a)] > SEVERITY_RANK[severityOf(w)] ? a : w), items[0]);
      const pIcon = PRIORITY_ICON[worst.priority] ?? icon;
      title = items.length === 1
        ? `${pIcon} ${PRIORITY_WORD[worst.priority] ?? ''} — ${clean(worst.name)}${worst.subject?.name ? `: ${clean(worst.subject.name)}` : ''}`
        : `${pIcon} ${plural(items.length, 'alarm')} raised`;
      L.push(title, '');
      for (const a of items.slice(0, 15)) {
        const icon2 = PRIORITY_ICON[a.priority] ?? '•';
        L.push(`${icon2} *${clean(a.name)}*${a.subject?.name ? ` — ${clean(a.subject.name)}` : ''}`);
        if (a.subject?.group) L.push(`   Zone: ${clean(a.subject.group)}`);
        if (a.detail) L.push(`   ${a.detail}`);
        // The whole point of rationalising an alarm is that the message can say what
        // to do about it. An alarm that arrives without an action is just noise.
        if (a.definition?.correctiveAction) L.push(`   ➤ ${a.definition.correctiveAction}`);
        if (a.definition?.timeToRespond && a.definition.timeToRespond !== 'None') {
          L.push(`   ⏱ Respond within: ${a.definition.timeToRespond}`);
        }
        if (a.occurrences > 1) L.push(`   (occurrence ${a.occurrences})`);
        L.push('');
      }
      if (items.length > 15) L.push(`…and ${items.length - 15} more`);
      L.push(`Acknowledge on the dashboard, or reply to the operator on duty.`);
      break;
    }
    case 'alarm.cleared': {
      const items = alert.items ?? [alert];
      title = items.length === 1
        ? `✅ Cleared — ${clean(items[0].name)}${items[0].subject?.name ? `: ${clean(items[0].subject.name)}` : ''}`
        : `✅ ${plural(items.length, 'alarm')} cleared`;
      L.push(title, '');
      for (const a of items.slice(0, 20)) {
        L.push(`🟢 ${clean(a.name)}${a.subject?.name ? ` — ${clean(a.subject.name)}` : ''}`
          + `${a.durationMs ? ` (after ${fmtDuration(a.durationMs)})` : ''}`);
        if (a.acknowledged === false) L.push('   ⚠ Cleared before it was acknowledged — still shown on the annunciator.');
      }
      break;
    }
    case 'alarm.unshelved':
      title = `🔔 Alarm returned to service — ${clean(alert.name)}`;
      L.push(title, '');
      L.push(`${clean(alert.name)}${alert.subject?.name ? ` — ${clean(alert.subject.name)}` : ''}`);
      if (alert.expired) L.push(`The shelf expired. Original reason: ${alert.reason ?? 'not stated'}.`);
      if (alert.stillPresent) L.push('The condition is still present, so the alarm has re-annunciated.');
      break;
    case 'alarm.acknowledged':
      title = `👍 Acknowledged — ${clean(alert.name)}`;
      L.push(title, '', `Acknowledged by ${alert.by ?? 'operator'}${alert.note ? `: ${alert.note}` : ''}.`);
      break;
    case 'report.scheduled':
    case 'digest.scheduled':
    case 'report.manual':
      // The digest is composed by buildDigest() and arrives fully rendered.
      return { title: alert.label ?? 'Status digest', text: alert.text, severity, lines: alert.text.split('\n') };
    case 'alerts.rateLimited':
      title = `${icon} Alert rate limit reached`;
      L.push(title, '', alert.detail ?? 'Non-critical alerts are being held until the hour rolls over.');
      break;
    case 'channel.test':
      title = '🔔 Corridor Vision test message';
      L.push(title, '');
      L.push(`If you can read this, the ${alert.channel} channel is working.`);
      L.push(`Site: ${site}`);
      break;
    default:
      title = `${icon} ${alert.type}`;
      L.push(title);
      if (alert.detail) L.push('', alert.detail);
  }

  L.push('');
  L.push(`— ${site} · ${stamp}`);
  const text = L.join('\n');
  return { title, text, severity, lines: L };
}

/**
 * The status report, in the three shapes the operators asked for in v1.
 * `fmt` is 'full' | 'offline' | 'summary'.
 */
export function buildStatusReport({ fleet, cameras, cfg, fmt = 'full', at = Date.now() }) {
  const tz = cfg.site.timezone;
  const stamp = fmtTime(at, tz);
  const bad = cameras.filter((c) => c.status === 'down' || c.status === 'degraded')
    .sort((a, b) => (b.downtimeMs ?? 0) - (a.downtimeMs ?? 0));
  const L = [];

  if (fmt === 'summary') {
    L.push(`Camera Status — ${cfg.site.name}`);
    L.push(stamp);
    L.push(`Total ${fleet.total} · 🟢 ${fleet.up} online · 🔴 ${fleet.down} offline · 🟠 ${fleet.degraded} degraded (${fleet.healthyPct}% up)`);
    if (fleet.unknown) L.push(`⚪ ${fleet.unknown} unknown (not observed this cycle)`);
    L.push('');
    for (const g of fleet.groups) L.push(`${g.name}: 🟢 ${g.up} / 🔴 ${g.down}${g.degraded ? ` / 🟠 ${g.degraded}` : ''}`);
    return L.join('\n');
  }

  if (fmt === 'offline') {
    L.push(`Offline Cameras — ${cfg.site.name}`);
    L.push(`${stamp} · ${fleet.down + fleet.degraded} not serving video / ${fleet.total} total`);
    L.push('');
    if (!bad.length) L.push('✅ All cameras online');
    else bad.forEach((c, i) => {
      L.push(`${i + 1}. ${STATUS_ICON[c.status]} ${clean(c.name)}${c.group ? ` — ${clean(c.group)}` : ''}` +
        `${c.downtimeMs ? ` (down ${fmtDuration(c.downtimeMs)})` : ''}`);
      if (c.detail) L.push(`    ${c.detail}`);
    });
    return L.join('\n');
  }

  // Full report
  L.push('Surveillance Camera Status Report');
  L.push(`Reporting time: ${stamp}`);
  L.push(`Site: ${cfg.site.name} (${fleet.up}/${fleet.total} devices serving video)`);
  L.push('');
  L.push('Online/Offline Summary');
  L.push('');
  for (const g of fleet.groups) {
    const extra = g.degraded ? ` / 🟠 ${g.degraded} degraded` : '';
    L.push(`${g.name} — 🟢 ${g.up} online / 🔴 ${g.down} offline${extra}`);
  }

  const fullyOnline = fleet.groups.filter((g) => g.down + g.degraded + g.unknown === 0 && g.up > 0).map((g) => g.name);
  // A zone with no camera serving video is reported as "no video", not "offline":
  // its cameras may be reachable-but-degraded, which is a different callout.
  const noVideo = fleet.groups.filter((g) => g.up === 0 && g.total > 0)
    .map((g) => (g.down === g.total ? `${g.name} (all offline)` : `${g.name} (${g.degraded} degraded)`));
  const partial = fleet.groups.filter((g) => g.up > 0 && g.down + g.degraded > 0)
    .map((g) => `${g.name} (${g.up}/${g.total} online)`);

  L.push('');
  L.push('Summary');
  L.push(`• Fully online: ${fullyOnline.join(', ') || 'none'}`);
  L.push(`• No video at all: ${noVideo.join(', ') || 'none'}`);
  L.push(`• Partially degraded: ${partial.join(', ') || 'none'}`);
  L.push(`• Overall: ${fleet.up}/${fleet.total} devices online (${fleet.healthyPct}%)`);
  if (fleet.flapping) L.push(`• Unstable (flapping): ${fleet.flapping}`);
  if (fleet.unknown) L.push(`• Not observed this cycle: ${fleet.unknown}`);

  L.push('');
  L.push(`Cameras not serving video (${bad.length}):`);
  if (!bad.length) L.push('✅ All cameras online');
  else bad.forEach((c, i) => {
    L.push(`${i + 1}. ${STATUS_ICON[c.status]} ${clean(c.name)}${c.group ? ` — ${clean(c.group)}` : ''}` +
      `${c.downtimeMs ? ` (down ${fmtDuration(c.downtimeMs)})` : ''}`);
    if (c.detail) L.push(`    ${c.detail}`);
  });
  return L.join('\n');
}

/** The scheduled digest: status plus the availability figures. */
export function buildDigest({ fleet, cameras, cfg, sla, at = Date.now(), label = 'Status digest' }) {
  const L = [];
  L.push(`📋 ${label} — ${cfg.site.name}`);
  L.push(fmtTime(at, cfg.site.timezone));
  L.push('');
  L.push(`🟢 ${fleet.up} online   🔴 ${fleet.down} offline   🟠 ${fleet.degraded} degraded   ⚪ ${fleet.unknown} unknown`);
  L.push(`Fleet health: ${fleet.healthyPct}% of ${fleet.total} cameras`);
  L.push('');

  for (const g of fleet.groups) {
    const mark = g.down + g.degraded === 0 ? '✅' : (g.up === 0 ? '🔴' : '⚠️');
    L.push(`${mark} ${g.name} — ${g.up}/${g.total}`);
  }

  const bad = cameras.filter((c) => c.status === 'down' || c.status === 'degraded')
    .sort((a, b) => (b.downtimeMs ?? 0) - (a.downtimeMs ?? 0));
  if (bad.length) {
    L.push('');
    L.push(`Not serving video (${bad.length}):`);
    bad.slice(0, 30).forEach((c, i) => {
      L.push(`${i + 1}. ${STATUS_ICON[c.status]} ${clean(c.name)} — ${clean(c.group)}${c.downtimeMs ? ` · ${fmtDuration(c.downtimeMs)}` : ''}`);
    });
    if (bad.length > 30) L.push(`…and ${bad.length - 30} more`);
  } else {
    L.push('');
    L.push('✅ Every camera is serving video.');
  }

  if (sla?.rows?.length) {
    L.push('');
    L.push('Availability (last 24h)');
    if (sla.availabilityPct !== null && sla.availabilityPct !== undefined) L.push(`• Fleet: ${sla.availabilityPct}%`);
    const worst = sla.rows.filter((r) => r.uptimePct < 100).slice(0, 8);
    if (worst.length) {
      L.push('• Lowest availability:');
      for (const r of worst) L.push(`   ${clean(r.name)} — ${r.uptimePct}% (${plural(r.outages, 'outage')}, ${fmtDuration(r.downMs)} down)`);
    } else {
      L.push('• No outages recorded.');
    }
  }

  L.push('');
  L.push(`— ${cfg.site.operator}`);
  return L.join('\n');
}

/** Compact one-line timeline entries for the dashboard and email. */
export function renderTimeline(events, cfg, limit = 50) {
  const tz = cfg.site.timezone;
  return events.slice(0, limit).map((e) => {
    const icon = { 'camera.down': '🔴', 'camera.up': '🟢', 'camera.degraded': '🟠', 'camera.recovered': '🟢', 'camera.flapping': '🔁', 'camera.escalation': '🚨' }[e.type] ?? '•';
    const dur = e.downtimeMs ? ` (down ${fmtDuration(e.downtimeMs)})` : '';
    return `${fmtShort(e.ts, tz)}  ${icon} ${clean(e.name ?? e.type)}${dur}`;
  });
}
