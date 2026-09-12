/* Corridor Vision dashboard.
 *
 * Vanilla ES modules, no build step, no framework, no CDN. The page must load on a
 * control-room PC that may have no internet at all.
 *
 * Live data arrives over SSE. Everything that renders a value from the API goes
 * through `el()` or `text`, never innerHTML with interpolated data — camera names come
 * from a CSV an operator edited and are treated as untrusted.
 */

const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts }).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
});

const STATE = { status: null, cameras: [], site: null, notify: false };

/* ------------------------------------------------------------- helpers --- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c) node.append(c);
  return node;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

const tz = () => STATE.site?.site?.timezone ?? undefined;
const fmtTime = (ts) => new Date(ts).toLocaleString('en-GB', { timeZone: tz(), day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtClock = (ts) => new Date(ts).toLocaleTimeString('en-GB', { timeZone: tz(), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const STATUS_LABEL = { up: 'Serving', down: 'Offline', degraded: 'Degraded', unknown: 'Unknown' };

function statusPill(status, flapping) {
  const wrap = el('span', { class: `pill ${status ?? 'unknown'}`, text: STATUS_LABEL[status] ?? 'Unknown' });
  if (!flapping) return wrap;
  return el('span', {}, wrap, ' ', el('span', { class: 'pill flap', text: 'flapping', title: 'Changing state repeatedly — individual alerts suppressed' }));
}

let toastTimer;
function toast(message, ms = 2600) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* --------------------------------------------------------------- render --- */

function renderOverview() {
  const s = STATE.status;
  if (!s) return;
  const f = s.fleet;
  $('t-total').textContent = f.total;
  $('t-up').textContent = f.up;
  $('t-down').textContent = f.down;
  $('t-degraded').textContent = f.degraded;
  $('t-unknown').textContent = f.unknown;
  $('t-health').textContent = `${f.healthyPct ?? 0}%`;

  const bar = $('health-bar');
  const total = Math.max(1, f.total);
  const segs = { up: f.up, degraded: f.degraded, down: f.down, unknown: f.unknown };
  for (const [cls, n] of Object.entries(segs)) {
    bar.querySelector(`.seg.${cls}`).style.width = `${(n / total) * 100}%`;
  }

  const groups = $('groups');
  groups.replaceChildren(...(f.groups ?? []).map((g) => {
    const cls = g.down > 0 ? 'group has-down' : g.degraded > 0 ? 'group has-degraded' : 'group';
    return el('div', { class: cls },
      el('div', { class: 'g-name', text: g.name }),
      el('div', { class: 'g-counts' },
        el('span', { text: `${g.up}/${g.total} serving` }),
        g.down ? el('span', { style: 'color:var(--down)', text: `${g.down} offline` }) : null,
        g.degraded ? el('span', { style: 'color:var(--degraded)', text: `${g.degraded} degraded` }) : null,
        g.unknown ? el('span', { style: 'color:var(--unknown)', text: `${g.unknown} unknown` }) : null,
      ));
  }));

  const bad = STATE.cameras.filter((c) => c.status === 'down' || c.status === 'degraded' || c.status === 'unknown')
    .sort((a, b) => (b.downtimeMs ?? 0) - (a.downtimeMs ?? 0));
  $('bad-count').textContent = bad.length;
  $('bad-list').replaceChildren(...(bad.length
    ? bad.slice(0, 60).map((c) => el('div', { class: `card ${c.status}` },
        el('div', { class: 'c-name' }, el('span', { text: c.name }), statusPill(c.status, c.flapping)),
        el('div', { class: 'c-meta', text: `${c.group ?? 'Ungrouped'} · ${c.host} · down ${fmtDuration(c.downtimeMs)}` }),
        c.detail ? el('div', { class: 'c-detail', text: c.detail }) : null,
        ...(c.warnings ?? []).slice(0, 3).map((w) => el('div', { class: 'c-warn', text: `⚠ ${w}` })),
      ))
    : [el('div', { class: 'card', text: '✅ Every camera is serving video.' })]));
}

function renderCameras() {
  const q = $('search').value.trim().toLowerCase();
  const fs = $('filter-status').value;
  const fg = $('filter-group').value;
  const sort = $('sort').value;

  const groupSel = $('filter-group');
  const groups = [...new Set(STATE.cameras.map((c) => c.group ?? 'Ungrouped'))].sort();
  if (groupSel.options.length !== groups.length + 1) {
    groupSel.replaceChildren(el('option', { value: '', text: 'All zones' }), ...groups.map((g) => el('option', { value: g, text: g })));
    groupSel.value = fg;
  }

  const rank = { down: 0, degraded: 1, unknown: 2, up: 3 };
  const rows = STATE.cameras
    .filter((c) => !fs || c.status === fs)
    .filter((c) => !fg || (c.group ?? 'Ungrouped') === fg)
    .filter((c) => !q || `${c.name} ${c.host} ${c.group ?? ''} ${c.detail ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'downtime') return (b.downtimeMs ?? 0) - (a.downtimeMs ?? 0);
      if (sort === 'latency') return (b.latencyMs ?? -1) - (a.latencyMs ?? -1);
      return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.name.localeCompare(b.name);
    });

  $('camera-rows').replaceChildren(...rows.map((c) => el('tr', {},
    el('td', {}, statusPill(c.status, c.flapping)),
    el('td', { text: c.name }),
    el('td', { text: c.group ?? 'Ungrouped' }),
    el('td', {}, el('code', { text: c.host })),
    el('td', { text: c.status === 'up' ? fmtDuration(Date.now() - c.since) : fmtDuration(c.downtimeMs) }),
    el('td', { text: c.latencyMs != null ? `${c.latencyMs} ms` : '—' }),
    el('td', {},
      el('div', { text: c.detail ?? '' }),
      ...(c.warnings ?? []).map((w) => el('div', { class: 'c-warn', text: `⚠ ${w}` }))),
    el('td', {}, el('button', { class: 'btn ghost', text: 'Probe', onclick: () => probeOne(c) })),
  )));
  $('camera-count').textContent = `${rows.length} of ${STATE.cameras.length} cameras`;
}

async function probeOne(camera) {
  toast(`Probing ${camera.name}…`, 8000);
  try {
    const r = await api('/api/probe', { method: 'POST', body: JSON.stringify({ host: camera.host, id: camera.cameraId, name: camera.name }) });
    showOutput(JSON.stringify(r, null, 2));
    toast(`${camera.name}: ${r.status}${r.detail ? ` — ${r.detail}` : ''}`, 6000);
  } catch (err) { toast(`Probe failed: ${err.message}`, 5000); }
}

function showOutput(text) {
  const out = $('settings-output');
  out.textContent = text;
  out.hidden = false;
  out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const EVENT_ICON = {
  'camera.down': '🔴', 'camera.up': '🟢', 'camera.degraded': '🟠', 'camera.recovered': '🟢',
  'camera.flapping': '🔁', 'camera.escalation': '🚨', 'camera.stable': '✅',
  'site.groupDown': '🚨', 'site.massOutage': '🚨', 'site.groupRecovered': '✅', 'site.massOutageCleared': '✅',
  'monitor.stalled': '⛔', 'monitor.recovered': '▶️', 'monitor.networkDown': '🌐', 'monitor.networkUp': '🌐',
  'monitor.started': '▶️', 'inventory.added': '➕', 'inventory.removed': '➖', 'sla.breach': '📉',
};

const EVENT_TEXT = {
  'camera.down': (e) => `${e.name} went offline`,
  'camera.up': (e) => `${e.name} is serving video again${e.downtimeMs ? ` after ${fmtDuration(e.downtimeMs)}` : ''}`,
  'camera.degraded': (e) => `${e.name} is degraded`,
  'camera.recovered': (e) => `${e.name} recovered${e.downtimeMs ? ` after ${fmtDuration(e.downtimeMs)}` : ''}`,
  'camera.flapping': (e) => `${e.name} is flapping — ${e.changes} changes in ${e.windowMin} min`,
  'camera.escalation': (e) => `${e.name} still down after ${fmtDuration(e.downtimeMs)}`,
  'camera.stable': (e) => `${e.name} has stabilised`,
  'site.groupDown': (e) => `Entire zone dark: ${e.group} (${e.total} cameras)`,
  'site.groupRecovered': (e) => `Zone restored: ${e.group}`,
  'site.massOutage': (e) => `Site-wide outage — ${e.pct}% of cameras not serving video`,
  'site.massOutageCleared': () => 'Site-wide outage cleared',
  'monitor.stalled': (e) => `Monitoring stalled for ${fmtDuration(e.staleMs)}`,
  'monitor.recovered': (e) => `Monitoring resumed after a ${fmtDuration(e.gapMs)} gap`,
  'monitor.networkDown': () => 'Monitoring network path went down',
  'monitor.networkUp': () => 'Monitoring network path restored',
  'monitor.started': (e) => `Service started — ${e.cameras} cameras every ${e.intervalSec}s`,
  'inventory.added': (e) => `${e.name} added to monitoring`,
  'inventory.removed': (e) => `${e.name} removed from monitoring`,
  'sla.breach': (e) => `Availability ${e.uptimePct}% is below the ${e.targetPct}% target`,
};

async function loadTimeline() {
  const hours = Number($('timeline-range').value);
  const types = $('timeline-type').value;
  const { events } = await api(`/api/events?since=${Date.now() - hours * 3600e3}&limit=500${types ? `&types=${types}` : ''}`);
  $('timeline').replaceChildren(...(events.length
    ? events.map((e) => el('li', {},
        el('span', { class: 'when', text: fmtTime(e.ts) }),
        el('span', { text: EVENT_ICON[e.type] ?? '•' }),
        el('span', { class: 'what' },
          el('strong', { text: EVENT_TEXT[e.type]?.(e) ?? e.type }),
          e.detail ? el('div', { class: 'sub', text: e.detail }) : null,
          e.group ? el('div', { class: 'sub', text: e.group }) : null),
      ))
    : [el('li', {}, el('span', {}), el('span', {}), el('span', { class: 'what', text: 'No events in this period.' }))]));
}

async function loadUptime() {
  const hours = Number($('uptime-range').value);
  const m = await api(`/api/metrics?hours=${hours}`);
  $('uptime-summary').textContent = m.trend.availabilityPct !== null
    ? `Fleet availability ${m.trend.availabilityPct}% over ${hours}h · ${m.trend.samples} samples`
    : 'Not enough history yet.';

  const chart = $('trend-chart');
  chart.replaceChildren(...m.trend.points.map((p) => {
    const pct = p.healthyPct ?? 0;
    const cls = pct >= 98 ? 'col' : pct >= 90 ? 'col warn' : 'col bad';
    return el('div', {
      class: cls,
      style: `height:${Math.max(2, pct)}%`,
      title: `${fmtTime(p.ts)} — ${pct}% (${p.up}/${p.total})`,
    });
  }));

  $('uptime-rows').replaceChildren(...m.cameras.slice(0, 100).map((r) => el('tr', {},
    el('td', { text: r.name }),
    el('td', { text: r.group }),
    el('td', { text: `${r.uptimePct}%` }),
    el('td', { text: String(r.outages) }),
    el('td', { text: fmtDuration(r.downMs) }),
    el('td', { text: fmtDuration(r.longestOutageMs) }),
    el('td', { text: r.outages ? fmtDuration(r.mttrMs) : '—' }),
  )));
}

async function loadAlerts() {
  const [{ channels }, queue] = await Promise.all([api('/api/channels'), api('/api/queue')]);
  $('channel-list').replaceChildren(...(channels.length
    ? channels.map((c) => el('div', { class: `card ${c.ok ? '' : 'degraded'}` },
        el('div', { class: 'c-name' }, el('span', { text: c.channel }), el('span', { class: `pill ${c.ok ? 'up' : 'degraded'}`, text: c.ok ? 'ready' : 'needs setup' })),
        el('div', { class: 'c-meta', text: c.describe }),
        ...c.problems.map((p) => el('div', { class: 'c-warn', text: p })),
        el('div', { style: 'margin-top:8px' },
          el('button', { class: 'btn ghost', text: 'Send test', onclick: (ev) => testChannel(c.channel, ev.target) })),
      ))
    : [el('div', { class: 'card', text: 'No alert channels are enabled. Enable one in Settings so alerts leave this PC.' })]));

  $('queue-count').textContent = queue.pending;
  $('queue-pending').replaceChildren(...(queue.pending
    ? Object.entries(queue.byChannel).map(([ch, n]) => el('div', { class: 'card' },
        el('div', { class: 'c-name' }, el('span', { text: ch }), el('span', { class: 'pill degraded', text: `${n} waiting` }))))
    : [el('div', { class: 'card', text: 'Queue is empty — everything has been delivered.' })]));

  $('delivery-rows').replaceChildren(...queue.history.map((h) => el('tr', {},
    el('td', { text: fmtTime(h.sentAt) }),
    el('td', { text: h.channel }),
    el('td', { text: h.alertType }),
    el('td', {}, h.ok
      ? el('span', { class: 'pill up', text: `sent${h.attempts > 1 ? ` (attempt ${h.attempts})` : ''}` })
      : el('span', { class: 'pill down', text: h.error ?? h.reason ?? 'failed' })),
  )));
}

async function testChannel(name, button) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Sending…';
  try {
    const r = await api('/api/channels/test', { method: 'POST', body: JSON.stringify({ channel: name }) });
    toast(r.ok ? `✅ Test message sent via ${name}` : `❌ ${name}: ${r.error}`, 7000);
  } catch (err) {
    toast(`❌ ${name}: ${err.message}`, 7000);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/* ---------------------------------------------------------------- alarms --- */

const PRIORITY_LABEL = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW', diagnostic: 'DIAG' };
const ALARM_STATE_LABEL = {
  'unack-alarm': 'unacknowledged',
  'ack-alarm': 'acknowledged, still active',
  'rtn-unack': 'cleared — awaiting acknowledgement',
  shelved: 'shelved',
  'suppressed-by-design': 'suppressed (maintenance)',
  'out-of-service': 'out of service',
  normal: 'normal',
};

async function loadAlarms() {
  const scope = $('alarm-scope').value;
  const [data, kpi] = await Promise.all([api(`/api/alarms?scope=${scope}`), api('/api/alarms/kpi?hours=24')]);

  $('alarm-counts').textContent =
    `${data.counts.annunciated} needing attention · ${data.counts.unacknowledged} unacknowledged · ${data.counts.standing} standing`;
  updateAlarmBadge(data.counts.annunciated);

  $('alarm-list').replaceChildren(...(data.alarms.length
    ? data.alarms.map(alarmCard)
    : [el('div', { class: 'card', text: '✅ No alarms. Nothing requires attention.' })]));

  const v = $('kpi-verdict');
  v.hidden = false;
  v.className = `banner ${kpi.overall.status === 'acceptable' ? '' : kpi.overall.status === 'overloaded' ? 'critical' : 'warn'}`;
  v.textContent = kpi.overall.summary;

  const row = (label, measured, target, verdict) => el('tr', {},
    el('td', { text: label }),
    el('td', { class: 'num', text: String(measured) }),
    el('td', { class: 'num', text: String(target) }),
    el('td', {}, el('span', { class: `pill ${verdict === 'acceptable' ? 'up' : verdict === 'manageable' ? 'degraded' : 'down'}`, text: verdict })));

  $('kpi-rows').replaceChildren(
    row('Average alarm rate (per hour)', kpi.rate.perHour, `≤ ${kpi.rate.target}`, kpi.rate.verdict),
    row('Peak alarms in any 10 minutes', kpi.peak.value, `≤ ${kpi.peak.target}`, kpi.peak.verdict),
    row('Time in alarm flood', `${kpi.flood.pct}%`, `< ${kpi.flood.target}%`, kpi.flood.verdict),
    row('Standing alarms', kpi.standing.count, `< ${kpi.standing.target}`, kpi.standing.verdict),
    row('Chattering alarms', kpi.registerState.chattering, '0', kpi.registerState.chattering ? 'above target' : 'acceptable'),
    row('Shelved / out of service', `${kpi.registerState.shelved} / ${kpi.registerState.outOfService}`, '—', 'acceptable'),
    row('Mean time to acknowledge', kpi.acknowledgement.meanMs != null ? fmtDuration(kpi.acknowledgement.meanMs) : '—', '—', 'acceptable'),
  );

  $('contributor-rows').replaceChildren(...kpi.topContributors.items.map((c) => el('tr', {},
    el('td', { text: c.name }),
    el('td', { class: 'num', text: String(c.count) }),
    el('td', { class: 'num', text: `${c.pct}%` }),
    el('td', { class: 'num', text: String(c.distinctSubjects) }))));
}

function alarmCard(a) {
  const actions = [];
  if (a.state === 'unack-alarm' || a.state === 'rtn-unack') {
    actions.push(el('button', { class: 'btn primary', text: '✓ Acknowledge', onclick: () => alarmAction('/api/alarms/ack', { key: a.key }) }));
  }
  if (a.state === 'shelved') {
    actions.push(el('button', { class: 'btn', text: 'Return to service', onclick: () => alarmAction('/api/alarms/unshelve', { key: a.key }) }));
  } else if (a.shelvable && a.state !== 'out-of-service') {
    actions.push(el('button', {
      class: 'btn ghost', text: '🔇 Shelve',
      onclick: () => {
        // A reason is mandatory — an alarm silenced without one is how alarm systems rot.
        const reason = window.prompt('Why is this alarm being shelved? (required — the shelf expires automatically)');
        if (!reason) return;
        const hours = Number(window.prompt('Shelve for how many hours?', '4')) || 4;
        alarmAction('/api/alarms/shelve', { key: a.key, reason, hours });
      },
    }));
  }
  if (a.state === 'out-of-service') {
    actions.push(el('button', { class: 'btn', text: 'Return to service', onclick: () => alarmAction('/api/alarms/out-of-service', { key: a.key, restore: true }) }));
  }

  const held = a.shelveReason ?? a.outOfServiceReason;
  return el('div', { class: `card alarm p-${a.priority}` },
    el('div', { class: 'a-head' },
      el('span', { text: a.name }),
      el('span', { class: `pill ${a.priority === 'critical' || a.priority === 'high' ? 'down' : a.priority === 'medium' ? 'degraded' : 'unknown'}`, text: PRIORITY_LABEL[a.priority] ?? a.priority })),
    el('div', { class: 'a-meta', text: [a.subject, a.group].filter(Boolean).join(' · ') || 'System' }),
    el('div', { class: 'a-meta', text: `${ALARM_STATE_LABEL[a.state] ?? a.state}${a.raisedAt ? ` · since ${fmtTime(a.raisedAt)}` : ''}${a.occurrences > 1 ? ` · ${a.occurrences} occurrences` : ''}` }),
    a.detail ? el('div', { class: 'a-meta', text: a.detail }) : null,
    a.chattering ? el('div', { class: 'a-meta', style: 'color:var(--degraded)', text: '🔁 chattering — unstable condition' }) : null,
    held ? el('div', { class: 'a-meta', text: `🔇 ${held}${a.shelvedUntil ? ` (until ${fmtTime(a.shelvedUntil)})` : ''}` }) : null,
    a.correctiveAction ? el('div', { class: 'a-action' }, el('b', { text: `Action — respond within ${a.timeToRespond ?? 'n/a'}` }), a.correctiveAction) : null,
    a.consequence ? el('div', { class: 'a-action' }, el('b', { text: 'If ignored' }), a.consequence) : null,
    actions.length ? el('div', { class: 'a-btns' }, ...actions) : null,
  );
}

async function alarmAction(path, body) {
  try {
    await api(path, { method: 'POST', body: JSON.stringify(body) });
    toast('Done');
    await loadAlarms();
  } catch (err) { toast(`❌ ${err.message}`, 6000); }
}

function updateAlarmBadge(n) {
  const badge = $('alarm-badge');
  badge.hidden = !n;
  badge.textContent = n;
}

/* --------------------------------------------------------------- reports --- */

async function loadReports() {
  const data = await api('/api/reports?limit=60');
  $('report-next').textContent = data.next?.dueAt
    ? `Next scheduled report: ${fmtTime(data.next.dueAt)}`
    : 'Scheduled reporting is off.';
  $('report-rows').replaceChildren(...(data.reports.length
    ? data.reports.map((r) => el('tr', {},
        el('td', {}, el('code', { text: r.reportId })),
        el('td', { text: r.at ? fmtTime(r.at) : r.day }),
        el('td', { text: r.formats.join(', ') }),
        el('td', {}, ...['html', 'text', 'csv', 'json']
          .filter((f) => r.formats.some((x) => x.startsWith(f === 'text' ? 'txt' : f)))
          .map((f) => el('button', { class: 'btn ghost', text: f, onclick: () => openStoredReport(r.reportId, f) })))))
    : [el('tr', {}, el('td', { colspan: '4', text: 'No reports issued yet.' }))]));
}

async function openStoredReport(id, format) {
  try {
    const r = await api(`/api/reports/read?id=${encodeURIComponent(id)}&format=${format}`);
    if (format === 'html') {
      const w = window.open('', '_blank');
      if (w) { w.document.write(r.body); w.document.close(); return; }
    }
    const out = $('report-preview');
    out.textContent = r.body;
    out.hidden = false;
    out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) { toast(err.message); }
}

/* --------------------------------------------------------------- settings --- */

function setFormValues(form, config) {
  for (const input of form.elements) {
    if (!input.name) continue;
    const value = input.name.split('.').reduce((o, k) => o?.[k], config);
    if (value === undefined) continue;
    if (input.type === 'checkbox') input.checked = !!value;
    else if (Array.isArray(value)) input.value = value.join(', ');
    else input.value = value;
  }
}

function readFormPatch(form) {
  const patch = {};
  for (const input of form.elements) {
    if (!input.name) continue;
    let value = input.type === 'checkbox' ? input.checked
      : input.type === 'number' ? Number(input.value)
      : input.value;
    if (input.name === 'alerts.digest.times') {
      value = String(value).split(',').map((s) => s.trim()).filter(Boolean);
    }
    const keys = input.name.split('.');
    let node = patch;
    for (const k of keys.slice(0, -1)) node = node[k] ??= {};
    node[keys.at(-1)] = value;
  }
  return patch;
}

async function loadSettings() {
  const { config, secrets } = await api('/api/config');
  setFormValues($('form-monitor'), config);
  setFormValues($('form-alerts'), config);
  $('secret-list').textContent = secrets.length ? secrets.join(', ') : 'none yet';
}

/* ------------------------------------------------------------------ live --- */

function applyStatus(s) {
  STATE.status = s;
  STATE.cameras = s.cameras ?? STATE.cameras;

  $('stale-banner').hidden = !s.stale;
  if (s.stale) {
    $('stale-detail').textContent = s.cycle?.lastFinishedAt
      ? `No successful probe cycle for ${fmtDuration(s.staleMs)} — the status below is out of date and must not be trusted.`
      : 'No probe cycle has completed yet.';
  }
  $('network-banner').hidden = s.network?.healthy !== false;

  $('site-sub').textContent = s.cycle?.lastFinishedAt
    ? `${s.fleet.total} cameras · last probe ${fmtClock(s.cycle.lastFinishedAt)} · ${s.cycle.lastDurationMs} ms`
    : 'waiting for the first probe cycle…';

  renderOverview();
  if (!$('view-cameras').hidden) renderCameras();
}

function connect() {
  const source = new EventSource('/events');
  source.addEventListener('open', () => { $('live-dot').className = 'dot on'; $('live-text').textContent = 'live'; });
  source.addEventListener('error', () => { $('live-dot').className = 'dot off'; $('live-text').textContent = 'reconnecting…'; });
  source.addEventListener('status', (e) => applyStatus(JSON.parse(e.data)));
  source.addEventListener('alarms', (e) => {
    const d = JSON.parse(e.data);
    updateAlarmBadge(d.counts?.annunciated ?? 0);
    if (!$('view-alarms').hidden) loadAlarms().catch(() => {});
  });
  source.addEventListener('report', (e) => {
    const d = JSON.parse(e.data);
    toast(`📋 Report ${d.reportId} issued`, 5000);
    if (!$('view-reports').hidden) loadReports().catch(() => {});
  });
  source.addEventListener('alert', (e) => {
    const a = JSON.parse(e.data);
    toast(a.title, 6000);
    if (STATE.notify && Notification.permission === 'granted') {
      const n = new Notification(a.title, { body: a.text.split('\n').slice(1, 5).join('\n'), requireInteraction: a.severity === 'critical', tag: a.type });
      n.onclick = () => window.focus();
    }
  });
}

/* ---------------------------------------------------------------- wiring --- */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    const view = tab.dataset.view;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
    if (view === 'cameras') renderCameras();
    if (view === 'alarms') loadAlarms().catch((e) => toast(e.message));
    if (view === 'reports') loadReports().catch((e) => toast(e.message));
    if (view === 'timeline') loadTimeline().catch((e) => toast(e.message));
    if (view === 'uptime') loadUptime().catch((e) => toast(e.message));
    if (view === 'alerts') loadAlerts().catch((e) => toast(e.message));
    if (view === 'settings') loadSettings().catch((e) => toast(e.message));
  });
});

for (const id of ['search', 'filter-status', 'filter-group', 'sort']) {
  $(id).addEventListener('input', renderCameras);
}
$('timeline-range').addEventListener('change', loadTimeline);
$('timeline-type').addEventListener('change', loadTimeline);
$('uptime-range').addEventListener('change', loadUptime);

$('btn-refresh').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Probing…';
  try { await api('/api/refresh', { method: 'POST' }); toast('Probe cycle complete'); }
  catch (err) { toast(`Probe failed: ${err.message}`); }
  finally { e.target.disabled = false; e.target.textContent = '↻ Probe now'; }
});

$('btn-notify').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('This browser has no notification support');
  const perm = await Notification.requestPermission();
  STATE.notify = perm === 'granted';
  toast(STATE.notify ? '🔔 Browser notifications enabled' : 'Notifications were not allowed');
});

async function openReport() {
  const fmt = $('report-format').value;
  const { text } = await api(`/api/report?format=${fmt}`);
  $('report-text').textContent = text;
  if (!$('report-dialog').open) $('report-dialog').showModal();
}
$('btn-report').addEventListener('click', () => openReport().catch((e) => toast(e.message)));
$('report-format').addEventListener('change', () => openReport().catch((e) => toast(e.message)));
$('btn-close-report').addEventListener('click', () => $('report-dialog').close());
$('btn-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('report-text').textContent); toast('Copied — paste into WhatsApp'); }
  catch { toast('Copy blocked by the browser; select the text and copy manually'); }
});
$('btn-send-digest').addEventListener('click', async () => {
  try { await api('/api/digest', { method: 'POST' }); toast('Digest sent to all enabled channels'); }
  catch (err) { toast(err.message); }
});

$('alarm-scope').addEventListener('change', () => loadAlarms().catch((e) => toast(e.message)));
$('btn-ack-all').addEventListener('click', async () => {
  if (!window.confirm('Acknowledge every alarm currently needing attention?')) return;
  const note = window.prompt('Optional note for the record:') ?? null;
  await alarmAction('/api/alarms/ack', { all: true, note });
});

$('btn-preview-report').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    const format = $('report-preview-format').value;
    const hours = $('report-preview-hours').value;
    const r = await api(`/api/reports/preview?format=${format}&hours=${hours}`);
    if (format === 'html') {
      const w = window.open('', '_blank');
      if (w) { w.document.write(r.body); w.document.close(); }
      else toast('Allow pop-ups to preview the HTML report');
    } else {
      const out = $('report-preview');
      out.textContent = r.body;
      out.hidden = false;
    }
  } catch (err) { toast(err.message, 6000); }
  finally { e.target.disabled = false; }
});

$('btn-issue-report').addEventListener('click', async (e) => {
  if (!window.confirm('Issue a report now and send it to every configured alert channel?')) return;
  e.target.disabled = true;
  e.target.textContent = 'Sending…';
  try {
    const r = await api('/api/reports/send', { method: 'POST', body: JSON.stringify({ label: 'Manual report' }) });
    toast(`${r.reportId} issued — ${r.devices} devices, ${r.sent ? `sent in ${r.parts} part(s)` : 'not sent'}`, 6000);
    await loadReports();
  } catch (err) { toast(err.message, 6000); }
  finally { e.target.disabled = false; e.target.textContent = 'Issue & send now'; }
});

$('btn-csv').addEventListener('click', () => {
  const head = ['Camera', 'Zone', 'IP', 'Status', 'For', 'Latency(ms)', 'Detail'];
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = STATE.cameras.map((c) => [c.name, c.group, c.host, c.status, fmtDuration(c.status === 'up' ? Date.now() - c.since : c.downtimeMs), c.latencyMs ?? '', c.detail ?? '']);
  const csv = [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: `camera-status_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function bindForm(id, handler, successMessage) {
  $(id).addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.target.querySelector('button[type=submit], button:last-of-type');
    if (button) button.disabled = true;
    try {
      const out = await handler(e.target);
      toast(successMessage);
      if (out) showOutput(JSON.stringify(out, null, 2));
    } catch (err) { toast(`❌ ${err.message}`, 6000); }
    finally { if (button) button.disabled = false; }
  });
}

bindForm('form-monitor', (form) => api('/api/config', { method: 'PUT', body: JSON.stringify(readFormPatch(form)) }).then(() => null), 'Monitoring settings saved');
bindForm('form-alerts', (form) => api('/api/config', { method: 'PUT', body: JSON.stringify(readFormPatch(form)) }).then(() => null), 'Alerting settings saved');
bindForm('form-secret', async (form) => {
  const path = form.elements.path.value.trim();
  const value = form.elements.value.value;
  await api('/api/secret', { method: 'POST', body: JSON.stringify({ path, value }) });
  form.elements.value.value = '';
  await loadSettings();
  return null;
}, 'Credential saved to the encrypted vault');
bindForm('form-import', (form) => api('/api/inventory/import', { method: 'POST', body: JSON.stringify({ file: form.elements.file.value.trim() }) }), 'Inventory imported');
bindForm('form-discover', (form) => api('/api/inventory/discover', { method: 'POST', body: JSON.stringify({ cidr: form.elements.cidr.value.trim() }) }), 'Subnet scan complete');

/* Keep relative times honest without waiting for the next SSE frame. */
setInterval(() => {
  if (!$('view-cameras').hidden) renderCameras();
  if (!$('view-overview').hidden) renderOverview();
  if (!$('view-alarms').hidden) loadAlarms().catch(() => {});
}, 15_000);

(async function init() {
  try {
    STATE.site = await api('/api/site');
    $('site-name').textContent = STATE.site.site.name;
    document.title = `${STATE.site.site.name} — Corridor Vision`;
  } catch { /* the SSE stream will fill this in */ }
  try { applyStatus(await api('/api/status')); } catch (err) { toast(err.message); }
  STATE.notify = 'Notification' in window && Notification.permission === 'granted';
  try { updateAlarmBadge((await api('/api/alarms')).counts.annunciated); } catch { /* shown on the tab instead */ }
  connect();
})();
