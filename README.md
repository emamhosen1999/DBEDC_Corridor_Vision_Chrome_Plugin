# DBEDC Corridor Vision

**24/7 CCTV health monitoring for the Dhaka Bypass Expressway corridor.**
A standalone Windows service that probes every camera directly, detects failures the
VMS cannot see, and pushes alerts to WhatsApp, Telegram, email and webhooks.

No browser. No AIV-MP login. No open tab to babysit.

---

## Why this replaced the Chrome extension

The previous tool was a Chrome extension that scraped the AIV-MP platform through a
logged-in browser tab. [`docs/AUDIT.md`](docs/AUDIT.md) documents 47 specific defects
in it, but they all descend from one structural problem:

> You were asking the video-management server to tell you when the video system was
> broken — through a browser tab a human had to keep open.

When a core switch fails, AIV-MP and the cameras go dark **together**. The extension's
response was to write `lastError` and set a small grey badge. Nobody was told anything.

Corridor Vision probes the cameras themselves, runs as a Windows service that starts
before anyone logs in, and — critically — **alerts when it can no longer see the
cameras**, including when the fault is its own.

### What it catches that AIV-MP structurally cannot

| Failure | AIV-MP says | Corridor Vision says |
|---|---|---|
| Camera loses power | Offline | **Offline** — "check power, PoE and cabling" |
| Zone switch dies | 12× Offline | **One alert**: "Entire zone dark — this is one fault, not twelve" |
| Encoder wedged, box still pings | ✅ Online | **Degraded** — "reachable, but RTSP is not serving video" |
| Stream serves, image is black | ✅ Online | **Degraded** — "image black (luma 3.2)" |
| Stream serves, frame is frozen | ✅ Online | **Degraded** — "image frozen for 3 cycles" |
| Lens fogged or sprayed | ✅ Online | **Degraded** — "image flat (variance 1.4)" |
| SD card failed, recording nothing | ✅ Online | **Warning** — "storage sd1: abnormal" |
| Clock drifted 40 minutes | ✅ Online | **Warning** — "clock drift 2400s — footage will carry the wrong time" |
| Camera silently reverted to D1 | ✅ Online | **Warning** — "resolution changed: expected 1920x1080, serving 704x576" |
| **The monitor itself dies** | *(silence)* | **🚨 MONITORING HAS STOPPED — status is stale, do not trust it** |

---

## Quick start

Requires **Node.js 20.11 or newer** on the monitoring PC. No other dependencies —
no database, no Docker, no native modules, no internet needed to install.

```powershell
# One-command setup: checks the environment, writes a starting config,
# and runs the self-test. Safe to re-run; never overwrites what you have.
Set-ExecutionPolicy -Scope Process Bypass -Force
.\scripts\setup.ps1
```

Then:

```powershell
# 1. Get your camera list. Easiest route: open AIV-MP, use the old extension's
#    CSV export, and save it as cameras.csv. Any spreadsheet with an IP column works.
node src\cli.mjs import --csv cameras.csv

# 2. Store the camera credentials (encrypted; never written to config.json)
node src\cli.mjs secret set cameras.username admin
node src\cli.mjs secret set cameras.password "your-camera-password"

# 3. Check everything before committing to unattended operation
node src\cli.mjs selftest      # proves the pipeline works on THIS machine
node src\cli.mjs doctor        # checks YOUR configuration and network

# 4. Run it
node src\cli.mjs run
#    → dashboard at http://127.0.0.1:8477

# 5. Install as a boot-time Windows service (elevated PowerShell)
.\scripts\install-task.ps1
```

Don't have a camera list? Find them:

```powershell
node src\cli.mjs discover --cidr 192.168.10.0/24
```

---

## How a camera is judged

Six layers, cheapest first. Each only runs if a cheaper one was inconclusive, so the
ladder scales to hundreds of cameras on a one-minute cycle.

| # | Layer | Cost | What it proves |
|---|---|---|---|
| 0 | **ICMP** | ~1 ms | Advisory only. Rising RTT warns of a saturating uplink. **Never** decides a camera is down — plenty of VLANs drop echo. |
| 1 | **TCP connect** | ~2 ms | Something is listening. `ECONNREFUSED` (host alive, service dead) is reported differently from a timeout (power/cable/switch). |
| 2 | **ONVIF** `GetSystemDateAndTime` | ~30 ms | The service stack is alive and parsing XML — not just that a port accepts connections. Needs **no credentials**, so it survives a password rotation. Also exposes clock drift. |
| 3 | **RTSP `DESCRIBE`** | ~60 ms | **The video actually serves.** Returns the SDP, so codec and resolution drift are caught too. |
| 4 | **Vendor health API** | ~80 ms | Uniview LAPI / Hikvision ISAPI / Dahua CGI: storage state, NTP sync, uptime, firmware. |
| 5 | **Snapshot analysis** | ~300 ms | Every *N*th cycle. Pulls a JPEG and measures it: black, flat, or frozen. |

### Verdicts

- **`up`** — reachable and serving video.
- **`degraded`** — reachable, but *not usable*. The camera is effectively lying about
  its health. This is the class AIV-MP cannot report at all.
- **`down`** — no authoritative layer could reach it.
- **`unknown`** — *we* could not tell. **Never reported as `down`.** If the monitoring
  PC loses its uplink, every camera goes `unknown`, not offline. Blaming 500 cameras
  for your own network fault is how a monitor permanently loses its credibility.

### How image analysis works

No image library, no native dependency — just the JPEG's DC coefficients, which *are*
each 8×8 block's mean luminance. Decoding DC only yields a ⅛-scale thumbnail almost
free, and from it:

- **mean luma** → a black frame (IR cut filter stuck, dead sensor, lens cap)
- **variance** → a flat frame (lens covered, fogged, painted, facing a wall)
- **perceptual hash** → a frozen frame (identical picture *N* cycles running)

Validated against reference images: a true-black frame measures `0.0`, mid-grey
`128.0`, white `255.0` (`tests/core.test.mjs`).

---

## Alarms and reporting

Alarm management follows **ISA-18.2 / IEC 62682**; alarm-system performance is measured
against **EEMUA 191**. Full detail in [`docs/ALARMS.md`](docs/ALARMS.md).

### The two things this gives you

**1. A regular all-device report.** Every device, on a schedule, in four formats.
Not a list of what is broken — a complete register, because *"what is broken"* and
*"what was checked"* are different questions and only the second evidences coverage.

**2. A real alarm system.** 37 rationalised alarm types with an acknowledgement
lifecycle, shelving, suppression and self-measurement — not a stream of notifications
that scroll away unread.

### Alarm catalogue

37 types across ten classes. Every one carries its **cause**, **consequence**,
**corrective action** and **time to respond** — and those ship in the message, not just
the docs:

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

| Class | Types | Covers |
|---|---|---|
| communication | 7 | reachability, credentials, flapping, latency, restarts, sustained outage |
| video | 8 | stream failure, black, frozen, tamper, overexposure, codec/resolution drift |
| storage | 2 | SD/disk failure, near-full |
| time | 2 | clock drift, NTP loss |
| network | 3 | zone dark, site-wide outage, monitoring path lost |
| security | 1 | unregistered device on the camera network |
| inventory | 2 | cameras added to / removed from monitoring |
| system | 6 | monitor stalled, disk low, cycle overrun, **alert channel failing** |
| availability | 2 | daily and per-device SLA breach |
| alarm-system | 4 | flood, chattering, standing, shelf expiry |

Only **four** conditions are critical — site outage, zone dark, monitoring stalled, and
alarms failing to be delivered. Neither of the last two can be shelved or suppressed: a
monitor that can be silenced about its own failure is not a monitor.

```powershell
node src\cli.mjs alarms --catalog --verbose   # the whole rationalised catalogue
node src\cli.mjs alarms                       # annunciator + EEMUA KPIs
```

### Alarm lifecycle

`NORMAL → UNACK_ALARM → ACK_ALARM → NORMAL`, plus `RTN_UNACK` for an alarm that cleared
before anyone saw it — a camera that dropped at 03:00 and recovered at 03:04 stays on
the annunciator until the morning shift acknowledges it. Without that state, short
overnight outages vanish before anyone knows they happened.

Shelving requires a **stated reason** and **always expires** (capped, default 24h).
Permanent silence is how alarm systems rot.

### Alarm system performance — EEMUA 191

Measured every reporting period, with verdicts:

| Metric | Target |
|---|---|
| Average alarm rate | ≤ 6/hour per operator |
| Peak in any 10 minutes | ≤ 10 |
| Time in alarm flood | < 1% |
| Standing alarms | < 5 |
| Top 10 contributors | ≤ 5% of load |

The premise, which is counter-intuitive and load-bearing: **an alarm system is measured
by how few alarms it produces.** 400 alarms a shift is not more detection, it is an
unreadable system whose users have learned to ignore it.

### The periodic report

| § | Section |
|---|---|
| 1 | Executive summary — findings in prose, not numbers |
| 2 | Fleet status and per-zone rollup |
| 3 | Alarm summary — raised, cleared, outstanding, held, by priority |
| 4 | Zone breakdown |
| 5 | Action required — every exception with its finding |
| 6 | **Device register — every device** |
| 7 | Availability — fleet %, worst performers, daily rows |
| 8 | Alarm system performance (EEMUA 191) |
| 9 | Monitoring system health — coverage gaps, staleness |

Issued as `CV-DBE-20260912-003`: site code, local date, sequence number. The sequence is
persisted, so **a gap in it is evidence a report was missed**. Text goes to chat
(chunked on section boundaries), HTML to email and print, CSV to spreadsheets, JSON to
other systems — all four filed as the report of record.

A report generated while monitoring is stale says so as its **first line**, because it
is describing history, not now.

```jsonc
"reporting": {
  "enabled": true,
  "mode": "times",
  "times": ["06:00", "14:00", "22:00"],
  "fullRegister": true,
  "formats": ["text", "html", "csv", "json"],
  "sendWhenHealthy": true      // keep this on — see below
}
```

Keep `sendWhenHealthy: true`. A report that only arrives when there is bad news is
indistinguishable from a dead monitor; the regular arrival of a boring report is itself
the evidence the system is alive.

```powershell
node src\cli.mjs reports                    # preview
node src\cli.mjs reports --list             # reports of record
node src\cli.mjs reports --issue            # issue and file (does not send)
```

### Notification types

| Type | Severity | Raised when |
|---|---|---|
| `camera.down` / `camera.up` | warning / info | Confirmed outage and recovery |
| `camera.degraded` / `camera.recovered` | warning / info | Reachable but not serving usable video |
| `camera.flapping` / `camera.stable` | warning / info | Repeated state changes, then settling |
| `camera.escalation` | **critical** | Still down after 1 h / 6 h / 24 h |
| `site.groupDown` | **critical** | An entire zone is dark — one fault, not many |
| `site.massOutage` | **critical** | ≥25% of the fleet is not serving video |
| `monitor.stalled` | **critical** | **The monitor itself has stopped** |
| `monitor.recovered` | info | Monitoring resumed, naming the coverage gap |
| `monitor.networkDown` / `Up` | critical / info | Our own network path failed |
| `monitor.diskLow` | **critical** | The monitoring PC is running out of disk |
| `inventory.added` / `removed` | info | A camera appeared in or vanished from the inventory |
| `sla.breach` | warning | Daily availability fell below target |
| `digest.scheduled` | info | Scheduled status digest |
| `report.scheduled` | info | The periodic all-device report |
| `alarm.raised` / `cleared` | per priority | Alarm register annunciations |

### Noise control

An alerting system's real failure mode is not missing an alert — it is sending so many
that people stop reading them. Seven mechanisms, all configurable:

1. **Confirmation** — a state change must persist for *N* cycles (default 2). One slow
   response never pages anyone.
2. **Flap suppression** — >4 changes in 30 min raises *one* "unstable" alert, then goes
   quiet until it settles.
3. **Coalescing** — alerts raised together merge into one message. A switch reboot
   sends one message about twelve cameras, not twelve messages.
4. **Mass-outage rollup** — a whole zone down becomes a single "entire zone dark"
   alert naming the likely cause.
5. **Quiet hours** — overnight suppression, with criticals overriding.
6. **Maintenance windows** — planned work suppresses alerts by zone, camera or site.
7. **Rate limiting** — a per-channel hourly cap. Criticals are never capped, and the
   channel is *told* it is being limited rather than going silently quiet.

### Channels

| Channel | Real groups? | Needs | Notes |
|---|---|---|---|
| **WhatsApp — Meta Cloud API** | ✅ max 8 | Official Business Account | **Recommended for you.** Official and supported; nothing to keep linked. Read the 24-hour window note below — it decides whether your 3am alarms arrive. |
| **WhatsApp — GREEN API** | ✅ | Account, QR link | Hosted gateway, unlimited group size. |
| **WhatsApp — WAHA** | ✅ | Docker on your own box | Self-hosted, free, data stays in-house. |
| **WhatsApp — Web automation** | ✅ | `npm i whatsapp-web.js` | Zero infrastructure. **Unofficial** — see below. |
| **WhatsApp — CallMeBot** | ❌ | Nothing | Free, individual numbers only, personal use. |
| **Telegram** | ✅ | A bot token | Free, instant, and it does not break. **Enable this as a backup.** |
| **Slack / Teams / Discord** | ✅ | An incoming webhook | |
| **Email (SMTP)** | — | Mail server | Implemented directly on a socket; no dependency. |
| **Generic webhook** | — | A URL | HMAC-signed. Wire into n8n, Make, a ticketing system, an SMS gateway. |
| **Windows toast** | — | — | See the session-0 caveat below. |
| **Dashboard** | — | — | SSE push + browser notification. Always works. |

#### WhatsApp Cloud API — the 24-hour window will bite you

You have an Official Business Account and an 8-person group is acceptable, so the Cloud
API is the right primary route: official, supported, no QR session to keep alive.

**But read this before relying on it.** Meta only delivers free-form text inside a
24-hour *customer service window*, opened by someone messaging the business number.
A monitoring system raises its most important alarms at 03:00, long after that window
has lapsed — and Meta **rejects** those with error 131047 rather than delivering them.
A monitor whose alerts are silently refused overnight is worse than no monitor.

The fix is an approved **message template**, which is delivered at any time. This
channel sends free-form text and, on a window rejection, automatically re-sends the same
alert as a template. Configure one and the 3am alarm arrives; skip it and it will not —
`doctor` warns you about exactly this.

Create it in WhatsApp Manager → Message templates, category **UTILITY**, with a body of
exactly one variable:

```
Corridor Vision alert:

{{1}}
```

Then:

```powershell
node src\cli.mjs secret set whatsappCloud.accessToken "<token>"
node src\cli.mjs wa-groups                      # list groups and read the group id
node src\cli.mjs test-alert --channel whatsappCloud
```

```jsonc
"whatsappCloud": {
  "enabled": true,
  "phoneNumberId": "<from Meta App → WhatsApp → API Setup>",
  "accessToken": "@vault:whatsappCloud.accessToken",
  "to": "<group id from wa-groups>",
  "recipientType": "group",
  "template": { "name": "corridor_alert", "languageCode": "en" }
}
```

**Also enable Telegram.** It costs nothing, has no messaging window, no template
approval and no participant cap, and it is the channel that will still be delivering
when WhatsApp has a bad week. Treating one vendor as a single point of failure for
alerting is the same mistake as trusting one server to report its own death.

```powershell
node src\cli.mjs secret set telegram.botToken "123456:ABC-DEF…"
node src\cli.mjs test-alert --channel telegram
```

If the 8-participant cap becomes a problem later, **GREEN API** (hosted) or **WAHA**
(self-hosted Docker) address unlimited-size groups by `chatId`, and switching is one
config field.

---

## Running 24/7 on Windows

```powershell
.\scripts\install-task.ps1                # SYSTEM, at boot, before login
.\scripts\install-task.ps1 -UserSession   # current user, at logon (enables toasts)
.\scripts\protect-key.ps1                 # lock the vault key to SYSTEM + Admins
.\scripts\uninstall-task.ps1
```

The default install registers a scheduled task that:

- starts **at system startup**, before anyone logs in;
- runs as **SYSTEM**, so it survives logout and needs no stored password;
- **restarts every minute**, up to 999 times, if the process exits;
- has **no idle, battery or network conditions**, so it never quietly stops.

Nothing is downloaded and nothing is installed — this is the Task Scheduler that ships
with Windows.

**Session-0 caveat, stated plainly:** a SYSTEM service cannot draw a Windows toast in a
logged-in user's session. If desktop toasts matter, install with `-UserSession` and
accept that monitoring only runs once that user logs in. The dashboard's browser
notifications work either way, and WhatsApp/Telegram/email are unaffected — which is
why they are the primary alert path regardless.

### Health checking from outside

```powershell
curl http://127.0.0.1:8477/api/health    # 200 when fresh, 503 when stale
```

`data/heartbeat.json` is rewritten every cycle for anything that prefers a file.

---

## The dashboard

`http://127.0.0.1:8477` — live over Server-Sent Events, no polling, no build step,
no CDN (it loads on a PC with no internet).

- **Overview** — fleet tiles, health bar, per-zone cards, everything not serving video
- **Cameras** — searchable, filterable, sortable table; probe any camera on demand; CSV export
- **Timeline** — every event, filterable to outages, escalations, flapping or monitor health
- **Uptime** — availability trend, per-camera uptime, outage count, MTTR, longest outage
- **Alarms** — the annunciator with acknowledge / shelve / return-to-service, each alarm showing its required action and its consequence if ignored, plus live EEMUA 191 metrics
- **Reports** — reports of record, preview in any format, issue-and-send
- **Alerts** — channel status with one-click test send, live delivery queue, delivery history
- **Settings** — monitoring and alerting config, credential vault, CSV import, subnet discovery

It binds to **loopback only** by default. Exposing it on the network requires an access
token — the configuration validator refuses to start otherwise, because an
unauthenticated page listing every camera's IP is a gift to anyone who finds it.

---

## Testing it before you trust it

Two different questions, two commands.

**`selftest`** — *does the software work on this machine?* Starts simulated cameras on
loopback, runs the real engine against them, and verifies every stage: probing, outage
detection, image analysis, alarm raising, acknowledgement, shelving, report generation
in all four formats, and delivery. It runs entirely in a scratch directory in a
separate process, so it cannot touch your real config, inventory or alarm register.

```powershell
node src\cli.mjs selftest                 # 25 checks, about a second
node src\cli.mjs selftest --channels      # ALSO sends a real test message
                                          # through every enabled channel
node src\cli.mjs selftest --keep          # keep the scratch dir to inspect
```

This is what to run first on a new PC. It turns "a blocked port, a missing PowerShell
policy, an expired token, a read-only directory" into a red line on a terminal now,
instead of a missed alarm at 3am.

**`doctor`** — *is my configuration and network right?* Checks the real installation:
config validity, inventory, whether the gateway reference hosts answer, channel
configuration and live health, monitoring freshness, queue depth, disk.

```powershell
node src\cli.mjs doctor
```

If something misbehaves, `node src\cli.mjs support` writes a diagnostics bundle —
configuration with credentials redacted, fleet and alarm state, the delivery queue,
recent events and the last 200 log lines, with camera addresses masked to their
subnet. Review it, then share it.

---

## Commands

```
node src\cli.mjs run                            start monitoring + dashboard
node src\cli.mjs selftest                       prove the pipeline works here
node src\cli.mjs support                        redacted diagnostics bundle
node src\cli.mjs import   --csv cameras.csv     import/merge an inventory
node src\cli.mjs discover --cidr 10.0.0.0/24    find cameras on a subnet
node src\cli.mjs probe    --host 10.0.0.11      probe one camera, print every layer
node src\cli.mjs secret   set <name> <value>    store a credential (encrypted)
node src\cli.mjs test-alert --channel telegram  send a test message
node src\cli.mjs report   --format offline      print a shareable report
node src\cli.mjs doctor                         check everything and say what is wrong
node src\cli.mjs alarms                         the annunciator + EEMUA 191 KPIs
node src\cli.mjs alarms --catalog --verbose     the rationalised alarm catalogue
node src\cli.mjs reports                        preview the all-device report
node src\cli.mjs reports --list                 reports of record
node src\cli.mjs reports --issue                issue and file one (does not send)
node src\cli.mjs wa-groups                      list WhatsApp groups (Cloud API)
node src\cli.mjs wa-login                       link WhatsApp Web by QR
```

---

## Configuration

`config/config.json` — plain text, safe to keep in a runbook. Every default lives in
`src/core/config.mjs` and is documented there. Nothing an operator might change is
hard-coded anywhere else.

**Credentials never go in this file.** They live in `config/secrets.enc` (AES-256-GCM)
and are referenced as `"@vault:telegram.botToken"`.

The settings that matter most:

```jsonc
{
  "site":    { "name": "Dhaka Bypass Expressway", "timezone": "Asia/Dhaka" },
  "monitor": {
    "intervalSec": 60,
    "concurrency": 40,
    "gatewayCheck": {
      // Set these. Without them the monitor cannot distinguish its OWN outage
      // from a camera outage, and will report both identically.
      "enabled": true,
      "hosts": ["192.189.6.1", "192.189.6.5"]   // core switch, NVR
    }
  },
  "detect":  { "confirmDownCycles": 2, "flapCount": 4, "flapWindowMin": 30 },
  "alerts":  {
    "coalesceSec": 90,
    "maxPerHour": 30,
    "quietHours":  { "enabled": false, "from": "22:00", "to": "07:00", "overrideAtOrAbove": "critical" },
    "escalation":  [{ "afterMin": 60, "severity": "critical", "label": "Down 1 hour" }],
    "digest":      { "enabled": true, "times": ["09:00", "18:00"] },
    "watchdog":    { "enabled": true, "staleAfterSec": 300 },
    "maintenance": [{ "name": "Zone 3 cabling", "from": "2026-09-20T22:00:00Z", "to": "2026-09-21T04:00:00Z", "groups": ["Zone 3 - Bhulta"] }]
  }
}
```

### Security posture, stated honestly

- The dashboard binds to loopback; going wider **requires** a token (enforced at startup).
- Credentials are AES-256-GCM encrypted at rest with a keyfile. This protects against
  casual disclosure — config pasted into a chat, copied into a runbook, committed to
  git, read off a backup. It does **not** protect against an attacker who is already
  Administrator on the box; nothing running unattended can. Run `protect-key.ps1` to
  restrict the keyfile to SYSTEM and Administrators.
- Camera probes accept self-signed certificates, because cameras universally have them.
  Alert-channel calls **always** verify TLS — those carry credentials over the internet.
- Webhook payloads are HMAC-SHA256 signed over timestamp + body, so a captured payload
  cannot be replayed.
- The API redacts anything credential-shaped and never returns a stored secret; it
  lists secret *names* only.
- Camera names come from an operator-edited CSV and are treated as untrusted
  throughout — the dashboard builds DOM nodes, never HTML strings.

---

## Storage

No database. JSONL and JSON, so a monitoring box that sits untouched for a year has no
binary format to corrupt and no native module to break after a Node upgrade.

```
config/config.json        settings (plain text, no secrets)
config/secrets.enc        encrypted credential vault
config/vault.key          its key — restrict with protect-key.ps1
data/inventory.json       the camera list
data/state.json           current truth (atomic writes, mutex-guarded)
data/events/*.jsonl       append-only transition log, rotated daily
data/snapshots/*.jsonl    one fleet sample per cycle, feeds the SLA figures
data/outbox.json          the delivery queue — survives restarts
data/exports/reports/     reports of record, by date (text, HTML, CSV, JSON)
data/heartbeat.json       for external supervision
logs/corridor-*.log       structured NDJSON, size-rotated and age-pruned
```

Retention defaults: events 180 days, samples 14 days, logs 30 days.

---

## Testing

```bash
npm test        # 167 tests
```

The tests run against **real protocol servers**, not mocks: `tests/helpers/fake-camera.mjs`
implements an RTSP server with Digest auth and SDP, and an ONVIF SOAP endpoint. The
end-to-end suite starts the real engine and the real HTTP server, kills a camera
mid-run, and asserts that the outage, the alert and the recovery all land correctly.

Image analysis is validated against JPEGs of known luminance. Digest auth is validated
against the RFC 2617 reference vector.

Every rule from the audit has a test naming the finding it fixes — `B2` (camera
identity), `B3` (lost updates), `M2` (durations), `M3` (timezone), and the rest.

---

## Troubleshooting

| Symptom | What to do |
|---|---|
| Everything reads `unknown` | Your uplink is down, or `gatewayCheck.hosts` is unreachable. This is the monitor refusing to blame the cameras for your network. |
| Everything reads `degraded` with `auth` | Camera credentials are wrong: `node src\cli.mjs secret set cameras.password "…"` |
| A camera reads `degraded`, RTSP `no-such-stream` | The stream path guess is wrong. Find the real one with `node src\cli.mjs probe --host <ip> --verbose`, then add an `rtspPath` column to your CSV. |
| Alerts are not arriving | `node src\cli.mjs doctor`, then the **Alerts** tab — it shows the queue and every delivery attempt with its error. |
| WhatsApp Web stopped working | `node src\cli.mjs wa-login` to re-link. If it keeps breaking, move to GREEN API or WAHA. |
| Cycles take longer than the interval | The log says so explicitly. Raise `monitor.concurrency` or `monitor.intervalSec`. |
| Port 8477 in use | Change `server.port`, or find the other instance — the service refuses to start twice. |

Live log:

```powershell
Get-Content logs\corridor-*.log -Tail 40 -Wait
```

---

## Documents

- [`docs/ALARMS.md`](docs/ALARMS.md) — alarm philosophy, the full catalogue, the report specification
- [`docs/AUDIT.md`](docs/AUDIT.md) — the brutal audit of the Chrome extension: 47 findings, graded
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — day-to-day operator procedures
- [`CHANGELOG.md`](CHANGELOG.md) — what changed and why
