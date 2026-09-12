import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-alarm-'));
process.env.CORRIDOR_HOME = HOME;

const { AlarmRegister, STATE, instanceKey, effectivePriority } = await import('../src/alarms/register.mjs');
const { CATALOG, TAGS, getAlarmDef, priorityDistribution, PRIORITY } = await import('../src/alarms/catalog.mjs');
const { alarmKpis, EEMUA_TARGETS } = await import('../src/alarms/kpi.mjs');
const { deepMerge, DEFAULTS } = await import('../src/core/config.mjs');

const cfg = (patch = {}) => deepMerge(DEFAULTS, patch);
const CAM = { id: 'cam1', name: 'Gate-01', group: 'Zone 1' };

function reg(patch = {}) {
  const sent = [];
  const register = new AlarmRegister({ cfg: cfg(patch), notify: (a) => sent.push(a) });
  return { register, sent, key: (tag, id = CAM.id) => instanceKey(tag, id) };
}

/* ---------------------------------------------------------- catalogue --- */

test('every catalogue entry is fully rationalised', () => {
  for (const tag of TAGS) {
    const d = CATALOG[tag];
    assert.equal(d.tag, tag, `${tag}: tag field must match its key`);
    for (const field of ['name', 'class', 'scope', 'priority', 'cause', 'consequence', 'correctiveAction', 'timeToRespond']) {
      assert.ok(d[field], `${tag} is missing "${field}" — an alarm that cannot state its ${field} should not exist`);
    }
    assert.ok(['device', 'group', 'system'].includes(d.scope), `${tag}: bad scope ${d.scope}`);
    assert.ok(Object.values(PRIORITY).includes(d.priority), `${tag}: bad priority`);
    // Diagnostic alarms legitimately have no action; everything annunciated must not.
    if (d.priority !== PRIORITY.DIAGNOSTIC) {
      assert.ok(d.correctiveAction.length > 30, `${tag}: corrective action must be actionable, not a stub`);
      assert.ok(d.consequence.length > 30, `${tag}: consequence must explain what is actually lost`);
    }
  }
});

test('the alarms that report monitoring failure cannot be silenced', () => {
  for (const tag of ['SYS_MONITOR_STALLED', 'SYS_CHANNEL_FAIL']) {
    assert.equal(CATALOG[tag].shelvable, false, `${tag} must not be shelvable`);
  }
  assert.equal(CATALOG.SYS_MONITOR_STALLED.suppressible, false);
});

test('catalogue composition is reported without a bogus pass/fail', () => {
  const d = priorityDistribution();
  assert.ok(d.total > 25);
  assert.ok(d.note.includes('traffic'), 'must state that the ISA target applies to traffic, not the catalogue');
  assert.equal(Math.round(d.percentages.low + d.percentages.medium + d.percentages.high + d.percentages.critical), 100);
});

test('unknown tags fail loudly', () => {
  assert.throws(() => getAlarmDef('NOPE'), /Unknown alarm tag/);
});

/* ------------------------------------------------------- state machine --- */

test('a condition raises an unacknowledged alarm', () => {
  const { register, sent, key } = reg();
  register.assert('CAM_COMM_LOSS', true, CAM, { detail: 'no response' });
  const inst = register.get('CAM_COMM_LOSS', CAM.id);
  assert.equal(inst.state, STATE.UNACK_ALARM);
  assert.equal(inst.occurrences, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'alarm.raised');
  assert.equal(sent[0].priority, 'medium');
  assert.equal(key('CAM_COMM_LOSS'), 'CAM_COMM_LOSS:cam1');
});

test('a persisting condition does not re-annunciate', () => {
  const { register, sent } = reg();
  for (let i = 0; i < 5; i++) register.assert('CAM_COMM_LOSS', true, CAM);
  assert.equal(sent.filter((s) => s.type === 'alarm.raised').length, 1, 'one alarm, not five');
  assert.equal(register.get('CAM_COMM_LOSS', CAM.id).occurrences, 1);
});

test('an alarm that clears before acknowledgement goes to RTN-UNACK, not away', () => {
  // The point of the standard: a short outage at 3am must still be seen in the morning.
  const { register } = reg();
  register.assert('CAM_COMM_LOSS', true, CAM);
  register.assert('CAM_COMM_LOSS', false, CAM);
  const inst = register.get('CAM_COMM_LOSS', CAM.id);
  assert.equal(inst.state, STATE.RTN_UNACK);
  assert.ok(inst.clearedAt);
  assert.equal(register.annunciated().length, 1, 'it must still be on the annunciator');
});

test('acknowledging a returned alarm finishes it', () => {
  const { register, key } = reg();
  register.assert('CAM_COMM_LOSS', true, CAM);
  register.assert('CAM_COMM_LOSS', false, CAM);
  register.acknowledge(key('CAM_COMM_LOSS'), { by: 'shift-a' });
  const inst = register.get('CAM_COMM_LOSS', CAM.id);
  assert.equal(inst.state, STATE.NORMAL);
  assert.equal(inst.ackedBy, 'shift-a');
  assert.equal(register.annunciated().length, 0);
});

test('acknowledging an active alarm leaves it active until the condition clears', () => {
  const { register, key } = reg();
  register.assert('CAM_COMM_LOSS', true, CAM);
  register.acknowledge(key('CAM_COMM_LOSS'), { by: 'shift-a' });
  assert.equal(register.get('CAM_COMM_LOSS', CAM.id).state, STATE.ACK_ALARM);
  register.assert('CAM_COMM_LOSS', false, CAM);
  assert.equal(register.get('CAM_COMM_LOSS', CAM.id).state, STATE.NORMAL);
});

test('a re-occurrence while unacknowledged counts as a new occurrence', () => {
  const { register } = reg();
  register.assert('CAM_COMM_LOSS', true, CAM);
  register.assert('CAM_COMM_LOSS', false, CAM);   // RTN_UNACK
  register.assert('CAM_COMM_LOSS', true, CAM);    // back again, still unacked
  const inst = register.get('CAM_COMM_LOSS', CAM.id);
  assert.equal(inst.state, STATE.UNACK_ALARM);
  assert.equal(inst.occurrences, 2);
});

test('acknowledging something that needs no acknowledgement is a no-op', () => {
  const { register, key } = reg();
  register.assert('CAM_COMM_LOSS', true, CAM);
  register.acknowledge(key('CAM_COMM_LOSS'));
  assert.equal(register.acknowledge(key('CAM_COMM_LOSS')), null, 'double-ack must not throw or corrupt state');
});

test('acknowledgeAll clears the annunciator', () => {
  const { register } = reg();
  register.assert('CAM_COMM_LOSS', true, CAM);
  register.assert('VID_FROZEN', true, { id: 'cam2', name: 'Gate-02', group: 'Zone 1' });
  assert.equal(register.acknowledgeAll({ by: 'ops' }), 2);
  assert.equal(register.unacknowledged().length, 0);
});

/* -------------------------------------------------------------- holds --- */

test('shelving requires a reason and always expires', () => {
  const { register, key } = reg();
  register.assert('CAM_UNSTABLE', true, CAM);
  assert.equal(register.shelve(key('CAM_UNSTABLE'), { hours: 2 }).ok, false, 'a reason is mandatory');
  const r = register.shelve(key('CAM_UNSTABLE'), { hours: 2, reason: 'contractor on site', by: 'ops' });
  assert.equal(r.ok, true);
  const inst = register.get('CAM_UNSTABLE', CAM.id);
  assert.equal(inst.state, STATE.SHELVED);
  assert.ok(inst.shelvedUntil > Date.now());
  assert.equal(inst.shelveReason, 'contractor on site');
});

test('a shelf is capped so nothing can be silenced indefinitely', () => {
  const { register, key } = reg({ alarms: { maxShelveHours: 8 } });
  register.assert('CAM_UNSTABLE', true, CAM);
  const r = register.shelve(key('CAM_UNSTABLE'), { hours: 9999, reason: 'nuisance' });
  assert.equal(r.hours, 8, 'the shelf must be capped at the configured maximum');
});

test('a shelved alarm re-annunciates when the shelf expires with the condition present', () => {
  const { register, sent, key } = reg();
  const t0 = Date.now();
  register.assert('CAM_UNSTABLE', true, CAM, {}, t0);
  register.shelve(key('CAM_UNSTABLE'), { hours: 1, reason: 'works' }, t0);
  sent.length = 0;
  register.assert('CAM_UNSTABLE', true, CAM, {}, t0 + 30 * 60_000);
  assert.equal(sent.length, 0, 'silent while shelved');
  register.assert('CAM_UNSTABLE', true, CAM, {}, t0 + 2 * 3_600_000);
  assert.ok(sent.some((s) => s.type === 'alarm.raised'), 'must annunciate again after expiry');
  assert.equal(register.get('CAM_UNSTABLE', CAM.id).state, STATE.UNACK_ALARM);
});

test('the sweep raises a diagnostic alarm when a shelf expires', () => {
  const { register, key } = reg();
  const t0 = Date.now();
  register.assert('CAM_UNSTABLE', true, CAM, {}, t0);
  register.shelve(key('CAM_UNSTABLE'), { hours: 1, reason: 'cable works' }, t0);
  const derived = register.sweep(t0 + 2 * 3_600_000);
  const expired = derived.find((d) => d.tag === 'ALM_SHELF_EXPIRED');
  assert.ok(expired, 'an expiring shelf must be visible, not silent');
  assert.match(expired.detail, /cable works/);
});

test('the watchdog and channel-failure alarms refuse to be shelved', () => {
  const { register, key } = reg();
  register.assert('SYS_MONITOR_STALLED', true, {}, { detail: 'stalled' });
  const r = register.shelve(instanceKey('SYS_MONITOR_STALLED'), { hours: 4, reason: 'noisy' });
  assert.equal(r.ok, false);
  assert.match(r.error, /monitoring system itself/);
});

test('a maintenance window suppresses by design and releases afterwards', () => {
  const now = Date.parse('2026-09-20T23:00:00Z');
  const config = cfg({
    alerts: { maintenance: [{ name: 'Zone 1 works', from: '2026-09-20T22:00:00Z', to: '2026-09-21T04:00:00Z', groups: ['Zone 1'] }] },
  });
  const sent = [];
  const register = new AlarmRegister({ cfg: config, notify: (a) => sent.push(a) });
  register.assert('CAM_COMM_LOSS', true, CAM, {}, now);
  assert.equal(register.get('CAM_COMM_LOSS', CAM.id).state, STATE.SUPPRESSED);
  assert.equal(sent.length, 0, 'suppressed by design means recorded but not annunciated');

  const after = Date.parse('2026-09-21T05:00:00Z');
  register.assert('CAM_COMM_LOSS', true, CAM, {}, after);
  assert.equal(register.get('CAM_COMM_LOSS', CAM.id).state, STATE.UNACK_ALARM);
  assert.ok(sent.some((s) => s.type === 'alarm.raised'), 'must annunciate once the window closes');
});

test('a maintenance window can be narrowed to specific alarm tags', () => {
  const now = Date.parse('2026-09-20T23:00:00Z');
  const config = cfg({
    alerts: { maintenance: [{ name: 'reboots expected', from: '2026-09-20T22:00:00Z', to: '2026-09-21T04:00:00Z', tags: ['CAM_REBOOT'] }] },
  });
  const register = new AlarmRegister({ cfg: config, notify: () => {} });
  register.assert('CAM_COMM_LOSS', true, CAM, {}, now);
  assert.equal(register.get('CAM_COMM_LOSS', CAM.id).state, STATE.UNACK_ALARM, 'other tags are unaffected');
});

test('out of service holds an alarm until it is explicitly returned', () => {
  const { register, sent, key } = reg();
  register.assert('CAM_COMM_LOSS', true, CAM);
  register.outOfService(key('CAM_COMM_LOSS'), { reason: 'camera removed for road works', by: 'maint' });
  sent.length = 0;
  register.assert('CAM_COMM_LOSS', true, CAM);
  register.assert('CAM_COMM_LOSS', false, CAM);
  assert.equal(sent.length, 0, 'nothing is annunciated while out of service');
  register.returnToService(key('CAM_COMM_LOSS'));
  assert.equal(register.get('CAM_COMM_LOSS', CAM.id).state, STATE.NORMAL);
});

/* --------------------------------------------------------- latching --- */

test('a latching event alarm stays until acknowledged', () => {
  const { register, key } = reg();
  register.raiseEvent('CAM_REBOOT', CAM, { detail: 'uptime reset' });
  const inst = register.get('CAM_REBOOT', CAM.id);
  assert.equal(inst.state, STATE.UNACK_ALARM);
  register.assert('CAM_REBOOT', false, CAM);   // a "clear" is meaningless for an event
  assert.notEqual(register.get('CAM_REBOOT', CAM.id).state, STATE.NORMAL);
  register.acknowledge(key('CAM_REBOOT'));
  assert.equal(register.get('CAM_REBOOT', CAM.id).state, STATE.NORMAL);
});

/* ------------------------------------------------- chatter & standing --- */

test('chattering is detected and raises its own alarm once', () => {
  const { register } = reg({ alarms: { chatterWindowMin: 10, chatterCount: 6 } });
  const t0 = Date.now();
  for (let i = 0; i < 8; i++) {
    register.assert('CAM_COMM_LOSS', i % 2 === 0, CAM, {}, t0 + i * 30_000);
  }
  const derived = register.sweep(t0 + 8 * 30_000);
  const chatter = derived.filter((d) => d.tag === 'ALM_CHATTERING');
  assert.equal(chatter.length, 1);
  assert.equal(register.sweep(t0 + 8 * 30_000).filter((d) => d.tag === 'ALM_CHATTERING').length, 0, 'must not re-raise');
});

test('standing alarms are identified past the threshold', () => {
  const { register } = reg({ alarms: { standingAfterHours: 24 } });
  const t0 = Date.now();
  register.assert('CAM_COMM_LOSS', true, CAM, {}, t0);
  assert.equal(register.standing(t0 + 3_600_000).length, 0);
  assert.equal(register.standing(t0 + 25 * 3_600_000).length, 1);
  assert.ok(register.sweep(t0 + 25 * 3_600_000).some((d) => d.tag === 'ALM_STANDING'));
});

/* --------------------------------------------------------- escalation --- */

test('escalation raises the priority of the instance, not the catalogue entry', () => {
  const { register } = reg();
  register.assert('CAM_DOWN_SUSTAINED', true, CAM, { escalationPriority: 'critical', escalationLevel: 3 });
  const inst = register.get('CAM_DOWN_SUSTAINED', CAM.id);
  assert.equal(effectivePriority(inst), 'critical');
  assert.equal(CATALOG.CAM_DOWN_SUSTAINED.priority, 'high', 'the catalogue entry is unchanged');
});

/* -------------------------------------------------------- persistence --- */

test('the register round-trips through persistence', () => {
  const { register, key } = reg();
  register.assert('CAM_COMM_LOSS', true, CAM);
  register.acknowledge(key('CAM_COMM_LOSS'), { by: 'ops' });
  const restored = new AlarmRegister({ cfg: cfg(), notify: () => {} }).load(JSON.parse(JSON.stringify(register.toJSON())));
  const inst = restored.get('CAM_COMM_LOSS', CAM.id);
  assert.equal(inst.state, STATE.ACK_ALARM);
  assert.equal(inst.ackedBy, 'ops');
});

test('prune drops finished instances but keeps live ones', () => {
  const { register } = reg();
  const t0 = Date.now();
  register.assert('CAM_COMM_LOSS', true, CAM, {}, t0);
  register.assert('CAM_COMM_LOSS', false, CAM, {}, t0);
  register.acknowledge(instanceKey('CAM_COMM_LOSS', CAM.id), {}, t0);
  register.assert('VID_FROZEN', true, { id: 'cam2', name: 'B' }, {}, t0);
  assert.equal(register.prune(t0 + 8 * 86_400_000), 1);
  assert.ok(register.get('VID_FROZEN', 'cam2'), 'an active alarm must never be pruned');
});

/* --------------------------------------------------------------- KPIs --- */

test('KPIs measure alarm load against EEMUA targets', async () => {
  const { appendEvent } = await import('../src/core/store.mjs');
  // A window in the past, isolated from the events the state-machine tests above wrote.
  const now = Date.parse('2026-01-10T12:00:00Z');
  const since = now - 3_600_000;
  // 4 alarms in an hour: inside the acceptable rate of 6/hour.
  for (let i = 0; i < 4; i++) {
    await appendEvent({ type: 'alarm.raised', ts: since + i * 600_000, tag: 'CAM_COMM_LOSS', priority: 'medium', cameraId: `c${i}`, name: `Cam ${i}` });
  }
  const { register } = reg();
  const k = await alarmKpis({ sinceTs: since, untilTs: now, register });
  assert.equal(k.rate.total, 4);
  assert.ok(k.rate.perHour <= EEMUA_TARGETS.alarmsPerHourAcceptable);
  assert.equal(k.rate.verdict, 'acceptable');
  assert.equal(k.overall.status, 'acceptable');
  assert.equal(k.topContributors.items[0].tag, 'CAM_COMM_LOSS');
});

test('KPIs detect a flood and say the system is overloaded', async () => {
  const { appendEvent } = await import('../src/core/store.mjs');
  const now = Date.parse('2026-02-10T12:00:00Z');
  const since = now - 3_600_000;
  // 40 alarms inside one 10-minute bin: a textbook flood.
  for (let i = 0; i < 40; i++) {
    await appendEvent({ type: 'alarm.raised', ts: since + 60_000 + i * 1000, tag: 'CAM_COMM_LOSS', priority: 'medium', cameraId: `f${i}`, name: `Cam ${i}` });
  }
  const { register } = reg();
  const k = await alarmKpis({ sinceTs: since, untilTs: now, register });
  assert.ok(k.peak.value > EEMUA_TARGETS.peakPer10Min);
  assert.equal(k.peak.verdict, 'above target');
  assert.ok(k.flood.periods >= 1);
  assert.notEqual(k.overall.status, 'acceptable');
  assert.ok(k.overall.failures.some((f) => /flood|peak/.test(f)));
});
