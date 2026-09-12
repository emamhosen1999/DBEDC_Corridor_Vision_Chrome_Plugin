/**
 * Probe result → alarm conditions.
 *
 * The single place that decides which catalogue alarms a camera's state implies. It is
 * a pure function so the mapping is testable in isolation: given this probe result and
 * this history, exactly these conditions are true.
 *
 * Two rules it follows throughout:
 *
 *  - **Assert absence, not just presence.** Every condition the mapper knows about is
 *    returned with `present: true` or `present: false`, never omitted. An omitted
 *    condition would leave its alarm stuck active forever after it recovered, which is
 *    how alarm registers fill up with ghosts.
 *
 *  - **UNKNOWN asserts nothing.** If the probe could not reach a verdict — our own
 *    network is broken, the cycle timed out — the mapper returns no assertions at all,
 *    so every alarm holds its previous state. Manufacturing "camera down" from "we
 *    could not look" is the failure mode this whole system exists to avoid.
 */
import { STATUS } from '../probe/index.mjs';

/** Findings that map one-to-one onto a catalogue tag. */
const FINDING_TO_TAG = {
  HIGH_LATENCY: 'CAM_HIGH_LATENCY',
  AUTH_FAIL: 'CAM_AUTH_FAIL',
  CLOCK_DRIFT: 'TIME_DRIFT',
  NTP_LOST: 'TIME_NTP_LOST',
  CODEC_DRIFT: 'VID_CODEC_DRIFT',
  RESOLUTION_DRIFT: 'VID_RESOLUTION_DRIFT',
  STORAGE_FAIL: 'STO_FAIL',
  STORAGE_FULL: 'STO_NEAR_FULL',
  IMAGE_BLACK: 'VID_LOSS_BLACK',
  IMAGE_FROZEN: 'VID_FROZEN',
  IMAGE_FLAT: 'VID_TAMPER_COVERED',
  IMAGE_WASHED_OUT: 'VID_WASHED_OUT',
  STREAM_FAIL: 'VID_STREAM_FAIL',
  ONVIF_TAMPER: 'VID_TAMPER_ONVIF',
};

/** Latching findings become events rather than conditions — they do not "clear". */
const LATCHING_FINDINGS = { REBOOT: 'CAM_REBOOT' };

/** Every tag the mapper can assert, so absence can be asserted too. */
export const MAPPED_TAGS = [
  'CAM_COMM_LOSS', 'CAM_COMM_DEGRADED', 'CAM_UNSTABLE', 'CAM_DOWN_SUSTAINED',
  ...new Set(Object.values(FINDING_TO_TAG)),
];

/**
 * @param result  a probe result (from probeCamera)
 * @param state   the detector's camera state for this device (may be undefined)
 * @param cfg     validated config
 * @returns { conditions: [{tag, present, evidence}], events: [{tag, evidence}] }
 */
export function conditionsFor(result, state, cfg, now = Date.now()) {
  const subject = { id: result.cameraId, name: result.name, group: result.group };

  // Rule: a verdict we could not reach asserts nothing.
  if (result.status === STATUS.UNKNOWN) {
    return { subject, conditions: [], events: [], skipped: 'status-unknown' };
  }

  const byCode = new Map((result.findings ?? []).map((f) => [f.code, f]));
  const conditions = [];
  const add = (tag, present, evidence = {}) => conditions.push({ tag, present, evidence });

  /* --- reachability ------------------------------------------------------- */
  add('CAM_COMM_LOSS', result.status === STATUS.DOWN, {
    detail: result.detail,
    value: result.reason,
  });

  // "Reachable but no service" is a distinct fault from "nothing answered" and gets
  // its own alarm, because the corrective action differs.
  add('CAM_COMM_DEGRADED', result.status === STATUS.DEGRADED && result.reason === 'services-down', {
    detail: result.detail,
  });

  /* --- finding-derived conditions ---------------------------------------- */
  for (const [code, tag] of Object.entries(FINDING_TO_TAG)) {
    const f = byCode.get(code);
    add(tag, !!f, f ? { detail: f.detail, value: f.value } : {});
  }

  /* --- state-derived conditions ------------------------------------------ */
  add('CAM_UNSTABLE', !!state?.flapping, {
    detail: state?.flapping
      ? `${state.flapHistory?.length ?? 0} state changes in ${cfg.detect.flapWindowMin} minutes`
      : null,
  });

  // Sustained outage, with the escalation ladder raising the instance's priority as it
  // lengthens. The catalogue entry stays HIGH; only this instance becomes critical.
  const bad = result.status === STATUS.DOWN || result.status === STATUS.DEGRADED;
  const downMs = bad && state?.since ? now - state.since : 0;
  const rungs = cfg.alerts.escalation ?? [];
  const reached = rungs.filter((r) => downMs >= r.afterMin * 60_000);
  const top = reached.at(-1);
  add('CAM_DOWN_SUSTAINED', !!top, top ? {
    detail: `${result.name} has been ${result.status} for ${Math.round(downMs / 60_000)} minutes — ${top.label ?? `past ${top.afterMin} minutes`}.`,
    value: downMs,
    escalationPriority: top.severity === 'critical' ? 'critical' : 'high',
    escalationLevel: reached.length,
  } : {});

  /* --- latching events ---------------------------------------------------- */
  const events = [];
  for (const [code, tag] of Object.entries(LATCHING_FINDINGS)) {
    const f = byCode.get(code);
    if (f) events.push({ tag, evidence: { detail: f.detail, value: f.value } });
  }

  return { subject, conditions, events };
}

/**
 * System- and group-level conditions, derived from the fleet rollup rather than from
 * any one camera.
 */
export function systemConditions({ fleet, network, coverage, queue, cfg, disk }) {
  const conditions = [];
  const groupConditions = [];
  const add = (tag, present, evidence = {}) => conditions.push({ tag, present, evidence });

  /* --- a whole zone dark: one fault, not N ------------------------------- */
  const mo = cfg.alerts.massOutage ?? {};
  for (const g of fleet.groups ?? []) {
    const wiped = g.total > 1 && g.up === 0 && g.unknown === 0;
    groupConditions.push({
      tag: 'NET_ZONE_DOWN',
      present: !!(mo.groupWipeout && wiped),
      subject: { id: `group:${g.name}`, name: g.name, group: g.name },
      evidence: wiped ? {
        detail: `All ${g.total} cameras in ${g.name} are unreachable — one shared fault, not ${g.total} separate camera faults.`,
        value: g.total,
      } : {},
    });
  }

  /* --- site-wide ---------------------------------------------------------- */
  const badCount = (fleet.down ?? 0) + (fleet.degraded ?? 0);
  const pct = fleet.total ? (badCount / fleet.total) * 100 : 0;
  const massive = mo.enabled !== false
    && fleet.total >= (mo.minCameras ?? 5)
    && pct >= (mo.fleetPctThreshold ?? 25);
  add('NET_SITE_OUTAGE', massive, massive ? {
    detail: `${badCount} of ${fleet.total} cameras (${Math.round(pct)}%) are not serving video — treat as a site-level fault.`,
    value: Math.round(pct * 10) / 10,
  } : {});

  /* --- our own network ---------------------------------------------------- */
  add('NET_MONITOR_PATH_DOWN', network?.checked === true && network.healthy === false, {
    detail: network?.reason,
  });

  /* --- the monitor itself ------------------------------------------------- */
  add('SYS_MONITOR_STALLED', !!coverage?.stale, {
    detail: coverage?.stale
      ? `No monitoring cycle has completed for ${Math.round((coverage.staleMs ?? 0) / 60_000)} minutes.`
      : null,
    value: coverage?.staleMs,
  });

  add('SYS_CYCLE_OVERRUN', !!coverage?.overrun, {
    detail: coverage?.overrun
      ? `A probe cycle took ${coverage.lastDurationMs} ms, longer than the ${cfg.monitor.intervalSec}s interval.`
      : null,
    value: coverage?.lastDurationMs,
  });

  add('SYS_DISK_LOW', Number.isFinite(disk?.freePct) && disk.freePct < 5, {
    detail: disk ? `${Math.round(disk.freePct)}% free on the monitoring host.` : null,
    value: disk?.freePct,
  });

  /* --- alarms not reaching people ---------------------------------------- */
  // A backed-up queue with failures means detection is working and annunciation is not.
  const stuck = (queue?.pending ?? 0) > 0
    && queue?.oldestAt
    && Date.now() - queue.oldestAt > (cfg.alarms?.channelStuckMinutes ?? 15) * 60_000;
  add('SYS_CHANNEL_FAIL', !!stuck, stuck ? {
    detail: `${queue.pending} alert${queue.pending === 1 ? '' : 's'} have been undelivered for over ${Math.round((Date.now() - queue.oldestAt) / 60_000)} minutes. Alarms are being detected but are not reaching anyone.`,
    value: queue.pending,
  } : {});

  return { conditions, groupConditions };
}
