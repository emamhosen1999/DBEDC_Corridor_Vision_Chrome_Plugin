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
# 1. Get your camera list. Easiest route: open AIV-MP, use the old extension's
#    CSV export, and save it as cameras.csv. Any spreadsheet with an IP column works.
node src\cli.mjs import --csv cameras.csv

# 2. Store the camera credentials (encrypted; never written to config.json)
node src\cli.mjs secret set cameras.username admin
node src\cli.mjs secret set cameras.password "your-camera-password"

# 3. Check everything before committing to unattended operation
node src\cli.mjs doctor

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

## Alerts

### Alert types

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
| **WhatsApp — GREEN API** | ✅ | Account, QR link | **Recommended.** Hosted; addresses a group by `…@g.us`. |
| **WhatsApp — WAHA** | ✅ | Docker on your own box | **Recommended.** Self-hosted, free, data stays in-house. |
| **WhatsApp — Web automation** | ✅ | `npm i whatsapp-web.js` | Zero infrastructure. **Unofficial** — see below. |
| **WhatsApp — Meta Cloud API** | ⚠️ max 8 | Official Business Account | Groups capped at **8 participants**. Fine for 1:1 on-call. |
| **WhatsApp — CallMeBot** | ❌ | Nothing | Free, individual numbers only, personal use. |
| **Telegram** | ✅ | A bot token | Free, instant, and it does not break. **Enable this as a backup.** |
| **Slack / Teams / Discord** | ✅ | An incoming webhook | |
| **Email (SMTP)** | — | Mail server | Implemented directly on a socket; no dependency. |
| **Generic webhook** | — | A URL | HMAC-signed. Wire into n8n, Make, a ticketing system, an SMS gateway. |
| **Windows toast** | — | — | See the session-0 caveat below. |
| **Dashboard** | — | — | SSE push + browser notification. Always works. |

#### Straight answer on WhatsApp groups

There is no officially sanctioned way to post to a normal WhatsApp group from software.
Meta's Groups API exists but caps groups at **8 participants** and requires an Official
Business Account — unusable for an ops group, and you have said you do not have a
business account.

That leaves three routes that genuinely work, and you should pick on infrastructure:

- **GREEN API** — hosted, paid, nothing to run. Easiest.
- **WAHA** — one Docker container you own. Free, private. Best if you have a server.
- **whatsapp-web.js** — no server at all, but it automates WhatsApp Web with your own
  account, which WhatsApp's terms do not sanction. For an internal ops group on a
  company number the practical risk is low; it is not zero, and WhatsApp can break the
  web client at any time.

That last risk is exactly why it is an optional dependency: if it breaks, nothing else
in the system does. **Enable Telegram alongside whichever you choose.** It costs
nothing and it is the channel that will still be delivering when WhatsApp has a bad week.

```powershell
# GREEN API
node src\cli.mjs secret set whatsappGreen.apiToken "<token>"
# then set idInstance and chatId (…@g.us) in config/config.json, and:
node src\cli.mjs test-alert --channel whatsappGreen

# WhatsApp Web (zero infrastructure)
npm install whatsapp-web.js qrcode-terminal
node src\cli.mjs wa-login          # scan the QR once; the session persists

# Telegram
node src\cli.mjs secret set telegram.botToken "123456:ABC-DEF…"
node src\cli.mjs test-alert --channel telegram
```

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
- **Alerts** — channel status with one-click test send, live delivery queue, delivery history
- **Settings** — monitoring and alerting config, credential vault, CSV import, subnet discovery

It binds to **loopback only** by default. Exposing it on the network requires an access
token — the configuration validator refuses to start otherwise, because an
unauthenticated page listing every camera's IP is a gift to anyone who finds it.

---

## Commands

```
node src\cli.mjs run                            start monitoring + dashboard
node src\cli.mjs import   --csv cameras.csv     import/merge an inventory
node src\cli.mjs discover --cidr 10.0.0.0/24    find cameras on a subnet
node src\cli.mjs probe    --host 10.0.0.11      probe one camera, print every layer
node src\cli.mjs secret   set <name> <value>    store a credential (encrypted)
node src\cli.mjs test-alert --channel telegram  send a test message
node src\cli.mjs report   --format offline      print a shareable report
node src\cli.mjs doctor                         check everything and say what is wrong
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
data/heartbeat.json       for external supervision
logs/corridor-*.log       structured NDJSON, size-rotated and age-pruned
```

Retention defaults: events 180 days, samples 14 days, logs 30 days.

---

## Testing

```bash
npm test        # 103 tests
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

- [`docs/AUDIT.md`](docs/AUDIT.md) — the brutal audit of the Chrome extension: 47 findings, graded
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — day-to-day operator procedures
- [`CHANGELOG.md`](CHANGELOG.md) — what changed and why
