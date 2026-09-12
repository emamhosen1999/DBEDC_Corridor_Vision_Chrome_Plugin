import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCycle, summariseFleet, detectMassOutage, TRANSITION } from '../src/monitor/detector.mjs';
import { deepMerge, DEFAULTS } from '../src/core/config.mjs';

const cfg = (patch = {}) => deepMerge(DEFAULTS, patch);
const MIN = 60_000;

/** Feed a sequence of statuses through the detector, one cycle at a time. */
function run(statuses, { config = cfg(), startAt = 1_000_000, stepMs = 60_000, networkHealthy = true } = {}) {
  let states = {};
  const all = [];
  statuses.forEach((status, i) => {
    const now = startAt + i * stepMs;
    const result = {
      cameraId: 'cam1', name: 'Gate-01', host: '10.0.0.1', group: 'Zone 1',
      at: now, status, reason: status === 'down' ? 'no-response' : null, detail: null, warnings: [], layers: {},
    };
    const out = evaluateCycle({ prevStates: states, results: [result], cfg: config, now, networkHealthy });
    states = out.states;
    all.push(...out.transitions.map((t) => ({ ...t, cycle: i })));
  });
  return { states, transitions: all };
}

test('a single bad sample does not raise an alert (flap guard)', () => {
  const { transitions } = run(['up', 'up', 'down', 'up', 'up']);
  const noise = transitions.filter((t) => t.type === TRANSITION.DOWN || t.type === TRANSITION.UP);
  assert.equal(noise.length, 0, 'one-cycle blip must be swallowed by confirmation');
});

test('two consecutive bad samples do raise an alert', () => {
  const { transitions } = run(['up', 'up', 'down', 'down', 'up', 'up']);
  const down = transitions.filter((t) => t.type === TRANSITION.DOWN);
  const up = transitions.filter((t) => t.type === TRANSITION.UP);
  assert.equal(down.length, 1);
  assert.equal(up.length, 1);
  assert.ok(up[0].downtimeMs > 0, 'recovery must carry the outage duration');
});

test('confirmDownCycles is honoured', () => {
  const slow = cfg({ detect: { confirmDownCycles: 3 } });
  assert.equal(run(['up', 'down', 'down', 'up'], { config: slow }).transitions.filter((t) => t.type === TRANSITION.DOWN).length, 0);
  assert.equal(run(['up', 'down', 'down', 'down'], { config: slow }).transitions.filter((t) => t.type === TRANSITION.DOWN).length, 1);
});

test('unknown never changes a verdict and never alerts', () => {
  const { states, transitions } = run(['up', 'up', 'unknown', 'unknown', 'unknown', 'up']);
  assert.equal(states.cam1.status, 'up');
  assert.equal(transitions.filter((t) => t.type === TRANSITION.DOWN).length, 0);
});

test('a broken monitoring uplink does not mark cameras down', () => {
  const { states, transitions } = run(['up', 'down', 'down', 'down'], { networkHealthy: false });
  assert.equal(transitions.filter((t) => t.type === TRANSITION.DOWN).length, 0);
  assert.match(states.cam1.lastDetail, /network path is down/);
});

test('a camera that is already down when first seen is still reported', () => {
  const { transitions } = run(['down']);
  assert.ok(transitions.some((t) => t.type === TRANSITION.ADDED));
  assert.ok(transitions.some((t) => t.type === TRANSITION.DOWN && t.firstSeen));
});

test('flapping raises one alert, then goes quiet', () => {
  const config = cfg({ detect: { confirmDownCycles: 1, confirmUpCycles: 1, flapCount: 4, flapWindowMin: 30 } });
  const { transitions, states } = run(
    ['up', 'down', 'up', 'down', 'up', 'down', 'up', 'down', 'up', 'down'],
    { config },
  );
  const flap = transitions.filter((t) => t.type === TRANSITION.FLAPPING);
  assert.equal(flap.length, 1, 'exactly one flapping alert');
  assert.ok(states.cam1.flapping);
  const perChange = transitions.filter((t) => t.type === TRANSITION.DOWN || t.type === TRANSITION.UP);
  assert.ok(perChange.length <= 4, `individual alerts must be suppressed after flapping starts, got ${perChange.length}`);
});

test('escalation fires once per threshold, not every cycle', () => {
  const config = cfg({
    detect: { confirmDownCycles: 1 },
    alerts: { escalation: [{ afterMin: 60, severity: 'critical', label: 'Down 1 hour' }] },
  });
  const { transitions } = run(Array(90).fill('down'), { config });
  const esc = transitions.filter((t) => t.type === TRANSITION.ESCALATION);
  assert.equal(esc.length, 1, 'one escalation alert, not 30');
  assert.equal(esc[0].label, 'Down 1 hour');
  assert.ok(esc[0].downtimeMs >= 60 * MIN);
});

test('recovery clears escalation so the next outage escalates again', () => {
  const config = cfg({ detect: { confirmDownCycles: 1, confirmUpCycles: 1 }, alerts: { escalation: [{ afterMin: 60, severity: 'critical' }] } });
  const seq = [...Array(70).fill('down'), 'up', ...Array(70).fill('down')];
  const esc = run(seq, { config }).transitions.filter((t) => t.type === TRANSITION.ESCALATION);
  assert.equal(esc.length, 2);
});

test('degraded is distinct from down and reports its own recovery', () => {
  const config = cfg({ detect: { confirmDownCycles: 1, confirmUpCycles: 1 } });
  const { transitions } = run(['up', 'degraded', 'up'], { config });
  assert.equal(transitions.filter((t) => t.type === TRANSITION.DEGRADED).length, 1);
  assert.equal(transitions.filter((t) => t.type === TRANSITION.RECOVERED_DEGRADED).length, 1);
  assert.equal(transitions.filter((t) => t.type === TRANSITION.DOWN).length, 0);
});

test('treatDegradedAsDown collapses the two', () => {
  const config = cfg({ detect: { confirmDownCycles: 1, treatDegradedAsDown: true } });
  const { transitions } = run(['up', 'degraded'], { config });
  assert.equal(transitions.filter((t) => t.type === TRANSITION.DOWN).length, 1);
});

test('cameras with duplicate names keep separate histories (audit finding B2)', () => {
  const now = 1_000_000;
  const mk = (id, status) => ({ cameraId: id, name: 'Gate-01', host: id, group: 'Zone 1', at: now, status, warnings: [], layers: {} });
  const config = cfg({ detect: { confirmDownCycles: 1 } });
  let out = evaluateCycle({ prevStates: {}, results: [mk('a', 'up'), mk('b', 'up')], cfg: config, now });
  out = evaluateCycle({ prevStates: out.states, results: [mk('a', 'down'), mk('b', 'up')], cfg: config, now: now + MIN });
  const down = out.transitions.filter((t) => t.type === TRANSITION.DOWN);
  assert.equal(down.length, 1);
  assert.equal(down[0].cameraId, 'a', 'the healthy namesake must not cancel the outage');
  assert.equal(out.states.a.status, 'down');
  assert.equal(out.states.b.status, 'up');
});

test('a camera removed from inventory emits inventory.removed', () => {
  const config = cfg({ detect: { confirmDownCycles: 1 } });
  const now = 1_000_000;
  const r = (id) => ({ cameraId: id, name: id, host: id, group: 'Z', at: now, status: 'up', warnings: [], layers: {} });
  let out = evaluateCycle({ prevStates: {}, results: [r('a'), r('b')], cfg: config, now });
  out = evaluateCycle({ prevStates: out.states, results: [r('a')], cfg: config, now: now + MIN });
  assert.ok(out.transitions.some((t) => t.type === TRANSITION.REMOVED && t.cameraId === 'b'));
  assert.equal(Object.keys(out.states).length, 1);
});

test('fleet summary counts groups correctly', () => {
  const fleet = summariseFleet({
    a: { status: 'up', group: 'Z1' }, b: { status: 'down', group: 'Z1' },
    c: { status: 'degraded', group: 'Z2' }, d: { status: 'unknown', group: 'Z2' },
    e: { status: 'up', group: 'Z2', flapping: true },
  });
  assert.deepEqual(
    { total: fleet.total, up: fleet.up, down: fleet.down, degraded: fleet.degraded, unknown: fleet.unknown, flapping: fleet.flapping },
    { total: 5, up: 2, down: 1, degraded: 1, unknown: 1, flapping: 1 },
  );
  assert.equal(fleet.healthyPct, 40);
  assert.equal(fleet.groups.length, 2);
});

test('a whole group going dark raises one group alert, not N camera alerts', () => {
  const fleet = summariseFleet(Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`c${i}`, { status: 'down', group: 'Zone 3' }]),
  ));
  const { alerts, flags } = detectMassOutage(fleet, cfg(), {});
  assert.ok(alerts.some((a) => a.type === 'site.groupDown' && a.group === 'Zone 3'));
  assert.ok(alerts.some((a) => a.type === 'site.massOutage'));
  // Second evaluation with the same flags must stay silent.
  assert.equal(detectMassOutage(fleet, cfg(), flags).alerts.length, 0);
});

test('mass outage clearing is announced', () => {
  const healthy = summariseFleet(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`c${i}`, { status: 'up', group: 'Z' }])));
  const { alerts } = detectMassOutage(healthy, cfg(), { fleet: true, 'group:Z': true });
  assert.ok(alerts.some((a) => a.type === 'site.massOutageCleared'));
  assert.ok(alerts.some((a) => a.type === 'site.groupRecovered'));
});
