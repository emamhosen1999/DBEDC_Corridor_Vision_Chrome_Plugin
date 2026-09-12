/**
 * The alarm register — ISA-18.2 / IEC 62682 alarm lifecycle.
 *
 * The distinction this file exists to enforce: a **condition** is a fact about the
 * world, an **alarm** is an annunciated demand for operator action, and the two have
 * different lifetimes. A camera that came back online no longer has the condition, but
 * if nobody ever acknowledged the alarm, the alarm is not finished — somebody needs to
 * see that it happened. Systems that conflate the two lose outages silently, which is
 * what the previous extension did.
 *
 * State machine (ISA-18.2 clause 5, figure 5):
 *
 *        ┌─────────┐  condition raised   ┌──────────────┐
 *        │ NORMAL  │────────────────────▶│ UNACK_ALARM  │
 *        └─────────┘                     └──────┬───────┘
 *             ▲                        ack ┌────┴────┐ condition clears
 *             │                            ▼         ▼
 *             │                     ┌────────────┐  ┌────────────┐
 *             │  condition clears   │ ACK_ALARM  │  │ RTN_UNACK  │
 *             ├─────────────────────┤            │  │            │
 *             │                     └────────────┘  └─────┬──────┘
 *             └───────────────────────────────────────────┘  ack
 *
 * Plus three off-normal holds, each of which must be deliberate, attributable and
 * reversible:
 *   SHELVED              — operator silenced it temporarily; ALWAYS expires
 *   SUPPRESSED_BY_DESIGN — a maintenance window is suppressing it
 *   OUT_OF_SERVICE       — taken out by maintenance until explicitly returned
 *
 * Shelving always expires. A permanent silence is how alarm systems rot: someone
 * shelves a nuisance alarm during a night shift, nobody remembers, and two years later
 * the condition it was hiding causes the incident. Every shelf here carries an expiry
 * and a stated reason, and its expiry raises its own diagnostic alarm.
 */
import { getAlarmDef, severityForPriority, PRIORITY_RANK, PRIORITY } from './catalog.mjs';
import { updateState, appendEvent } from '../core/store.mjs';
import { log } from '../core/logger.mjs';

const logger = log('alarms');

export const STATE = {
  NORMAL: 'normal',
  UNACK_ALARM: 'unack-alarm',
  ACK_ALARM: 'ack-alarm',
  RTN_UNACK: 'rtn-unack',
  SHELVED: 'shelved',
  SUPPRESSED: 'suppressed-by-design',
  OUT_OF_SERVICE: 'out-of-service',
};

/** States in which the condition is currently present. */
export const ACTIVE_STATES = new Set([STATE.UNACK_ALARM, STATE.ACK_ALARM, STATE.SHELVED, STATE.SUPPRESSED]);
/** States that demand operator attention on the annunciator. */
export const ANNUNCIATED_STATES = new Set([STATE.UNACK_ALARM, STATE.ACK_ALARM, STATE.RTN_UNACK]);

/** The register key for one alarm instance: tag + the thing it is about. */
export const instanceKey = (tag, subjectId) => (subjectId ? `${tag}:${subjectId}` : tag);

function emptyInstance(tag, subject, now) {
  const def = getAlarmDef(tag);
  return {
    key: instanceKey(tag, subject.id),
    tag,
    subjectId: subject.id ?? null,
    subjectName: subject.name ?? null,
    subjectGroup: subject.group ?? null,
    scope: def.scope,
    priority: def.priority,
    state: STATE.NORMAL,
    // Lifecycle timestamps. `firstRaisedAt` never moves; `raisedAt` is this occurrence.
    firstRaisedAt: null,
    raisedAt: null,
    ackedAt: null,
    ackedBy: null,
    clearedAt: null,
    lastTransitionAt: now,
    // Counters for KPIs and chattering detection.
    occurrences: 0,
    transitions: [],        // recent transition timestamps, trimmed to the chatter window
    chattering: false,
    // Hold state.
    shelvedUntil: null,
    shelvedBy: null,
    shelveReason: null,
    outOfServiceBy: null,
    outOfServiceReason: null,
    // Most recent evidence, shown on the annunciator and in the report.
    detail: null,
    value: null,
    escalationLevel: 0,
  };
}

/** Effective priority: escalating alarms carry the level's priority, not the catalogue's. */
export function effectivePriority(instance) {
  const def = getAlarmDef(instance.tag);
  if (!def.escalates || !instance.escalationPriority) return def.priority;
  return PRIORITY_RANK[instance.escalationPriority] > PRIORITY_RANK[def.priority]
    ? instance.escalationPriority
    : def.priority;
}

/**
 * The register. Holds every alarm instance and applies the state machine.
 *
 * `notify(alarmEvent)` is called for every transition that should reach people; the
 * engine wires it to the alert bus. Transitions that are held (shelved, suppressed,
 * out of service) still update the register and the event log — they are recorded, just
 * not annunciated, which is the distinction the standard requires.
 */
export class AlarmRegister {
  constructor({ cfg, notify } = {}) {
    this.cfg = cfg;
    this.notify = notify ?? (() => {});
    this.instances = new Map();
  }

  setConfig(cfg) { this.cfg = cfg; }

  /** Restore the register from persisted state on startup. */
  load(saved = {}) {
    this.instances = new Map(Object.entries(saved));
    return this;
  }

  /** Serialise for persistence. */
  toJSON() { return Object.fromEntries(this.instances); }

  get(tag, subjectId) { return this.instances.get(instanceKey(tag, subjectId)) ?? null; }

  /** Every instance not in NORMAL. */
  active() {
    return [...this.instances.values()].filter((i) => i.state !== STATE.NORMAL);
  }

  /** Instances currently demanding attention, most severe and oldest first. */
  annunciated() {
    return [...this.instances.values()]
      .filter((i) => ANNUNCIATED_STATES.has(i.state))
      .sort((a, b) =>
        PRIORITY_RANK[effectivePriority(b)] - PRIORITY_RANK[effectivePriority(a)]
        || (a.raisedAt ?? 0) - (b.raisedAt ?? 0));
  }

  unacknowledged() {
    return [...this.instances.values()].filter((i) => i.state === STATE.UNACK_ALARM || i.state === STATE.RTN_UNACK);
  }

  /** Alarms active longer than the standing threshold — EEMUA targets fewer than 5. */
  standing(now = Date.now()) {
    const thresholdMs = (this.cfg?.alarms?.standingAfterHours ?? 24) * 3_600_000;
    return this.active().filter((i) => ACTIVE_STATES.has(i.state) && i.raisedAt && now - i.raisedAt >= thresholdMs);
  }

  /**
   * Assert a condition's presence or absence. This is the only entry point the engine
   * uses; the state machine decides what that means for the alarm.
   *
   * @param tag       catalogue tag
   * @param present   is the condition true right now?
   * @param subject   { id, name, group } — what it is about
   * @param evidence  { detail, value, escalationPriority, escalationLevel }
   */
  assert(tag, present, subject = {}, evidence = {}, now = Date.now()) {
    const def = getAlarmDef(tag);
    const key = instanceKey(tag, subject.id);
    let inst = this.instances.get(key);
    if (!inst) {
      if (!present) return null;                 // nothing to record
      inst = emptyInstance(tag, subject, now);
      this.instances.set(key, inst);
    }

    // Refresh the subject and evidence on every assertion — names and reasons change.
    if (subject.name) inst.subjectName = subject.name;
    if (subject.group) inst.subjectGroup = subject.group;
    if (evidence.detail !== undefined) inst.detail = evidence.detail;
    if (evidence.value !== undefined) inst.value = evidence.value;
    if (evidence.escalationPriority) inst.escalationPriority = evidence.escalationPriority;
    if (evidence.escalationLevel !== undefined) inst.escalationLevel = evidence.escalationLevel;

    /* --- Out of service: the register records nothing until it is returned. ------ */
    if (inst.state === STATE.OUT_OF_SERVICE) return null;

    /* --- Shelved: hold the state, but let it expire. ---------------------------- */
    if (inst.state === STATE.SHELVED) {
      if (now < inst.shelvedUntil) return null;
      // Expiry: back to service. If the condition is still present it re-annunciates.
      inst.state = present ? STATE.UNACK_ALARM : STATE.NORMAL;
      inst.lastTransitionAt = now;
      inst.shelvedUntil = null;
      const reason = inst.shelveReason;
      inst.shelveReason = null;
      inst.shelvedBy = null;
      this.#emit(inst, 'unshelved', { reason, stillPresent: present }, now);
      if (present) this.#emit(inst, 'raised', {}, now);
      return inst;
    }

    /* --- Suppressed by design (maintenance window). ----------------------------- */
    const suppressing = def.suppressible && this.#suppressionFor(inst, now);
    if (suppressing) {
      if (inst.state !== STATE.SUPPRESSED) {
        inst.state = STATE.SUPPRESSED;
        inst.lastTransitionAt = now;
        inst.suppressedBy = suppressing.name;
        this.#record(inst, 'suppressed', { window: suppressing.name }, now);
      }
      return inst;
    }
    if (inst.state === STATE.SUPPRESSED) {
      inst.state = present ? STATE.UNACK_ALARM : STATE.NORMAL;
      inst.lastTransitionAt = now;
      inst.suppressedBy = null;
      this.#record(inst, 'unsuppressed', {}, now);
      if (present) this.#emit(inst, 'raised', {}, now);
      return inst;
    }

    /* --- Normal lifecycle ------------------------------------------------------- */
    if (present) {
      if (inst.state === STATE.NORMAL || inst.state === STATE.RTN_UNACK) {
        // RTN_UNACK → active again is a re-occurrence, not a new alarm: the operator
        // still owes an acknowledgement for the first one.
        const reoccurring = inst.state === STATE.RTN_UNACK;
        inst.state = STATE.UNACK_ALARM;
        inst.raisedAt = now;
        inst.firstRaisedAt ??= now;
        inst.clearedAt = null;
        inst.occurrences += 1;
        inst.lastTransitionAt = now;
        this.#pushTransition(inst, now);
        this.#emit(inst, 'raised', { reoccurring }, now);
      }
      // Already UNACK_ALARM or ACK_ALARM: the condition persists, nothing to annunciate.
      return inst;
    }

    /* --- Condition cleared ------------------------------------------------------ */
    if (inst.state === STATE.UNACK_ALARM) {
      // Cleared before anyone saw it. The alarm is NOT finished — it goes to RTN_UNACK
      // so the operator still has to acknowledge that it happened. This is the whole
      // point: a short outage at 3am must not vanish before the morning shift sees it.
      inst.state = STATE.RTN_UNACK;
      inst.clearedAt = now;
      inst.lastTransitionAt = now;
      this.#pushTransition(inst, now);
      this.#emit(inst, 'cleared', { durationMs: now - inst.raisedAt, acknowledged: false }, now);
      return inst;
    }
    if (inst.state === STATE.ACK_ALARM) {
      inst.state = STATE.NORMAL;
      inst.clearedAt = now;
      inst.lastTransitionAt = now;
      this.#pushTransition(inst, now);
      this.#emit(inst, 'cleared', { durationMs: now - inst.raisedAt, acknowledged: true }, now);
      return inst;
    }
    return inst;
  }

  /**
   * Raise a latching alarm — an event rather than a condition (a reboot, a tamper
   * report). It has no "cleared" state; it stays until acknowledged.
   */
  raiseEvent(tag, subject = {}, evidence = {}, now = Date.now()) {
    const def = getAlarmDef(tag);
    const key = instanceKey(tag, subject.id);
    let inst = this.instances.get(key);
    if (!inst) {
      inst = emptyInstance(tag, subject, now);
      this.instances.set(key, inst);
    }
    if (subject.name) inst.subjectName = subject.name;
    if (subject.group) inst.subjectGroup = subject.group;
    Object.assign(inst, {
      detail: evidence.detail ?? inst.detail,
      value: evidence.value ?? inst.value,
      raisedAt: now,
      firstRaisedAt: inst.firstRaisedAt ?? now,
      occurrences: inst.occurrences + 1,
      lastTransitionAt: now,
      state: def.requiresAck ? STATE.UNACK_ALARM : STATE.NORMAL,
    });
    this.#pushTransition(inst, now);
    this.#emit(inst, 'raised', { latching: true }, now);
    return inst;
  }

  /* --------------------------- operator actions --------------------------- */

  /** Acknowledge one alarm. Returns the instance, or null if there was nothing to ack. */
  acknowledge(key, { by = 'operator', note = null } = {}, now = Date.now()) {
    const inst = this.instances.get(key);
    if (!inst) return null;
    if (inst.state === STATE.UNACK_ALARM) {
      inst.state = STATE.ACK_ALARM;
    } else if (inst.state === STATE.RTN_UNACK) {
      inst.state = STATE.NORMAL;                 // cleared and now seen: finished
    } else {
      return null;                               // nothing to acknowledge
    }
    inst.ackedAt = now;
    inst.ackedBy = by;
    inst.ackNote = note;
    inst.lastTransitionAt = now;
    this.#record(inst, 'acknowledged', { by, note, responseMs: inst.raisedAt ? now - inst.raisedAt : null }, now);
    return inst;
  }

  /** Acknowledge everything currently annunciated. Returns how many were acked. */
  acknowledgeAll({ by = 'operator', note = null, filter } = {}, now = Date.now()) {
    let n = 0;
    for (const inst of this.annunciated()) {
      if (filter && !filter(inst)) continue;
      if (this.acknowledge(inst.key, { by, note }, now)) n++;
    }
    return n;
  }

  /**
   * Shelve an alarm for a bounded period. Refuses for alarms the catalogue marks
   * unshelvable — the watchdog and the channel-failure alarm must never be silenceable,
   * because those are the two that tell you the alarm system itself has failed.
   */
  shelve(key, { hours = 4, by = 'operator', reason } = {}, now = Date.now()) {
    const inst = this.instances.get(key);
    if (!inst) return { ok: false, error: 'no such alarm' };
    const def = getAlarmDef(inst.tag);
    if (!def.shelvable) {
      return { ok: false, error: `${inst.tag} cannot be shelved: ${def.name} reports a failure of the monitoring system itself` };
    }
    if (!reason) return { ok: false, error: 'a reason is required to shelve an alarm' };
    const maxHours = this.cfg?.alarms?.maxShelveHours ?? 24;
    const capped = Math.min(Math.max(0.25, Number(hours) || 4), maxHours);
    inst.state = STATE.SHELVED;
    inst.shelvedUntil = now + capped * 3_600_000;
    inst.shelvedBy = by;
    inst.shelveReason = reason;
    inst.lastTransitionAt = now;
    this.#record(inst, 'shelved', { by, reason, hours: capped, until: inst.shelvedUntil }, now);
    logger.info('alarm shelved', { tag: inst.tag, subject: inst.subjectName, hours: capped, by, reason });
    return { ok: true, instance: inst, hours: capped };
  }

  unshelve(key, { by = 'operator' } = {}, now = Date.now()) {
    const inst = this.instances.get(key);
    if (!inst || inst.state !== STATE.SHELVED) return { ok: false, error: 'alarm is not shelved' };
    inst.state = STATE.UNACK_ALARM;              // re-asserted on the next cycle if gone
    inst.shelvedUntil = null;
    inst.shelveReason = null;
    inst.lastTransitionAt = now;
    this.#record(inst, 'unshelved', { by, manual: true }, now);
    return { ok: true, instance: inst };
  }

  /** Take an alarm out of service — maintenance, indefinite, explicit. */
  outOfService(key, { by = 'maintenance', reason } = {}, now = Date.now()) {
    const inst = this.instances.get(key);
    if (!inst) return { ok: false, error: 'no such alarm' };
    const def = getAlarmDef(inst.tag);
    if (!def.shelvable) return { ok: false, error: `${inst.tag} cannot be taken out of service` };
    if (!reason) return { ok: false, error: 'a reason is required' };
    inst.state = STATE.OUT_OF_SERVICE;
    inst.outOfServiceBy = by;
    inst.outOfServiceReason = reason;
    inst.lastTransitionAt = now;
    this.#record(inst, 'out-of-service', { by, reason }, now);
    return { ok: true, instance: inst };
  }

  returnToService(key, { by = 'maintenance' } = {}, now = Date.now()) {
    const inst = this.instances.get(key);
    if (!inst || inst.state !== STATE.OUT_OF_SERVICE) return { ok: false, error: 'alarm is not out of service' };
    inst.state = STATE.NORMAL;
    inst.outOfServiceBy = null;
    inst.outOfServiceReason = null;
    inst.lastTransitionAt = now;
    this.#record(inst, 'returned-to-service', { by }, now);
    return { ok: true, instance: inst };
  }

  /* ------------------------------ housekeeping ------------------------------ */

  /**
   * Sweep for shelf expiries, chattering and standing alarms.
   * Returns the derived alarms the engine should assert.
   */
  sweep(now = Date.now()) {
    const derived = [];
    const chatterWindowMs = (this.cfg?.alarms?.chatterWindowMin ?? 10) * 60_000;
    const chatterCount = this.cfg?.alarms?.chatterCount ?? 6;

    for (const inst of this.instances.values()) {
      // Shelf expiry.
      if (inst.state === STATE.SHELVED && now >= inst.shelvedUntil) {
        const reason = inst.shelveReason;
        inst.state = STATE.UNACK_ALARM;
        inst.shelvedUntil = null;
        inst.shelveReason = null;
        inst.lastTransitionAt = now;
        this.#emit(inst, 'unshelved', { expired: true, reason }, now);
        derived.push({
          tag: 'ALM_SHELF_EXPIRED',
          subject: { id: inst.key, name: inst.subjectName ?? inst.tag, group: inst.subjectGroup },
          detail: `The shelf on ${inst.tag} expired and it has returned to service. Original reason: ${reason ?? 'not stated'}.`,
        });
      }

      // Chattering: repeated transitions inside the window.
      inst.transitions = (inst.transitions ?? []).filter((t) => now - t <= chatterWindowMs);
      const wasChattering = inst.chattering;
      inst.chattering = inst.transitions.length >= chatterCount;
      if (inst.chattering && !wasChattering) {
        derived.push({
          tag: 'ALM_CHATTERING',
          subject: { id: inst.key, name: inst.subjectName ?? inst.tag, group: inst.subjectGroup },
          detail: `${inst.tag} on ${inst.subjectName ?? 'the system'} changed state ${inst.transitions.length} times in ${this.cfg?.alarms?.chatterWindowMin ?? 10} minutes.`,
        });
      }
    }

    // Standing alarms: one derived alarm per offender, so each is individually trackable.
    for (const inst of this.standing(now)) {
      if (inst.tag === 'ALM_STANDING') continue;
      derived.push({
        tag: 'ALM_STANDING',
        subject: { id: inst.key, name: inst.subjectName ?? inst.tag, group: inst.subjectGroup },
        detail: `${inst.tag} has been active since ${new Date(inst.raisedAt).toISOString()} without being resolved.`,
      });
    }
    return derived;
  }

  /** Drop finished instances so the register does not grow without bound. */
  prune(now = Date.now(), maxAgeMs = 7 * 86_400_000) {
    let removed = 0;
    for (const [key, inst] of this.instances) {
      if (inst.state !== STATE.NORMAL) continue;
      if (now - inst.lastTransitionAt < maxAgeMs) continue;
      this.instances.delete(key);
      removed++;
    }
    return removed;
  }

  /* -------------------------------- internals -------------------------------- */

  #suppressionFor(inst, now) {
    for (const w of this.cfg?.alerts?.maintenance ?? []) {
      const from = Date.parse(w.from);
      const to = Date.parse(w.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now > to) continue;
      const groups = w.groups ?? [];
      const cameras = w.cameras ?? [];
      const tags = w.tags ?? [];
      if (tags.length && !tags.includes(inst.tag)) continue;
      if (!groups.length && !cameras.length) return w;
      if (groups.includes(inst.subjectGroup)) return w;
      if (cameras.includes(inst.subjectId)) return w;
    }
    return null;
  }

  #pushTransition(inst, now) {
    inst.transitions = [...(inst.transitions ?? []), now].slice(-40);
  }

  /** Record a transition in the event log without annunciating it. */
  #record(inst, transition, extra, now) {
    const def = getAlarmDef(inst.tag);
    appendEvent({
      type: `alarm.${transition}`,
      tag: inst.tag,
      key: inst.key,
      name: inst.subjectName,
      group: inst.subjectGroup,
      cameraId: inst.subjectId,
      priority: effectivePriority(inst),
      alarmClass: def.class,
      state: inst.state,
      severity: severityForPriority(effectivePriority(inst)),
      ts: now,
      ...extra,
    }).catch(() => {});
  }

  /** Record AND annunciate. */
  #emit(inst, transition, extra, now) {
    this.#record(inst, transition, extra, now);
    const def = getAlarmDef(inst.tag);
    const priority = effectivePriority(inst);
    this.notify({
      type: `alarm.${transition}`,
      tag: inst.tag,
      key: inst.key,
      at: now,
      priority,
      severity: severityForPriority(priority),
      alarmClass: def.class,
      name: def.name,
      state: inst.state,
      subject: { id: inst.subjectId, name: inst.subjectName, group: inst.subjectGroup },
      detail: inst.detail,
      value: inst.value,
      occurrences: inst.occurrences,
      definition: def,
      ...extra,
    });
  }
}

/** Persist the register alongside the rest of the state. */
export async function saveRegister(register) {
  await updateState((s) => { s.alarms = register.toJSON(); });
}

export { PRIORITY };
