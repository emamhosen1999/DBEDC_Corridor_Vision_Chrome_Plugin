/**
 * Transition detection — the correctness centre of the system.
 *
 * A pure function of (previous state, this cycle's probe results) → (next state,
 * transitions). No I/O, no clocks beyond the injected `now`, so every rule below is
 * directly testable — see tests/detector.test.mjs.
 *
 * Four rules, each of which exists because its absence broke the old extension:
 *
 * 1. CONFIRMATION. A state change is only real after `confirmDownCycles` consecutive
 *    observations. The old extension alerted on a single sample (finding B4), so one
 *    slow response paged the operator and the recovery paged them again. Operators
 *    respond by muting notifications, which is worse than having none.
 *
 * 2. UNKNOWN IS NOT DOWN. If our own network path is broken, or a probe could not
 *    reach a verdict, the camera keeps its previous state and the cycle is recorded
 *    as a gap. Declaring 500 outages because the monitoring PC lost its uplink
 *    destroys trust permanently, and it is the single most common way monitors fail.
 *
 * 3. FLAP SUPPRESSION. A camera that changes state more than `flapCount` times inside
 *    `flapWindowMin` is marked FLAPPING: it raises one "unstable" alert and then goes
 *    quiet until it settles. A flapping PoE uplink would otherwise generate hundreds
 *    of alerts a day on its own.
 *
 * 4. ESCALATION. Being told once that a camera is down is not enough — an outage that
 *    is still open after an hour is a different, larger problem than one a minute old,
 *    and it deserves to be said again, louder.
 */
import { STATUS } from '../probe/index.mjs';

export const TRANSITION = {
  DOWN: 'camera.down',
  UP: 'camera.up',
  DEGRADED: 'camera.degraded',
  RECOVERED_DEGRADED: 'camera.recovered',
  FLAPPING: 'camera.flapping',
  STABLE: 'camera.stable',
  ESCALATION: 'camera.escalation',
  ADDED: 'inventory.added',
  REMOVED: 'inventory.removed',
};

const BAD = new Set([STATUS.DOWN, STATUS.DEGRADED]);

function emptyCameraState(now) {
  return {
    status: null,          // confirmed status
    since: now,            // when the confirmed status began
    lastChange: 0,
    pending: null,         // status awaiting confirmation
    pendingCount: 0,
    flapHistory: [],       // timestamps of confirmed changes
    flapping: false,
    flappingUntil: 0,
    escalated: [],         // escalation thresholds already fired for the current outage
    unknownStreak: 0,
    lastGoodAt: 0,
    lastReason: null,
    lastDetail: null,
    warnings: [],
    snapshot: {},          // dHash/frozenCount carried between cycles
    stream: {},            // RTSP URL learned from the camera over ONVIF, cached here
    totals: { downCount: 0, downMs: 0 },
  };
}

/** How many consecutive observations are needed to confirm `next`. */
function confirmationsNeeded(next, cfg) {
  return next === STATUS.UP ? Math.max(1, cfg.detect.confirmUpCycles) : Math.max(1, cfg.detect.confirmDownCycles);
}

/** Collapse `degraded` into `down` when the operator has asked for that. */
function effectiveStatus(status, cfg) {
  if (status === STATUS.DEGRADED && cfg.detect.treatDegradedAsDown) return STATUS.DOWN;
  return status;
}

/**
 * Evaluate one cycle.
 *
 * @param prevStates      { [cameraId]: cameraState } from the last cycle
 * @param results         probe results for this cycle
 * @param cfg             validated config
 * @param now             epoch ms
 * @param networkHealthy  false when our own uplink is broken (freezes all judgements)
 */
export function evaluateCycle({ prevStates = {}, results = [], cfg, now = Date.now(), networkHealthy = true }) {
  const states = {};
  const transitions = [];
  const seen = new Set();

  const flapWindowMs = cfg.detect.flapWindowMin * 60_000;
  const flapCooldownMs = cfg.detect.flapCooldownMin * 60_000;

  for (const result of results) {
    const id = result.cameraId;
    seen.add(id);
    const prev = prevStates[id];
    const state = prev ? structuredClone(prev) : emptyCameraState(now);

    // Carry snapshot history forward so frozen-frame detection spans cycles.
    if (result.layers?.snapshot?.history) state.snapshot = result.layers.snapshot.history;
    // Carry the stream path the camera told us about, so ONVIF discovery runs once
    // rather than every cycle. An empty object clears a path that stopped working.
    if (result.layers?.rtsp?.discovered) state.stream = result.layers.rtsp.discovered;
    state.warnings = result.warnings ?? [];
    state.lastProbeAt = result.at;
    state.latencyMs = result.latencyMs ?? null;
    state.host = result.host;
    state.name = result.name;
    state.group = result.group;

    const observed = effectiveStatus(result.status, cfg);

    /* --- Rule 2: unknown never changes a verdict ---------------------------- */
    if (observed === STATUS.UNKNOWN || !networkHealthy) {
      state.unknownStreak += 1;
      state.pending = null;
      state.pendingCount = 0;
      state.lastReason = result.reason ?? 'unknown';
      state.lastDetail = networkHealthy ? result.detail : 'monitoring network path is down — camera state is unknown, not offline';
      states[id] = state;
      continue;
    }
    state.unknownStreak = 0;

    if (observed === STATUS.UP) state.lastGoodAt = now;

    /* --- First ever observation: adopt it without alerting ------------------ */
    if (state.status === null) {
      state.status = observed;
      state.since = now;
      state.lastChange = now;
      state.lastReason = result.reason ?? null;
      state.lastDetail = result.detail ?? null;
      if (!prev) {
        transitions.push({
          type: TRANSITION.ADDED, cameraId: id, name: result.name, group: result.group,
          host: result.host, status: observed, at: now,
        });
        // A camera that is already down when first seen still needs to be reported —
        // otherwise adding a broken camera to the inventory hides it forever.
        if (BAD.has(observed)) {
          transitions.push({
            type: observed === STATUS.DOWN ? TRANSITION.DOWN : TRANSITION.DEGRADED,
            cameraId: id, name: result.name, group: result.group, host: result.host,
            reason: result.reason, detail: result.detail, at: now, since: now, firstSeen: true,
          });
        }
      }
      states[id] = state;
      continue;
    }

    /* --- Rule 1: confirmation ---------------------------------------------- */
    if (observed === state.status) {
      state.pending = null;
      state.pendingCount = 0;
      state.lastReason = result.reason ?? null;
      state.lastDetail = result.detail ?? null;
      // Recovery from flapping: quiet for a full cooldown means it settled.
      if (state.flapping && now >= state.flappingUntil) {
        state.flapping = false;
        transitions.push({
          type: TRANSITION.STABLE, cameraId: id, name: result.name, group: result.group,
          host: result.host, status: state.status, at: now,
        });
      }
      states[id] = state;
      continue;
    }

    // Count consecutive observations of the SAME pending status; any other value
    // restarts the count, which is what makes a single bad sample harmless.
    state.pendingCount = prev?.pending === observed ? state.pendingCount + 1 : 1;
    state.pending = observed;

    if (state.pendingCount < confirmationsNeeded(observed, cfg)) {
      states[id] = state;   // not confirmed yet — stay silent, this is the flap guard
      continue;
    }

    /* --- Confirmed change --------------------------------------------------- */
    const from = state.status;
    const outageMs = BAD.has(from) ? now - state.since : 0;
    state.status = observed;
    state.since = now;
    state.lastChange = now;
    state.pending = null;
    state.pendingCount = 0;
    state.lastReason = result.reason ?? null;
    state.lastDetail = result.detail ?? null;
    state.escalated = [];
    if (BAD.has(from) && observed === STATUS.UP) {
      state.totals.downCount += 1;
      state.totals.downMs += outageMs;
    }

    /* --- Rule 3: flap suppression ------------------------------------------ */
    state.flapHistory = [...state.flapHistory, now].filter((t) => now - t <= flapWindowMs);
    const wasFlapping = state.flapping;
    if (state.flapHistory.length >= cfg.detect.flapCount) {
      state.flapping = true;
      state.flappingUntil = now + flapCooldownMs;
      if (!wasFlapping) {
        transitions.push({
          type: TRANSITION.FLAPPING, cameraId: id, name: result.name, group: result.group,
          host: result.host, changes: state.flapHistory.length,
          windowMin: cfg.detect.flapWindowMin, at: now,
          detail: `${state.flapHistory.length} state changes in ${cfg.detect.flapWindowMin} minutes — link or power is unstable`,
        });
      }
      states[id] = state;
      continue;   // suppressed: a flapping camera raises one alert, not forty
    }

    const base = {
      cameraId: id, name: result.name, group: result.group, host: result.host,
      at: now, from, to: observed, reason: result.reason, detail: result.detail,
    };
    if (observed === STATUS.DOWN) {
      transitions.push({ ...base, type: TRANSITION.DOWN, since: now });
    } else if (observed === STATUS.DEGRADED) {
      transitions.push({ ...base, type: TRANSITION.DEGRADED, since: now, warnings: result.warnings });
    } else if (BAD.has(from)) {
      transitions.push({
        ...base,
        type: from === STATUS.DEGRADED ? TRANSITION.RECOVERED_DEGRADED : TRANSITION.UP,
        downtimeMs: outageMs,
      });
    }
    states[id] = state;
  }

  /* --- Cameras that disappeared from the inventory -------------------------- */
  for (const [id, prev] of Object.entries(prevStates)) {
    if (seen.has(id)) continue;
    transitions.push({
      type: TRANSITION.REMOVED, cameraId: id, name: prev.name, group: prev.group, host: prev.host, at: now,
    });
    // Intentionally dropped from `states` — it is no longer monitored.
  }

  /* --- Rule 4: escalation of still-open outages ----------------------------- */
  for (const [id, state] of Object.entries(states)) {
    if (!BAD.has(state.status) || state.flapping) continue;
    const downMs = now - state.since;
    for (const rule of cfg.alerts.escalation ?? []) {
      const key = String(rule.afterMin);
      if (state.escalated.includes(key)) continue;
      if (downMs < rule.afterMin * 60_000) continue;
      state.escalated.push(key);
      transitions.push({
        type: TRANSITION.ESCALATION, cameraId: id, name: state.name, group: state.group, host: state.host,
        at: now, since: state.since, downtimeMs: downMs, status: state.status,
        severity: rule.severity, label: rule.label ?? `Down ${rule.afterMin} minutes`,
        reason: state.lastReason, detail: state.lastDetail,
      });
    }
  }

  return { states, transitions, fleet: summariseFleet(states) };
}

/** Roll per-camera state into fleet and per-group counts. */
export function summariseFleet(states) {
  const fleet = { total: 0, up: 0, down: 0, degraded: 0, unknown: 0, flapping: 0 };
  const groups = new Map();

  for (const state of Object.values(states)) {
    fleet.total++;
    const bucket = state.status ?? STATUS.UNKNOWN;
    if (bucket === STATUS.UP) fleet.up++;
    else if (bucket === STATUS.DOWN) fleet.down++;
    else if (bucket === STATUS.DEGRADED) fleet.degraded++;
    else fleet.unknown++;
    if (state.flapping) fleet.flapping++;

    const name = state.group ?? 'Ungrouped';
    const g = groups.get(name) ?? { name, total: 0, up: 0, down: 0, degraded: 0, unknown: 0 };
    g.total++;
    if (bucket === STATUS.UP) g.up++;
    else if (bucket === STATUS.DOWN) g.down++;
    else if (bucket === STATUS.DEGRADED) g.degraded++;
    else g.unknown++;
    groups.set(name, g);
  }

  fleet.healthyPct = fleet.total ? Math.round((fleet.up / fleet.total) * 1000) / 10 : 100;
  return { ...fleet, groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/**
 * Detect outages big enough to have one cause.
 *
 * "Zone 3 is entirely dark" is one actionable sentence. Sixty separate "camera N is
 * offline" messages is noise that buries it — that was finding M8.
 */
export function detectMassOutage(fleet, cfg, prevFlags = {}) {
  const out = { alerts: [], flags: {} };
  const mo = cfg.alerts.massOutage;
  if (!mo?.enabled) return out;

  for (const g of fleet.groups) {
    const bad = g.down + g.degraded;
    const wiped = mo.groupWipeout && g.total >= Math.min(mo.minCameras, g.total) && bad === g.total && g.total > 1;
    const key = `group:${g.name}`;
    if (wiped) {
      out.flags[key] = true;
      if (!prevFlags[key]) {
        out.alerts.push({
          type: 'site.groupDown', group: g.name, total: g.total, down: g.down, degraded: g.degraded,
          detail: `Every camera in ${g.name} (${g.total}) is unreachable — this points at one cause: switch, uplink or power, not ${g.total} separate camera faults`,
        });
      }
    }
  }

  const bad = fleet.down + fleet.degraded;
  const pct = fleet.total ? (bad / fleet.total) * 100 : 0;
  const massive = fleet.total >= mo.minCameras && pct >= mo.fleetPctThreshold;
  if (massive) {
    out.flags['fleet'] = true;
    if (!prevFlags.fleet) {
      out.alerts.push({
        type: 'site.massOutage', total: fleet.total, down: fleet.down, degraded: fleet.degraded,
        pct: Math.round(pct * 10) / 10,
        detail: `${bad} of ${fleet.total} cameras (${Math.round(pct)}%) are not serving video — treat this as a site-level fault, not individual cameras`,
      });
    }
  } else if (prevFlags.fleet) {
    out.alerts.push({ type: 'site.massOutageCleared', total: fleet.total, down: fleet.down, degraded: fleet.degraded });
  }

  for (const [key, was] of Object.entries(prevFlags)) {
    if (was && key.startsWith('group:') && !out.flags[key]) {
      out.alerts.push({ type: 'site.groupRecovered', group: key.slice(6) });
    }
  }
  return out;
}

export { emptyCameraState };
