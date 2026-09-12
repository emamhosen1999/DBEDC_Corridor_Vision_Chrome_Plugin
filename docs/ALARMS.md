# Alarm management and reporting

Corridor Vision manages alarms to **ISA-18.2 / IEC 62682** and measures itself against
**EEMUA 191**. This document is the alarm philosophy: what the standards require, what
this system does about it, and how to operate it.

---

## Why a standard at all

The instinct when building a monitor is to alert on everything and let operators sort
it out. Every alarm-management standard exists because that approach has failed, in
public, repeatedly — Texas City, Milford Haven, Three Mile Island. The finding is
always the same: operators were not short of information, they were **buried** in it,
and the one alarm that mattered was indistinguishable from the three hundred that did
not.

So the counter-intuitive premise underneath everything below:

> **The performance of an alarm system is measured by how FEW alarms it produces.**

A system emitting 400 alarms a shift has not detected more problems than one emitting
12. It has made itself unreadable.

The previous Chrome extension had no alarm management at all: every state change became
a desktop toast, immediately, forever. On a flapping PoE uplink that is several hundred
notifications a day, and the rational operator response is to mute it. At that point the
product is worse than nothing, because it has trained its users to ignore it.

---

## The alarm catalogue

37 alarm types across ten functional classes. Every one carries the four things
ISA-18.2 calls *rationalisation* — and an alarm that cannot answer all four should not
exist:

| Field | Question it answers |
|---|---|
| **cause** | Why did this happen? |
| **consequence** | What is lost if I ignore it? |
| **correctiveAction** | What do I actually do? |
| **timeToRespond** | How long have I got? |

Those fields are not documentation — they are shipped in the alarm message itself:

```
🚨 CRITICAL — Zone communication loss — all cameras: Zone 3 - Bhulta

🚨 *Zone communication loss — all cameras* — Zone 3 - Bhulta
   All 12 cameras in Zone 3 - Bhulta are unreachable — one shared fault,
   not 12 separate camera faults.
   ➤ DO NOT dispatch to individual camera poles. Check, in order: power to the
     zone cabinet; the zone switch and its port LEDs; the uplink back to the
     control room.
   ⏱ Respond within: Immediate
```

Browse the full catalogue:

```powershell
node src\cli.mjs alarms --catalog            # list
node src\cli.mjs alarms --catalog --verbose  # with cause, action and response time
```

### Classes

| Class | Tags | Covers |
|---|---|---|
| communication | 7 | reachability, credentials, instability, latency, restarts, sustained outage |
| video | 8 | stream failure, black, frozen, tamper, overexposure, codec and resolution drift |
| storage | 2 | SD/disk failure, near-full |
| time | 2 | clock drift, NTP loss |
| network | 3 | zone dark, site-wide outage, monitoring path lost |
| security | 1 | unregistered device on the camera network |
| inventory | 2 | cameras added to / removed from monitoring |
| system | 6 | monitor stalled, disk low, cycle overrun, **alert channel failing**, coverage gap |
| availability | 2 | daily and per-device SLA breach |
| alarm-system | 4 | flood, chattering, standing, shelf expiry |

### Priorities

ISA-18.2's five levels. Only four conditions are **critical**, and that restraint is
the point — if everything is urgent, nothing is:

| Tag | Why it is critical |
|---|---|
| `NET_SITE_OUTAGE` | Corridor-wide loss of coverage |
| `NET_ZONE_DOWN` | An entire zone dark — one infrastructure fault |
| `SYS_MONITOR_STALLED` | **The system is blind and everything on screen is stale** |
| `SYS_CHANNEL_FAIL` | **Alarms are being detected and are not reaching anyone** |

The last two are about the alarm system itself, and neither can be shelved or
suppressed. A monitor that can be silenced about its own failure is not a monitor.

---

## The alarm lifecycle

The distinction the state machine enforces, which most home-grown monitors miss:

> A **condition** is a fact about the world. An **alarm** is an annunciated demand for
> operator action. They have different lifetimes.

A camera that came back online no longer has the condition — but if nobody ever
acknowledged the alarm, the alarm is not finished. Somebody still needs to know it
happened.

```
     ┌─────────┐  condition raised   ┌──────────────┐
     │ NORMAL  │────────────────────▶│ UNACK_ALARM  │
     └─────────┘                     └──────┬───────┘
          ▲                     ack  ┌──────┴──────┐  condition clears
          │                          ▼             ▼
          │                   ┌────────────┐  ┌────────────┐
          │  condition clears │ ACK_ALARM  │  │ RTN_UNACK  │
          ├───────────────────┤            │  │            │
          │                   └────────────┘  └─────┬──────┘
          └──────────────────────────────────────────┘  ack
```

**`RTN_UNACK` is the state that matters.** A camera that dropped at 03:00 and recovered
at 03:04 has no condition by the time the morning shift arrives — but the alarm sits in
`RTN_UNACK` on the annunciator until somebody acknowledges having seen it. Without that
state, short overnight outages vanish before anyone knows they happened.

Plus three deliberate holds:

| State | Who sets it | Expires |
|---|---|---|
| `SHELVED` | An operator, with a **mandatory reason** | **Always** — capped at `alarms.maxShelveHours` |
| `SUPPRESSED_BY_DESIGN` | A maintenance window in config | When the window closes |
| `OUT_OF_SERVICE` | Maintenance, explicitly | Never — until returned explicitly |

### Shelving always expires

This is deliberate and not configurable away. Permanent silence is how alarm systems
rot: someone shelves a nuisance alarm on a night shift, nobody remembers, and two years
later the condition it was hiding causes the incident. Every shelf here carries an
expiry and a stated reason, and its expiry raises its own diagnostic alarm so the
un-shelving is visible rather than silent.

---

## Noise control

Seven mechanisms, each of which exists because its absence broke something:

| Mechanism | What it stops |
|---|---|
| **Confirmation** (`detect.confirmDownCycles`) | One slow response paging the operator |
| **Flap suppression** | A failing patch lead generating 400 alerts a day |
| **Coalescing** | A switch reboot sending 12 messages about one fault |
| **Mass-outage rollup** | 60 "camera offline" alerts burying "the zone is dark" |
| **Quiet hours** | Routine chatter at 02:00 (criticals always override) |
| **Maintenance windows** | Planned work paging the duty roster |
| **Rate limiting** | Any single hour drowning the channel |

The rate limiter **announces itself** rather than going quiet — a channel that silently
stops delivering is indistinguishable from a healthy fleet, which is the exact failure
this system is built to prevent.

Coalescing is keyed by type **and priority**, so a critical alarm is never merged into
a batch of low-priority ones and rendered under their headline.

---

## EEMUA 191 performance metrics

Published targets, per operator position, all measured over the reporting period:

| Metric | Target | Meaning |
|---|---|---|
| Average alarm rate | ≤ 6/hour | "acceptable"; ≤ 12/hour is "manageable" |
| Peak in any 10 minutes | ≤ 10 | Above this is a flood |
| Time in flood | < 1% | Operators cannot triage during a flood |
| Standing alarms | < 5 | Active >24h; they become wallpaper |
| Top 10 contributors | ≤ 5% of load | High concentration = a few fixes solve most noise |
| Priority mix | ~80/15/5 low/med/high+ | Applies to **traffic**, not the catalogue |

```powershell
node src\cli.mjs alarms          # annunciator + 24h KPI summary
```

Also on the dashboard **Alarms** tab, and in section 8 of every periodic report.

> **On the 80/15/5 target:** it applies to annunciated alarm *traffic*, not to catalogue
> composition. Scoring a catalogue against it is a category error — a catalogue
> legitimately holds rare critical conditions that should almost never fire, and if
> they never fire they contribute nothing to traffic. The catalogue's composition is
> reported as information for design review, with no pass/fail. The KPI section
> measures the real distribution from what was actually raised.

---

## Operator actions

### Dashboard

**Alarms** tab: every alarm shows its priority, subject, state, how long it has been
active, its **required action** and its **consequence if ignored**.

- **Acknowledge** — you have seen it
- **Acknowledge all** — clears the annunciator (asks for an optional note)
- **Shelve** — temporary silence; **a reason is required** and it always expires
- **Return to service** — un-shelve early

### API

```bash
curl localhost:8477/api/alarms                       # the annunciator
curl localhost:8477/api/alarms?scope=all             # the whole register
curl localhost:8477/api/alarms/kpi?hours=24          # EEMUA metrics
curl localhost:8477/api/alarms/catalog               # the rationalised catalogue

curl -X POST localhost:8477/api/alarms/ack \
     -H 'Content-Type: application/json' \
     -d '{"key":"VID_FROZEN:cam-12","by":"shift-a"}'

curl -X POST localhost:8477/api/alarms/shelve \
     -H 'Content-Type: application/json' \
     -d '{"key":"CAM_UNSTABLE:cam-04","hours":4,"reason":"contractor on site"}'
```

### Maintenance windows

Suppression by design, scoped by zone, camera or alarm tag. Times are **UTC**:

```jsonc
"alerts": {
  "maintenance": [
    { "name": "Zone 3 recabling",
      "from": "2026-09-20T22:00:00Z",
      "to":   "2026-09-21T04:00:00Z",
      "groups": ["Zone 3 - Bhulta"] },

    { "name": "Firmware rollout — reboots expected",
      "from": "2026-09-22T20:00:00Z",
      "to":   "2026-09-22T23:00:00Z",
      "tags": ["CAM_REBOOT", "CAM_COMM_LOSS"] }
  ]
}
```

---

# The periodic report

## What it is

A **complete device register** issued on a schedule, not a list of what is broken.
That distinction is the whole point:

> A report that lists only faults answers "what is broken". It does not answer "what
> was checked". Only the second is evidence of coverage.

If a camera silently vanished from the inventory a month ago, only a full register
shows it. The report therefore lists **every device**, including ones that are
healthy, never probed, excluded, or orphaned.

## Structure

| § | Section | Contents |
|---|---|---|
| — | Header | Report ID, site, period, issue time, timezone |
| 1 | Executive summary | Findings in prose, not numbers |
| 2 | Fleet status | Counts and per-zone rollup |
| 3 | Alarm summary | Raised, cleared, outstanding, held, by priority |
| 4 | Zone breakdown | Per-zone availability and outage count |
| 5 | Action required | Every exception, with its finding |
| 6 | **Device register** | **Every device**, grouped by zone |
| 7 | Availability | Fleet %, per-camera worst performers, daily rows |
| 8 | Alarm system performance | EEMUA 191 metrics with verdicts |
| 9 | Monitoring system health | Coverage gaps, staleness, last cycle |

### Report identity

`CV-DBE-20260912-003` — site code, local date, sequence number for the day.

The sequence is **persisted**, so a gap in it is evidence that a scheduled report was
missed. That is exactly what an auditor asks about. Previews are labelled `-PREVIEW`
and never consume a number, so glancing at the dashboard does not punch holes in the
audit trail.

### If monitoring was not running

A report generated while the monitor is stale describes **history, not now**, and says
so as the first line of the summary:

```
MONITORING STALE — report describes last known state

🚨 MONITORING IS NOT CURRENT. This report describes the last known state, not
   the present one. Camera status below must not be relied upon until monitoring
   is restored.
```

A report covering a period with a coverage gap is likewise qualified, because
availability figures across an unobserved window are incomplete.

## Formats

| Format | Where it goes | Contains |
|---|---|---|
| **text** | WhatsApp, Telegram, Slack | Everything, chunked on section boundaries and labelled `part n of m` |
| **html** | Email, dashboard, print | Everything, styled, self-contained, print-ready |
| **csv** | Spreadsheet | One row per device — always the complete register |
| **alarm-csv** | Spreadsheet | The alarm log |
| **json** | Another system | The whole model |

All four are written to disk as the **report of record** under
`data/exports/reports/<date>/`, retained for `reporting.retentionDays` (default 365).

## Scheduling

```jsonc
"reporting": {
  "enabled": true,
  "mode": "times",                       // or "interval"
  "times": ["06:00", "14:00", "22:00"],  // site-local wall clock
  "intervalMinutes": 360,                // used when mode is "interval"
  "fullRegister": true,                  // every device in the text report
  "formats": ["text", "html", "csv", "json"],
  "channels": [],                        // empty = every enabled channel
  "maxChars": 3500,                      // chat message size before splitting
  "retentionDays": 365,
  "sendWhenHealthy": true
}
```

**Catch-up without spam:** if the service was down across two scheduled slots, it does
not fire two reports on restart. It issues one covering the whole elapsed period and
says in the report that coverage was interrupted. Reporting a period you were not
watching as though you were is worse than not reporting it.

**Keep `sendWhenHealthy: true`.** A report that only arrives when there is bad news is
indistinguishable from a dead monitor. The regular arrival of a boring report is itself
the evidence that the system is alive.

## Commands

```powershell
node src\cli.mjs reports                            # preview, text, last 6 hours
node src\cli.mjs reports --format html --hours 24   # preview another format
node src\cli.mjs reports --list                     # reports of record
node src\cli.mjs reports --read CV-DBE-20260912-003 --format text
node src\cli.mjs reports --issue                    # issue and file it (does NOT send)
```

`--issue` deliberately does not send. A CLI run should not silently page the whole duty
roster; sending is the service's job, or an explicit action on the dashboard.

---

## Recommended starting configuration

Tuned to be quiet enough to be read and loud enough to matter:

```jsonc
{
  "detect": { "confirmDownCycles": 2, "flapCount": 4, "flapWindowMin": 30 },
  "alarms": {
    "operatorPositions": 1,
    "standingAfterHours": 24,
    "maxShelveHours": 24,
    "annunciateAtOrAbove": "low"
  },
  "alerts": {
    "minSeverity": "warning",
    "coalesceSec": 90,
    "maxPerHour": 30,
    "escalation": [
      { "afterMin": 60,   "severity": "critical", "label": "Down 1 hour" },
      { "afterMin": 360,  "severity": "critical", "label": "Down 6 hours" },
      { "afterMin": 1440, "severity": "critical", "label": "Down 24 hours" }
    ]
  },
  "reporting": { "enabled": true, "mode": "times", "times": ["06:00", "14:00", "22:00"] }
}
```

Review the KPI section of the report after a week. If the alarm rate is above 6/hour,
the answer is almost never "raise the threshold" — look at the top contributors first.
A handful of conditions normally produce most of the load, and fixing those fixes the
alarm system.
