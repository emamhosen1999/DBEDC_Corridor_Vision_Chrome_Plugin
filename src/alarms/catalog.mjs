/**
 * The alarm catalogue — every condition this system can annunciate.
 *
 * Structured to ISA-18.2 / IEC 62682 "alarm rationalisation": every alarm carries the
 * four things an operator needs at 3am and a designer needs at review time —
 * **cause**, **consequence**, **corrective action**, and **time to respond**. An alarm
 * that cannot answer those four questions should not exist; that is the standard's
 * central discipline and the reason this file reads like a register rather than a list
 * of strings.
 *
 * Priorities follow ISA-18.2's five-level scheme. The standard also sets a target
 * *distribution* — roughly 80% low, 15% medium, 5% high/critical — on the grounds that
 * if everything is urgent, nothing is. `priorityDistribution()` measures the catalogue
 * against that, and the KPI report measures live alarm traffic against it too.
 *
 * `tag` is the stable machine identity. It appears in the event log, the register, the
 * report and every integration, and must never change once deployed — external systems
 * key off it.
 */

/** ISA-18.2 priority levels, ordered. */
export const PRIORITY = {
  DIAGNOSTIC: 'diagnostic',  // maintenance information; not annunciated to operators
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

export const PRIORITY_RANK = { diagnostic: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** Map an alarm priority onto the notification severity used by the alert bus. */
export const PRIORITY_SEVERITY = {
  diagnostic: 'info',
  low: 'info',
  medium: 'warning',
  high: 'critical',
  critical: 'critical',
};

/** Functional classes, used for grouping in reports and for routing. */
export const CLASS = {
  COMMS: 'communication',
  VIDEO: 'video',
  STORAGE: 'storage',
  TIME: 'time',
  NETWORK: 'network',
  SECURITY: 'security',
  INVENTORY: 'inventory',
  SYSTEM: 'system',
  AVAILABILITY: 'availability',
  ALARM_SYSTEM: 'alarm-system',
  REPORT: 'report',
};

const D = (o) => ({
  requiresAck: true,
  shelvable: true,
  suppressible: true,
  autoClear: true,
  latching: false,
  ...o,
});

/**
 * The register. Keyed by tag.
 *
 * `scope` says what the alarm is about — a device, a group, or the system itself — and
 * decides how instances are keyed: a device alarm is one instance per camera, a system
 * alarm is a singleton.
 */
export const CATALOG = {

  /* ======================= COMMUNICATION ======================= */

  CAM_COMM_LOSS: D({
    tag: 'CAM_COMM_LOSS',
    name: 'Camera communication loss',
    class: CLASS.COMMS,
    scope: 'device',
    priority: PRIORITY.MEDIUM,
    cause: 'No authoritative probe layer could reach the camera: no TCP connection, no ONVIF response and no RTSP response.',
    consequence: 'No live view and no recording from this camera. Any incident in its field of view goes unrecorded.',
    correctiveAction: 'Check camera power and PoE injector, then the patch lead and the switch port. If neighbouring cameras on the same switch are also down, treat it as a zone fault.',
    timeToRespond: '30 minutes',
  }),

  CAM_COMM_DEGRADED: D({
    tag: 'CAM_COMM_DEGRADED',
    name: 'Camera reachable but services down',
    class: CLASS.COMMS,
    scope: 'device',
    priority: PRIORITY.MEDIUM,
    cause: 'The host answered at the network layer (TCP reset or partial response) but no camera service responded. Typically a camera that is booting, or whose application has crashed while the network stack stays up.',
    consequence: 'No usable video, although the device appears present on the network. Most VMS platforms will report this camera as online.',
    correctiveAction: 'Wait one cycle in case it is rebooting. If it persists, power-cycle the camera. Repeated occurrences indicate failing hardware.',
    timeToRespond: '30 minutes',
  }),

  CAM_AUTH_FAIL: D({
    tag: 'CAM_AUTH_FAIL',
    name: 'Camera credentials rejected',
    class: CLASS.COMMS,
    scope: 'device',
    priority: PRIORITY.LOW,
    cause: 'The camera returned 401 to an authenticated request. The stored password no longer matches, or the account was changed or locked.',
    consequence: 'Stream and health checks cannot run. The camera may be serving video perfectly and still be invisible to monitoring.',
    correctiveAction: 'Confirm the camera password, then update it: node src/cli.mjs secret set cameras.password <value>. If only one camera differs, set per-camera credentials in the inventory.',
    timeToRespond: '4 hours',
  }),

  CAM_UNSTABLE: D({
    tag: 'CAM_UNSTABLE',
    name: 'Camera unstable (flapping)',
    class: CLASS.COMMS,
    scope: 'device',
    priority: PRIORITY.LOW,
    cause: 'The camera changed state repeatedly inside the flap window. Almost always physical: PoE power budget exceeded on the switch, a failing patch lead, water ingress in a connector, or a switch port renegotiating speed.',
    consequence: 'Intermittent recording with gaps. Per-change alarms are suppressed for this device while it flaps, so a genuine loss could be masked.',
    correctiveAction: 'Count the cameras and total draw on that switch against its PoE budget. Inspect the patch lead and the outdoor connector. Check the switch port for speed or duplex renegotiation.',
    timeToRespond: '24 hours',
  }),

  CAM_HIGH_LATENCY: D({
    tag: 'CAM_HIGH_LATENCY',
    name: 'Camera round-trip latency high',
    class: CLASS.COMMS,
    scope: 'device',
    priority: PRIORITY.LOW,
    cause: 'Round-trip time is above threshold. Usually a saturated uplink, a duplex mismatch, or a failing fibre run.',
    consequence: 'Stream stutter and dropped frames, worsening as the link saturates. Often the first warning before an outright outage.',
    correctiveAction: 'Check uplink utilisation for that zone. Review recent bitrate or resolution changes that may have raised demand.',
    timeToRespond: '24 hours',
  }),

  CAM_REBOOT: D({
    tag: 'CAM_REBOOT',
    name: 'Camera restarted',
    class: CLASS.COMMS,
    scope: 'device',
    priority: PRIORITY.LOW,
    cause: 'Reported uptime went backwards, so the camera restarted between cycles. Causes include a power interruption, a watchdog reset, or a firmware fault.',
    consequence: 'A recording gap across the restart. Repeated restarts usually precede hardware failure, and a factory-default restart silently resets the stream profile.',
    correctiveAction: 'Verify the stream profile survived. Check the power feed for that camera. Log the frequency — more than a few a week warrants replacement.',
    timeToRespond: '24 hours',
    autoClear: false,   // an event, not a condition: it is acknowledged, not "cleared"
    latching: true,
  }),

  CAM_DOWN_SUSTAINED: D({
    tag: 'CAM_DOWN_SUSTAINED',
    name: 'Camera down — sustained outage',
    class: CLASS.COMMS,
    scope: 'device',
    priority: PRIORITY.HIGH,
    cause: 'The camera has been unreachable past an escalation threshold without recovering on its own.',
    consequence: 'Prolonged loss of coverage. At this duration the outage will not self-resolve and site attendance is required.',
    correctiveAction: 'Dispatch to site. Take a spare camera and patch lead — at this duration it is usually hardware or cabling, not a soft fault.',
    timeToRespond: '4 hours',
    // Escalation rungs raise the priority of the instance as the outage lengthens;
    // the catalogue entry itself stays HIGH so the register is not skewed by it.
    escalates: true,
  }),

  /* ============================ VIDEO ============================ */

  VID_STREAM_FAIL: D({
    tag: 'VID_STREAM_FAIL',
    name: 'Video stream not serving',
    class: CLASS.VIDEO,
    scope: 'device',
    priority: PRIORITY.MEDIUM,
    cause: 'The camera is reachable and its management services answer, but RTSP DESCRIBE fails. The encoder has wedged, or the stream profile was deleted.',
    consequence: 'NO RECORDING, while the camera reports itself healthy. Most VMS platforms show this camera green. This is discovered during incident review, weeks late.',
    correctiveAction: 'Power-cycle the camera to reset the encoder. Then confirm the stream profile still exists and matches the VMS configuration.',
    timeToRespond: '1 hour',
  }),

  VID_LOSS_BLACK: D({
    tag: 'VID_LOSS_BLACK',
    name: 'Video black',
    class: CLASS.VIDEO,
    scope: 'device',
    priority: PRIORITY.MEDIUM,
    cause: 'Mean image luminance is at or below the black threshold. An IR cut filter stuck in the night position, a dead sensor, a failed illuminator, or a lens cap left on after maintenance.',
    consequence: 'Recording continues and produces nothing usable. Storage and bandwidth are consumed recording a black rectangle.',
    correctiveAction: 'At night, confirm the IR illuminator works. In daylight, a black image means a stuck IR filter or a dead sensor — attend site.',
    timeToRespond: '4 hours',
  }),

  VID_FROZEN: D({
    tag: 'VID_FROZEN',
    name: 'Video frozen',
    class: CLASS.VIDEO,
    scope: 'device',
    priority: PRIORITY.MEDIUM,
    cause: 'The image hash has been identical across consecutive samples. The encoder has wedged and is re-serving one frame.',
    consequence: 'RECORDED FOOTAGE FOR THIS PERIOD IS WORTHLESS. The stream looks healthy to every downstream system, and the recording appears complete.',
    correctiveAction: 'Power-cycle the camera immediately. Note the period as unrecorded for evidential purposes — anything claimed to be recorded during it is not.',
    timeToRespond: '1 hour',
  }),

  VID_TAMPER_COVERED: D({
    tag: 'VID_TAMPER_COVERED',
    name: 'Video flat — lens obstructed or tampered',
    class: CLASS.VIDEO,
    scope: 'device',
    priority: PRIORITY.HIGH,
    cause: 'Image variance is near zero: the scene has no structure. The lens is covered, fogged, painted, heavily defocused, or the camera has been turned to face a blank surface.',
    consequence: 'No usable coverage. Deliberate obstruction is often the first step of an incident, so treat an unexplained occurrence as a security event.',
    correctiveAction: 'Review the last good image before the alarm. If the change was abrupt and unexplained, treat as tampering and escalate to security. Otherwise clean or re-aim.',
    timeToRespond: '2 hours',
  }),

  VID_WASHED_OUT: D({
    tag: 'VID_WASHED_OUT',
    name: 'Video overexposed',
    class: CLASS.VIDEO,
    scope: 'device',
    priority: PRIORITY.LOW,
    cause: 'Mean luminance is at the top of the range. Auto-exposure has failed, an IR illuminator is firing in daylight, or a light source is aimed into the lens.',
    consequence: 'Faces and number plates are unreadable — exactly the detail the footage exists to capture.',
    correctiveAction: 'Check exposure and WDR settings and the IR day/night switching threshold. If a new light was installed nearby, re-aim the camera.',
    timeToRespond: '24 hours',
  }),

  VID_TAMPER_ONVIF: D({
    tag: 'VID_TAMPER_ONVIF',
    name: 'Camera reported tampering',
    class: CLASS.VIDEO,
    scope: 'device',
    priority: PRIORITY.HIGH,
    cause: 'The camera raised its own ONVIF tamper event — its analytics detected the scene changing abruptly, the lens being covered, or the housing being moved.',
    consequence: 'Probable deliberate interference. Coverage of this field of view may already be compromised.',
    correctiveAction: 'Review footage from the moments before the event and from adjacent cameras. Escalate to security if interference is confirmed.',
    timeToRespond: 'Immediate',
    autoClear: false,
    latching: true,
  }),

  VID_CODEC_DRIFT: D({
    tag: 'VID_CODEC_DRIFT',
    name: 'Stream codec changed',
    class: CLASS.VIDEO,
    scope: 'device',
    priority: PRIORITY.LOW,
    cause: 'The served codec differs from the expected one. Usually a factory reset after a power event, or an undocumented manual change.',
    consequence: 'Storage projections and VMS decoding assumptions no longer hold. H.264 in place of H.265 roughly doubles storage for the same quality.',
    correctiveAction: 'Restore the intended profile, or update the expectation in the inventory if the change was deliberate.',
    timeToRespond: '7 days',
  }),

  VID_RESOLUTION_DRIFT: D({
    tag: 'VID_RESOLUTION_DRIFT',
    name: 'Stream resolution changed',
    class: CLASS.VIDEO,
    scope: 'device',
    priority: PRIORITY.LOW,
    cause: 'The served resolution differs from the expected one — almost always a camera that reverted to defaults after a power event.',
    consequence: 'Footage may no longer meet the evidential standard for number-plate or facial identification, while appearing to record normally.',
    correctiveAction: 'Restore the intended resolution. Check whether other cameras on the same power feed also reverted.',
    timeToRespond: '48 hours',
  }),

  /* =========================== STORAGE =========================== */

  STO_FAIL: D({
    tag: 'STO_FAIL',
    name: 'Camera storage failed',
    class: CLASS.STORAGE,
    scope: 'device',
    priority: PRIORITY.MEDIUM,
    cause: 'The camera reports its SD card or disk as failed, abnormal or unformatted.',
    consequence: 'Edge recording has stopped. If this camera relies on edge storage for resilience, there is no fallback when the network drops.',
    correctiveAction: 'Replace the SD card. Cards in cameras are consumables — continuous write wears them out, typically within one to two years.',
    timeToRespond: '48 hours',
  }),

  STO_NEAR_FULL: D({
    tag: 'STO_NEAR_FULL',
    name: 'Camera storage nearly full',
    class: CLASS.STORAGE,
    scope: 'device',
    priority: PRIORITY.LOW,
    cause: 'Free space on the camera has fallen below the threshold, usually because overwrite is disabled or the retention setting is wrong.',
    consequence: 'Edge recording will stop when the card fills, silently.',
    correctiveAction: 'Enable overwrite, or reduce the retention period on the camera.',
    timeToRespond: '7 days',
  }),

  /* ============================= TIME ============================= */

  TIME_DRIFT: D({
    tag: 'TIME_DRIFT',
    name: 'Camera clock drift',
    class: CLASS.TIME,
    scope: 'device',
    priority: PRIORITY.MEDIUM,
    cause: 'The camera clock differs from the monitoring host by more than the allowed drift. NTP is unreachable, misconfigured, or the RTC battery has failed.',
    consequence: 'EVERY RECORDING FROM THIS CAMERA CARRIES THE WRONG TIME. Footage with a demonstrably wrong timestamp is difficult to rely on evidentially and cannot be correlated with other cameras.',
    correctiveAction: 'Point the camera at a reachable NTP server and confirm it syncs. A drift that returns after correction means a dead RTC battery.',
    timeToRespond: '48 hours',
  }),

  TIME_NTP_LOST: D({
    tag: 'TIME_NTP_LOST',
    name: 'Camera NTP synchronisation lost',
    class: CLASS.TIME,
    scope: 'device',
    priority: PRIORITY.LOW,
    cause: 'The camera reports NTP as disabled or unsynchronised, even though its clock is currently close enough.',
    consequence: 'The clock will drift. This is the early warning for TIME_DRIFT, which carries evidential consequences.',
    correctiveAction: 'Enable NTP and confirm the configured server is reachable from the camera VLAN.',
    timeToRespond: '7 days',
  }),

  /* =========================== NETWORK =========================== */

  NET_ZONE_DOWN: D({
    tag: 'NET_ZONE_DOWN',
    name: 'Zone communication loss — all cameras',
    class: CLASS.NETWORK,
    scope: 'group',
    priority: PRIORITY.CRITICAL,
    cause: 'Every camera in one zone became unreachable together. Cameras do not fail simultaneously: this is one shared fault — the zone switch, its uplink, or the power feeding them.',
    consequence: 'Total loss of coverage for an entire section of the corridor.',
    correctiveAction: 'DO NOT dispatch to individual camera poles. Check, in order: power to the zone cabinet; the zone switch and its port LEDs; the uplink back to the control room.',
    timeToRespond: 'Immediate',
  }),

  NET_SITE_OUTAGE: D({
    tag: 'NET_SITE_OUTAGE',
    name: 'Site-wide outage',
    class: CLASS.NETWORK,
    scope: 'system',
    priority: PRIORITY.CRITICAL,
    cause: 'A large fraction of the whole fleet stopped serving video at once — core switch, main fibre run, or site power.',
    consequence: 'Corridor-wide loss of surveillance coverage.',
    correctiveAction: 'Treat as control-room infrastructure. Check the core switch, main fibre and UPS before anything in the field. Escalate to the duty manager immediately.',
    timeToRespond: 'Immediate',
  }),

  NET_MONITOR_PATH_DOWN: D({
    tag: 'NET_MONITOR_PATH_DOWN',
    name: 'Monitoring network path lost',
    class: CLASS.NETWORK,
    scope: 'system',
    priority: PRIORITY.HIGH,
    cause: 'None of the configured network reference hosts are reachable from the monitoring host. The fault is on the monitoring side, not at the cameras.',
    consequence: 'Camera state cannot be determined. All devices are being reported as UNKNOWN rather than offline — deliberately, so the fleet is not falsely condemned.',
    correctiveAction: 'Check the monitoring host network connection, then its switch port and the path to the reference hosts.',
    timeToRespond: 'Immediate',
  }),

  /* ==================== SECURITY AND INVENTORY ==================== */

  SEC_ROGUE_DEVICE: D({
    tag: 'SEC_ROGUE_DEVICE',
    name: 'Unregistered device on the camera network',
    class: CLASS.SECURITY,
    scope: 'system',
    priority: PRIORITY.MEDIUM,
    escalates: true,
    cause: 'A subnet sweep found a device answering on camera ports that is not in the inventory.',
    consequence: 'Either an unmonitored camera — a coverage blind spot nobody knows about — or an unauthorised device on a network that should carry only cameras.',
    correctiveAction: 'Identify it. If it is a legitimate camera, add it to the inventory. If it is not, treat as a network security incident.',
    timeToRespond: '24 hours',
    autoClear: false,
    latching: true,
  }),

  INV_DEVICE_ADDED: D({
    tag: 'INV_DEVICE_ADDED',
    name: 'Camera added to monitoring',
    class: CLASS.INVENTORY,
    scope: 'device',
    priority: PRIORITY.DIAGNOSTIC,
    cause: 'A camera appeared in the inventory that was not there on the previous cycle.',
    consequence: 'None. Recorded so the device register has a complete audit trail.',
    correctiveAction: 'None required. Confirm the addition was intended.',
    timeToRespond: 'None',
    requiresAck: false,
    autoClear: false,
    latching: true,
  }),

  INV_DEVICE_REMOVED: D({
    tag: 'INV_DEVICE_REMOVED',
    name: 'Camera removed from monitoring',
    class: CLASS.INVENTORY,
    scope: 'device',
    priority: PRIORITY.LOW,
    cause: 'A camera that was being monitored is no longer in the inventory.',
    consequence: 'That camera is no longer watched. If the removal was accidental, its failures will go unnoticed indefinitely.',
    correctiveAction: 'Confirm the removal was intended. If not, re-import the inventory.',
    timeToRespond: '24 hours',
    autoClear: false,
    latching: true,
  }),

  /* =================== SYSTEM (the monitor itself) =================== */

  SYS_MONITOR_STALLED: D({
    tag: 'SYS_MONITOR_STALLED',
    name: 'MONITORING HAS STOPPED',
    class: CLASS.SYSTEM,
    scope: 'system',
    priority: PRIORITY.CRITICAL,
    cause: 'No monitoring cycle has completed within the staleness threshold. The service has stopped, hung, or the host has failed.',
    consequence: 'THE ENTIRE SYSTEM IS BLIND. Camera status shown on any screen is stale and must not be trusted. Cameras may be failing right now with nobody being told.',
    correctiveAction: 'On the monitoring host: Start-ScheduledTask -TaskName CorridorVision, then read logs/corridor-*.log for the cause, then run node src/cli.mjs doctor.',
    timeToRespond: 'Immediate',
    shelvable: false,     // never allow the watchdog itself to be silenced
    suppressible: false,
  }),

  SYS_DISK_LOW: D({
    tag: 'SYS_DISK_LOW',
    name: 'Monitoring host low on disk',
    class: CLASS.SYSTEM,
    scope: 'system',
    priority: PRIORITY.HIGH,
    cause: 'Free space on the monitoring host has fallen below the threshold.',
    consequence: 'At zero, history, the alarm register and the delivery queue all stop being written — the system keeps running but stops remembering anything.',
    correctiveAction: 'Clear space. Reduce retention in config if the growth is from monitoring data itself.',
    timeToRespond: '4 hours',
  }),

  SYS_CYCLE_OVERRUN: D({
    tag: 'SYS_CYCLE_OVERRUN',
    name: 'Probe cycle overrunning its interval',
    class: CLASS.SYSTEM,
    scope: 'system',
    priority: PRIORITY.LOW,
    cause: 'A probe cycle took longer than the configured interval — too many cameras for the concurrency setting, or many cameras timing out at once.',
    consequence: 'The effective probe interval is longer than configured, so detection is slower than expected.',
    correctiveAction: 'Raise monitor.concurrency, or raise monitor.intervalSec to match reality.',
    timeToRespond: '7 days',
  }),

  SYS_CHANNEL_FAIL: D({
    tag: 'SYS_CHANNEL_FAIL',
    name: 'Alert channel failing to deliver',
    class: CLASS.SYSTEM,
    scope: 'system',
    priority: PRIORITY.CRITICAL,
    cause: 'An alert channel has failed repeatedly and messages are backing up in the delivery queue.',
    consequence: 'ALARMS ARE NOT REACHING PEOPLE. The system is detecting faults correctly and nobody is hearing about them — the most dangerous silent failure an alarm system has.',
    correctiveAction: 'Open the dashboard Alerts tab for the error against each attempt. For WhatsApp Cloud, an expired token or a lapsed 24-hour window is the usual cause.',
    timeToRespond: 'Immediate',
    shelvable: false,
  }),

  SYS_MONITOR_STARTED: D({
    tag: 'SYS_MONITOR_STARTED',
    name: 'Monitoring service started',
    class: CLASS.SYSTEM,
    scope: 'system',
    priority: PRIORITY.DIAGNOSTIC,
    cause: 'The service started, either at boot or after a restart.',
    consequence: 'None, unless it was not expected — an unexplained restart warrants checking the log.',
    correctiveAction: 'None required.',
    timeToRespond: 'None',
    requiresAck: false,
    autoClear: false,
    latching: true,
  }),

  SYS_COVERAGE_GAP: D({
    tag: 'SYS_COVERAGE_GAP',
    name: 'Monitoring coverage gap',
    class: CLASS.SYSTEM,
    scope: 'system',
    priority: PRIORITY.MEDIUM,
    cause: 'Monitoring resumed after a period during which it was not running.',
    consequence: 'Camera state during that window was never observed. Availability figures for the period are incomplete, and any outage that began and ended inside it is unrecorded.',
    correctiveAction: 'Record the gap in the shift log. Treat availability figures covering it as qualified rather than authoritative.',
    timeToRespond: '24 hours',
    autoClear: false,
    latching: true,
  }),

  /* ========================= AVAILABILITY ========================= */

  SLA_DAILY_BREACH: D({
    tag: 'SLA_DAILY_BREACH',
    name: 'Daily availability below target',
    class: CLASS.AVAILABILITY,
    scope: 'system',
    priority: PRIORITY.LOW,
    cause: 'Fleet availability over the day fell below the configured target.',
    consequence: 'A contractual or internal service level has been missed for the period.',
    correctiveAction: 'Review the worst-performing cameras in the report and raise jobs for the repeat offenders — a handful of devices usually account for most of the loss.',
    timeToRespond: '24 hours',
    autoClear: false,
    latching: true,
  }),

  SLA_DEVICE_BREACH: D({
    tag: 'SLA_DEVICE_BREACH',
    name: 'Camera availability below target',
    class: CLASS.AVAILABILITY,
    scope: 'device',
    priority: PRIORITY.LOW,
    cause: 'One camera fell below its availability target over the reporting period, through repeated short outages rather than one long one.',
    consequence: 'Intermittent coverage loss. Devices that fail this way are usually about to fail permanently.',
    correctiveAction: 'Schedule replacement rather than repeated attendance — the cumulative visit cost normally exceeds the camera.',
    timeToRespond: '7 days',
    autoClear: false,
    latching: true,
  }),

  /* ============= ALARM SYSTEM (EEMUA self-monitoring) ============= */

  ALM_FLOOD: D({
    tag: 'ALM_FLOOD',
    name: 'Alarm flood',
    class: CLASS.ALARM_SYSTEM,
    scope: 'system',
    priority: PRIORITY.HIGH,
    cause: 'More alarms were raised in a ten-minute period than an operator can process — the EEMUA 191 flood threshold.',
    consequence: 'Operators cannot triage at this rate. During a flood the important alarm is statistically likely to be missed, which is how alarm systems fail in practice.',
    correctiveAction: 'Look for the common cause first: a flood is nearly always one fault, not many. Check for a zone or site event before responding to individual alarms.',
    timeToRespond: 'Immediate',
  }),

  ALM_CHATTERING: D({
    tag: 'ALM_CHATTERING',
    name: 'Chattering alarm',
    class: CLASS.ALARM_SYSTEM,
    scope: 'device',
    priority: PRIORITY.LOW,
    cause: 'One alarm repeatedly raised and cleared within a short window — a measurement sitting on its threshold, or genuinely unstable equipment.',
    consequence: 'Nuisance traffic that trains operators to ignore the annunciator. EEMUA 191 identifies chattering alarms as a principal cause of alarm-system failure.',
    correctiveAction: 'Fix the underlying instability, or widen the threshold or confirmation count for this condition. Do not simply shelve it — shelving hides the symptom and keeps the cause.',
    timeToRespond: '7 days',
  }),

  ALM_STANDING: D({
    tag: 'ALM_STANDING',
    name: 'Standing alarm',
    class: CLASS.ALARM_SYSTEM,
    scope: 'device',
    priority: PRIORITY.LOW,
    cause: 'An alarm has been active and unresolved beyond the standing-alarm threshold.',
    consequence: 'It has become background noise on the display, degrading the value of every other alarm shown alongside it. EEMUA 191 targets fewer than five standing alarms at any time.',
    correctiveAction: 'Resolve it, or shelve it with an expiry and a stated reason. Leaving it standing indefinitely is the outcome to avoid.',
    timeToRespond: '7 days',
  }),

  ALM_SHELF_EXPIRED: D({
    tag: 'ALM_SHELF_EXPIRED',
    name: 'Shelved alarm returned to service',
    class: CLASS.ALARM_SYSTEM,
    scope: 'device',
    priority: PRIORITY.DIAGNOSTIC,
    cause: 'A shelved alarm reached its expiry and was automatically returned to service, and its condition is still present.',
    consequence: 'The alarm will annunciate again. This is the intended behaviour: shelving is temporary by design so nothing is silenced permanently by accident.',
    correctiveAction: 'Resolve the underlying condition, or re-shelve it with a stated reason if work is still in progress.',
    timeToRespond: '24 hours',
    requiresAck: false,
    autoClear: false,
    latching: true,
  }),
};

/** Every tag, sorted. */
export const TAGS = Object.keys(CATALOG).sort();

export function getAlarmDef(tag) {
  const def = CATALOG[tag];
  if (!def) throw new Error(`Unknown alarm tag "${tag}". Valid tags: ${TAGS.join(', ')}`);
  return def;
}

export const severityForPriority = (priority) => PRIORITY_SEVERITY[priority] ?? 'warning';

/**
 * Priority composition of the catalogue.
 *
 * A word on the famous ISA-18.2 / EEMUA 191 target of roughly 80% low, 15% medium,
 * 5% high-or-above: **it applies to annunciated alarm traffic, not to the catalogue.**
 * Scoring a catalogue against it is a category error — a catalogue legitimately holds
 * rare critical conditions that should almost never occur, and if they never occur they
 * contribute nothing to traffic. `alarmKpis()` measures the real distribution, against
 * the real target, from what was actually raised.
 *
 * What this function is for is design review: a catalogue heavily weighted to high and
 * critical is a sign that conditions were not properly rationalised, because a designer
 * who marks everything urgent has decided nothing is. It is reported as information,
 * with no pass/fail.
 */
export function priorityDistribution(catalog = CATALOG) {
  const defs = Object.values(catalog).filter((d) => d.priority !== PRIORITY.DIAGNOSTIC);
  const counts = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const d of defs) counts[d.priority] = (counts[d.priority] ?? 0) + 1;
  const total = defs.length || 1;
  const pct = (n) => Math.round((n / total) * 1000) / 10;
  return {
    total,
    diagnostic: Object.values(catalog).length - total,
    counts,
    percentages: {
      low: pct(counts.low), medium: pct(counts.medium),
      high: pct(counts.high), critical: pct(counts.critical),
    },
    note: 'Composition of the catalogue. The ISA-18.2 80/15/5 target applies to annunciated traffic and is measured in the alarm KPI section, not here.',
  };
}

/** Group the catalogue by functional class, for the report appendix. */
export function byClass(catalog = CATALOG) {
  const out = new Map();
  for (const def of Object.values(catalog)) {
    const list = out.get(def.class) ?? [];
    list.push(def);
    out.set(def.class, list);
  }
  for (const list of out.values()) list.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.tag.localeCompare(b.tag));
  return out;
}
