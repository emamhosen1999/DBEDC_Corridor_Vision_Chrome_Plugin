/**
 * Report renderers.
 *
 * Four outputs from one model, each shaped for where it lands:
 *
 *   text  — WhatsApp/Telegram. Chunked, emoji status markers, complete register
 *           grouped by zone. This is the one people actually read, so it leads with
 *           what needs doing and puts the register underneath.
 *   html  — email and the dashboard. Printable; a monthly review is run off this.
 *   csv   — the device register as a spreadsheet. One row per device, always.
 *   json  — the whole model, for another system to consume.
 *
 * The registers in all four contain EVERY device. Truncating the full register would
 * defeat the point of a periodic report, which is evidence of what was covered — not
 * just a list of what broke.
 */
import { fmtTime, fmtDuration, fmtShort } from '../core/time.mjs';

const STATUS_ICON = {
  up: '🟢', down: '🔴', degraded: '🟠', unknown: '⚪',
  orphaned: '⚠️', 'not-yet-probed': '⬜', excluded: '⬛',
};
const STATUS_WORD = {
  up: 'OK', down: 'OFFLINE', degraded: 'DEGRADED', unknown: 'UNKNOWN',
  orphaned: 'ORPHANED', 'not-yet-probed': 'NOT PROBED', excluded: 'EXCLUDED',
};
const PRIORITY_ICON = { critical: '🚨', high: '🔴', medium: '🟠', low: '🟡', diagnostic: '🔵' };
const SEVERITY_ICON = { critical: '🚨', warning: '⚠️', info: 'ℹ️' };

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const padL = (s, n) => String(s ?? '').padStart(n);
const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);

/* ============================================================== TEXT === */

/**
 * @param options.fullRegister  include every device (default true — it is the point)
 * @param options.maxChars      split into parts no longer than this
 */
export function renderText(model, { fullRegister = true, maxChars = 3500 } = {}) {
  const { meta, summary, fleet, alarms, kpis, availability, coverage, devices, exceptions } = model;
  const tz = meta.timezone;
  const L = [];

  /* --- header --- */
  L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  L.push(`📋 *${meta.title.toUpperCase()}*`);
  L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  L.push(`Report:  ${meta.reportId}`);
  L.push(`Site:    ${meta.site}`);
  L.push(`Period:  ${fmtTime(meta.periodStart, tz)} → ${fmtTime(meta.periodEnd, tz)}`);
  L.push(`Issued:  ${fmtTime(meta.generatedAt, tz)} (${tz})`);
  L.push('');

  /* --- 1. executive summary --- */
  L.push('*1. SUMMARY*');
  L.push(summary.headline);
  if (summary.availabilityPct !== null && summary.availabilityPct !== undefined) {
    L.push(`Availability this period: ${summary.availabilityPct}%`);
  }
  L.push('');
  for (const f of summary.findings) L.push(`${SEVERITY_ICON[f.severity] ?? '•'} ${f.text}`);
  L.push('');

  /* --- 2. fleet status --- */
  L.push('*2. FLEET STATUS*');
  L.push(`Total cameras      ${padL(summary.counts.total, 5)}`);
  L.push(`🟢 Serving video    ${padL(summary.counts.up, 5)}`);
  L.push(`🔴 Offline          ${padL(summary.counts.down, 5)}`);
  L.push(`🟠 Degraded         ${padL(summary.counts.degraded, 5)}`);
  L.push(`⚪ Unknown          ${padL(summary.counts.unknown, 5)}`);
  if (summary.counts.orphaned) L.push(`⚠️ Orphaned         ${padL(summary.counts.orphaned, 5)}`);
  if (summary.counts.notProbed) L.push(`⬜ Never probed     ${padL(summary.counts.notProbed, 5)}`);
  L.push('');

  /* --- 3. alarm summary --- */
  L.push('*3. ALARM SUMMARY*');
  L.push(`Raised this period  ${padL(alarms.raisedInPeriod, 5)}`);
  L.push(`Cleared             ${padL(alarms.clearedInPeriod, 5)}`);
  L.push(`Outstanding         ${padL(alarms.outstanding.length, 5)}`);
  L.push(`Unacknowledged      ${padL(alarms.unacknowledged, 5)}`);
  const pri = alarms.byPriority;
  if (alarms.raisedInPeriod) {
    L.push(`By priority: 🚨${pri.critical ?? 0} 🔴${pri.high ?? 0} 🟠${pri.medium ?? 0} 🟡${pri.low ?? 0}`);
  }
  if (alarms.outstanding.length) {
    L.push('');
    L.push('Outstanding alarms:');
    for (const a of alarms.outstanding.slice(0, 20)) {
      L.push(`${PRIORITY_ICON[a.priority] ?? '•'} ${a.name}${a.subject ? ` — ${a.subject}` : ''}`);
      L.push(`   since ${fmtShort(a.raisedAt, tz)}${a.state === 'rtn-unack' ? ' (cleared, awaiting ack)' : ''}`);
      // High and critical alarms carry their corrective action into the chat message:
      // for anyone reading this on a phone, the report IS the instruction.
      if ((a.priority === 'critical' || a.priority === 'high') && a.correctiveAction) {
        L.push(`   ➤ ${a.correctiveAction}`);
      }
    }
    if (alarms.outstanding.length > 20) L.push(`   …and ${alarms.outstanding.length - 20} more`);
  }
  if (alarms.held.length) {
    L.push('');
    L.push('Held (shelved / out of service / suppressed):');
    for (const a of alarms.held.slice(0, 10)) {
      const why = a.shelveReason ?? a.outOfServiceReason ?? 'maintenance window';
      const until = a.shelvedUntil ? ` until ${fmtShort(a.shelvedUntil, tz)}` : '';
      L.push(`🔇 ${a.name}${a.subject ? ` — ${a.subject}` : ''}: ${why}${until}`);
    }
  }
  L.push('');

  /* --- 4. zone breakdown --- */
  L.push('*4. ZONE BREAKDOWN*');
  for (const g of fleet.groups ?? []) {
    const mark = g.down + g.degraded === 0 ? '✅' : (g.up === 0 ? '🔴' : '⚠️');
    L.push(`${mark} ${g.name}`);
    L.push(`   ${g.up}/${g.total} serving · uptime ${pct(g.uptimePct)} · ${g.outages} outage${g.outages === 1 ? '' : 's'}`);
  }
  L.push('');

  /* --- 5. exceptions --- */
  L.push(`*5. ACTION REQUIRED* (${exceptions.length})`);
  if (!exceptions.length) {
    L.push('✅ Nothing requires attention.');
  } else {
    exceptions.forEach((d, i) => {
      L.push(`${i + 1}. ${STATUS_ICON[d.status]} *${d.name}* — ${d.group}`);
      L.push(`   ${d.host} · ${STATUS_WORD[d.status]}${d.downtimeMs ? ` for ${fmtDuration(d.downtimeMs)}` : ''}`);
      if (d.detail) L.push(`   ${d.detail}`);
      for (const w of (d.warnings ?? []).slice(0, 3)) L.push(`   ⚠ ${w}`);
      if (d.flapping) L.push('   🔁 unstable — per-change alarms suppressed');
    });
  }
  L.push('');

  /* --- 6. full device register --- */
  if (fullRegister) {
    L.push(`*6. DEVICE REGISTER* (${devices.length} devices)`);
    L.push('Every monitored device, with its state this period.');
    let currentGroup = null;
    for (const d of devices) {
      if (d.group !== currentGroup) {
        currentGroup = d.group;
        L.push('');
        L.push(`▸ ${currentGroup}`);
      }
      const up = d.uptimePct === null ? '' : ` ${pct(d.uptimePct)}`;
      const forStr = d.status === 'up'
        ? (d.forMs ? ` ${fmtDuration(d.forMs)}` : '')
        : (d.downtimeMs ? ` ${fmtDuration(d.downtimeMs)}` : '');
      L.push(`${STATUS_ICON[d.status] ?? '⬜'} ${d.name} · ${d.host}${up}${forStr}`);
    }
    L.push('');
  }

  /* --- 7. availability --- */
  L.push('*7. AVAILABILITY*');
  L.push(`Fleet this period: ${pct(availability.fleetPct)} (${availability.samples} samples)`);
  const worst = availability.cameras.filter((c) => c.uptimePct < 100).slice(0, 10);
  if (worst.length) {
    L.push('');
    L.push('Lowest availability:');
    for (const c of worst) {
      L.push(`   ${c.name} — ${c.uptimePct}% (${c.outages} outage${c.outages === 1 ? '' : 's'}, ${fmtDuration(c.downMs)} down)`);
    }
  } else {
    L.push('No outages recorded this period.');
  }
  L.push('');

  /* --- 8. alarm system performance --- */
  L.push('*8. ALARM SYSTEM PERFORMANCE* (EEMUA 191)');
  L.push(`${kpis.overall.status === 'acceptable' ? '✅' : '⚠️'} ${kpis.overall.summary}`);
  L.push(`Alarm rate    ${kpis.rate.perHour}/hr   (target ≤${kpis.rate.target})  ${kpis.rate.verdict}`);
  L.push(`Peak / 10min  ${kpis.peak.value}        (target ≤${kpis.peak.target})  ${kpis.peak.verdict}`);
  L.push(`Time in flood ${kpis.flood.pct}%        (target <${kpis.flood.target}%)  ${kpis.flood.verdict}`);
  L.push(`Standing      ${kpis.standing.count}        (target <${kpis.standing.target})  ${kpis.standing.verdict}`);
  if (kpis.acknowledgement.meanMs !== null) L.push(`Mean ack time ${fmtDuration(kpis.acknowledgement.meanMs)}`);
  if (kpis.topContributors.items.length) {
    L.push('');
    L.push('Top alarm contributors:');
    for (const c of kpis.topContributors.items.slice(0, 5)) {
      L.push(`   ${c.count}× ${c.name} (${c.pct}%)`);
    }
  }
  L.push('');

  /* --- 9. monitoring system health --- */
  L.push('*9. MONITORING SYSTEM*');
  L.push(coverage.stale
    ? '🚨 Monitoring is STALE — this report is not current.'
    : `✅ Monitoring current · last cycle ${fmtShort(coverage.lastCycleAt, tz)} (${coverage.lastCycleDurationMs} ms)`);
  if (coverage.gaps.length) {
    L.push(`⚠️ ${coverage.gaps.length} coverage gap${coverage.gaps.length === 1 ? '' : 's'} this period:`);
    for (const g of coverage.gaps.slice(0, 5)) {
      L.push(`   ${g.from ? fmtShort(g.from, tz) : '?'} → ${g.to ? fmtShort(g.to, tz) : '?'}${g.gapMs ? ` (${fmtDuration(g.gapMs)})` : ''}`);
    }
  }
  L.push('');
  L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  L.push(`${meta.operator} · ${meta.reportId}`);
  if (meta.nextReportAt) L.push(`Next report: ${fmtTime(meta.nextReportAt, tz)}`);

  return splitParts(L.join('\n'), maxChars, meta.reportId);
}

/** Split on section boundaries so a part never begins mid-table. */
function splitParts(text, maxChars, reportId) {
  if (text.length <= maxChars) return [text];
  const lines = text.split('\n');
  const parts = [];
  let buf = [];
  let size = 0;
  for (const line of lines) {
    const lineSize = line.length + 1;
    // Prefer to break before a numbered section heading.
    const isHeading = /^\*\d+\./.test(line);
    if (size + lineSize > maxChars && buf.length && (isHeading || size > maxChars * 0.8)) {
      parts.push(buf.join('\n'));
      buf = [];
      size = 0;
    }
    buf.push(line);
    size += lineSize;
  }
  if (buf.length) parts.push(buf.join('\n'));
  return parts.map((p, i) => `${p}\n\n_(${reportId} — part ${i + 1} of ${parts.length})_`);
}

/* ============================================================== HTML === */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderHtml(model) {
  const { meta, summary, fleet, alarms, kpis, availability, coverage, devices, exceptions } = model;
  const tz = meta.timezone;
  const badge = (status) => `<span class="s s-${status}">${STATUS_WORD[status] ?? status}</span>`;
  const kpiRow = (label, value, target, v) =>
    `<tr><td>${esc(label)}</td><td class="num">${esc(value)}</td><td class="num">${esc(target)}</td><td><span class="v v-${v.replace(/\s+/g, '-')}">${esc(v)}</span></td></tr>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.reportId)} — ${esc(meta.site)}</title>
<style>
  :root{--ink:#16202e;--muted:#5d6b80;--line:#dfe5ee;--bg:#fff;--panel:#f7f9fc;
        --up:#1e8a56;--down:#c6343a;--deg:#c07a1e;--unk:#6b7a90;--crit:#8b1a1f}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.55 "Segoe UI",system-ui,sans-serif}
  .page{max-width:1000px;margin:0 auto;padding:28px 22px 60px}
  header{border-bottom:3px solid var(--ink);padding-bottom:14px;margin-bottom:22px}
  h1{font-size:20px;margin:0 0 4px}
  .meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:4px 18px;color:var(--muted);font-size:12px;margin-top:8px}
  .meta b{color:var(--ink);font-weight:600}
  h2{font-size:14px;margin:26px 0 10px;padding-bottom:5px;border-bottom:1px solid var(--line);text-transform:uppercase;letter-spacing:.05em}
  .finding{padding:8px 12px;border-left:3px solid var(--line);background:var(--panel);margin-bottom:6px;border-radius:0 5px 5px 0}
  .finding.critical{border-left-color:var(--crit);background:#fdf1f1}
  .finding.warning{border-left-color:var(--deg);background:#fdf8ef}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin:14px 0}
  .tile{border:1px solid var(--line);border-radius:7px;padding:10px 12px;background:var(--panel)}
  .tile .n{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
  .tile .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
  th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);
     border-bottom:1.5px solid var(--line);padding:6px 8px;white-space:nowrap}
  td{padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  tr.grp td{background:var(--panel);font-weight:700;padding-top:9px}
  .s{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10.5px;font-weight:700;white-space:nowrap}
  .s-up{background:#e3f4ec;color:var(--up)} .s-down{background:#fbe6e7;color:var(--down)}
  .s-degraded{background:#fbf0e0;color:var(--deg)} .s-unknown{background:#eceff3;color:var(--unk)}
  .s-orphaned,.s-not-yet-probed,.s-excluded{background:#eceff3;color:var(--unk)}
  .v{font-size:10.5px;font-weight:700} .v-acceptable{color:var(--up)} .v-manageable{color:var(--deg)}
  .v-above-target{color:var(--down)}
  .p{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:-1px}
  .p-critical{background:var(--crit)} .p-high{background:var(--down)} .p-medium{background:var(--deg)}
  .p-low{background:#c9b02e} .p-diagnostic{background:var(--unk)}
  .muted{color:var(--muted);font-size:11.5px}
  footer{margin-top:34px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}
  @media print{.page{max-width:none;padding:0} h2{page-break-after:avoid} tr{page-break-inside:avoid}}
</style></head><body><div class="page">

<header>
  <h1>${esc(meta.title)}</h1>
  <div class="muted">${esc(meta.site)}</div>
  <div class="meta">
    <div><b>Report</b> ${esc(meta.reportId)}</div>
    <div><b>Period</b> ${esc(fmtTime(meta.periodStart, tz))} → ${esc(fmtTime(meta.periodEnd, tz))}</div>
    <div><b>Issued</b> ${esc(fmtTime(meta.generatedAt, tz))} (${esc(tz)})</div>
    <div><b>Devices</b> ${devices.length}</div>
    <div><b>Standard</b> ${esc(meta.standard)}</div>
  </div>
</header>

<h2>1. Executive summary</h2>
<p><strong>${esc(summary.headline)}</strong>${summary.availabilityPct != null ? ` · availability ${summary.availabilityPct}%` : ''}</p>
${summary.findings.map((f) => `<div class="finding ${f.severity}">${esc(f.text)}</div>`).join('')}

<h2>2. Fleet status</h2>
<div class="tiles">
  ${[['Total', summary.counts.total], ['Serving video', summary.counts.up], ['Offline', summary.counts.down],
     ['Degraded', summary.counts.degraded], ['Unknown', summary.counts.unknown]]
    .map(([l, n]) => `<div class="tile"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`).join('')}
</div>
<table><thead><tr><th>Zone</th><th class="num">Devices</th><th class="num">Serving</th><th class="num">Offline</th><th class="num">Degraded</th><th class="num">Uptime</th><th class="num">Outages</th></tr></thead><tbody>
${(fleet.groups ?? []).map((g) => `<tr><td>${esc(g.name)}</td><td class="num">${g.total}</td><td class="num">${g.up}</td><td class="num">${g.down}</td><td class="num">${g.degraded}</td><td class="num">${pct(g.uptimePct)}</td><td class="num">${g.outages}</td></tr>`).join('')}
</tbody></table>

<h2>3. Alarm summary</h2>
<div class="tiles">
  ${[['Raised', alarms.raisedInPeriod], ['Cleared', alarms.clearedInPeriod], ['Outstanding', alarms.outstanding.length],
     ['Unacknowledged', alarms.unacknowledged], ['Held', alarms.held.length]]
    .map(([l, n]) => `<div class="tile"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`).join('')}
</div>
${alarms.outstanding.length ? `<table><thead><tr><th>Priority</th><th>Alarm</th><th>Subject</th><th>Zone</th><th>Since</th><th>State</th><th>Required action</th></tr></thead><tbody>
${alarms.outstanding.map((a) => `<tr><td><span class="p p-${a.priority}"></span>${esc(a.priority)}</td><td>${esc(a.name)}</td><td>${esc(a.subject ?? '—')}</td><td>${esc(a.group ?? '—')}</td><td>${a.raisedAt ? esc(fmtShort(a.raisedAt, tz)) : '—'}</td><td>${esc(a.state)}</td><td class="muted">${esc(a.correctiveAction ?? '')}</td></tr>`).join('')}
</tbody></table>` : '<p class="muted">No outstanding alarms.</p>'}
${alarms.held.length ? `<h3 class="muted">Held alarms</h3><table><thead><tr><th>Alarm</th><th>Subject</th><th>Hold</th><th>Reason</th><th>Until</th></tr></thead><tbody>
${alarms.held.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.subject ?? '—')}</td><td>${esc(a.state)}</td><td>${esc(a.shelveReason ?? a.outOfServiceReason ?? 'maintenance window')}</td><td>${a.shelvedUntil ? esc(fmtShort(a.shelvedUntil, tz)) : '—'}</td></tr>`).join('')}
</tbody></table>` : ''}

<h2>4. Action required (${exceptions.length})</h2>
${exceptions.length ? `<table><thead><tr><th>Camera</th><th>Zone</th><th>Address</th><th>State</th><th class="num">Duration</th><th>Finding</th></tr></thead><tbody>
${exceptions.map((d) => `<tr><td><strong>${esc(d.name)}</strong></td><td>${esc(d.group)}</td><td>${esc(d.host)}</td><td>${badge(d.status)}</td><td class="num">${d.downtimeMs ? esc(fmtDuration(d.downtimeMs)) : '—'}</td><td>${esc(d.detail ?? '')}${(d.warnings ?? []).map((w) => `<div class="muted">⚠ ${esc(w)}</div>`).join('')}${d.flapping ? '<div class="muted">🔁 unstable</div>' : ''}</td></tr>`).join('')}
</tbody></table>` : '<p>Nothing requires attention.</p>'}

<h2>5. Device register — all ${devices.length} devices</h2>
<table><thead><tr><th>Camera</th><th>Address</th><th>State</th><th class="num">For</th><th class="num">Uptime</th><th class="num">Outages</th><th class="num">Latency</th><th>Last probe</th></tr></thead><tbody>
${renderRegisterRows(devices, tz, badge)}
</tbody></table>

<h2>6. Availability</h2>
<p>Fleet availability this period: <strong>${pct(availability.fleetPct)}</strong> <span class="muted">(${availability.samples} samples)</span></p>
${availability.daily.length ? `<table><thead><tr><th>Day</th><th class="num">Uptime</th><th class="num">Worst concurrent down</th><th class="num">Samples</th></tr></thead><tbody>
${availability.daily.map((d) => `<tr><td>${esc(d.day)}</td><td class="num">${pct(d.uptimePct)}</td><td class="num">${d.worstConcurrentDown}</td><td class="num">${d.samples}</td></tr>`).join('')}
</tbody></table>` : ''}

<h2>7. Alarm system performance (EEMUA 191)</h2>
<div class="finding ${kpis.overall.status === 'acceptable' ? '' : 'warning'}">${esc(kpis.overall.summary)}</div>
<table><thead><tr><th>Metric</th><th class="num">Measured</th><th class="num">Target</th><th>Verdict</th></tr></thead><tbody>
${kpiRow('Average alarm rate (per hour, per operator)', kpis.rate.perHour, `≤ ${kpis.rate.target}`, kpis.rate.verdict)}
${kpiRow('Peak alarms in any 10 minutes', kpis.peak.value, `≤ ${kpis.peak.target}`, kpis.peak.verdict)}
${kpiRow('Time in alarm flood', `${kpis.flood.pct}%`, `< ${kpis.flood.target}%`, kpis.flood.verdict)}
${kpiRow('Standing alarms', kpis.standing.count, `< ${kpis.standing.target}`, kpis.standing.verdict)}
${kpiRow('Top 10 share of alarm load', `${kpis.topContributors.topTenPct}%`, `≤ ${kpis.topContributors.target}%`, kpis.topContributors.verdict)}
</tbody></table>
${kpis.topContributors.items.length ? `<h3 class="muted">Top contributors</h3><table><thead><tr><th>Alarm</th><th class="num">Count</th><th class="num">Share</th><th class="num">Devices</th></tr></thead><tbody>
${kpis.topContributors.items.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${c.count}</td><td class="num">${c.pct}%</td><td class="num">${c.distinctSubjects}</td></tr>`).join('')}
</tbody></table>` : ''}

<h2>8. Monitoring system health</h2>
<div class="finding ${coverage.stale ? 'critical' : ''}">${coverage.stale
    ? 'Monitoring is stale — this report describes the last known state, not the present one.'
    : `Monitoring current. Last cycle ${esc(fmtTime(coverage.lastCycleAt, tz))}, ${coverage.lastCycleDurationMs} ms.`}</div>
${coverage.gaps.length ? `<p class="muted">${coverage.gaps.length} coverage gap(s) this period — availability figures are incomplete.</p>` : ''}

<footer>
  ${esc(meta.operator)} · ${esc(meta.reportId)} · generated ${esc(fmtTime(meta.generatedAt, tz))} (${esc(tz)})<br>
  Alarm management to ${esc(meta.standard)}.
</footer>
</div></body></html>`;
}

function renderRegisterRows(devices, tz, badge) {
  const out = [];
  let group = null;
  for (const d of devices) {
    if (d.group !== group) {
      group = d.group;
      out.push(`<tr class="grp"><td colspan="8">${esc(group)}</td></tr>`);
    }
    const forMs = d.status === 'up' ? d.forMs : d.downtimeMs;
    out.push(`<tr><td>${esc(d.name)}</td><td>${esc(d.host)}</td><td>${badge(d.status)}</td>`
      + `<td class="num">${forMs ? esc(fmtDuration(forMs)) : '—'}</td>`
      + `<td class="num">${pct(d.uptimePct)}</td><td class="num">${d.outages}</td>`
      + `<td class="num">${d.latencyMs != null ? `${d.latencyMs} ms` : '—'}</td>`
      + `<td>${d.lastProbeAt ? esc(fmtShort(d.lastProbeAt, tz)) : 'never'}</td></tr>`);
  }
  return out.join('');
}

/* =============================================================== CSV === */

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The device register as a spreadsheet. One row per device, always complete. */
export function renderCsv(model) {
  const { meta, devices } = model;
  const head = [
    'Report', 'Site', 'Period start', 'Period end', 'Camera', 'Zone', 'Address',
    'State', 'For', 'Uptime %', 'Outages', 'Total down', 'Longest outage',
    'Latency ms', 'Last probe', 'Vendor', 'Model', 'Enabled', 'Finding', 'Warnings',
  ];
  const tz = meta.timezone;
  const rows = devices.map((d) => [
    meta.reportId, meta.site, fmtTime(meta.periodStart, tz), fmtTime(meta.periodEnd, tz),
    d.name, d.group, d.host,
    STATUS_WORD[d.status] ?? d.status,
    fmtDuration(d.status === 'up' ? d.forMs : d.downtimeMs),
    d.uptimePct ?? '', d.outages ?? 0,
    fmtDuration(d.periodDownMs ?? 0), fmtDuration(d.longestOutageMs ?? 0),
    d.latencyMs ?? '', d.lastProbeAt ? fmtTime(d.lastProbeAt, tz) : 'never',
    d.vendor ?? '', d.model ?? '', d.enabled ? 'yes' : 'no',
    d.detail ?? '', (d.warnings ?? []).join('; '),
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** The alarm log as a spreadsheet — a separate sheet from the device register. */
export function renderAlarmCsv(model) {
  const { meta, alarms } = model;
  const tz = meta.timezone;
  const head = ['Report', 'Tag', 'Alarm', 'Class', 'Priority', 'State', 'Subject', 'Zone', 'Raised', 'Acknowledged', 'By', 'Occurrences', 'Detail', 'Corrective action'];
  const rows = [...alarms.outstanding, ...alarms.held].map((a) => [
    meta.reportId, a.tag, a.name, a.class, a.priority, a.state,
    a.subject ?? '', a.group ?? '',
    a.raisedAt ? fmtTime(a.raisedAt, tz) : '',
    a.ackedAt ? fmtTime(a.ackedAt, tz) : '',
    a.ackedBy ?? '', a.occurrences ?? 0, a.detail ?? '', a.correctiveAction ?? '',
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/* ============================================================== JSON === */

export function renderJson(model) {
  return JSON.stringify(model, null, 2);
}

export const RENDERERS = {
  text: renderText,
  html: renderHtml,
  csv: renderCsv,
  'alarm-csv': renderAlarmCsv,
  json: renderJson,
};

export function render(model, format = 'text', options) {
  const fn = RENDERERS[format];
  if (!fn) throw new Error(`Unknown report format "${format}". Available: ${Object.keys(RENDERERS).join(', ')}`);
  return fn(model, options);
}
