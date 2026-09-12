# Changelog

## 2.0.0 — Corridor Vision

Complete replacement of the `aiv-camera-status-extension` Chrome extension with a
standalone Windows service. See [`docs/AUDIT.md`](docs/AUDIT.md) for the 47 findings
against v1 that motivated it.

### Architecture

- **No browser, no AIV-MP dependency.** Cameras are probed directly, so monitoring
  survives the VMS being down — which is precisely when a switch failure takes the
  cameras and the VMS together.
- **Runs as a Windows service** that starts at boot before anyone logs in, restarts on
  crash, and survives logout.
- **Zero runtime dependencies.** No database, no native modules, no framework, no CDN.
  ONVIF SOAP, RTSP, HTTP Digest, SMTP and JPEG analysis are implemented directly.

### Detection

- Six-layer probe ladder: ICMP → TCP → ONVIF → RTSP → vendor health API → snapshot.
- Four verdicts instead of two: `up` / `degraded` / `down` / `unknown`.
- **`degraded`** catches what AIV-MP cannot see: reachable cameras whose stream is
  dead, whose image is black, flat or frozen, whose storage has failed, or whose clock
  has drifted.
- **`unknown` is never reported as `down`** — a broken uplink on the monitoring side
  no longer manufactures a fleet-wide outage (v1 had no such distinction).
- Vendor adapters for Uniview (LAPI), Hikvision (ISAPI) and Dahua (CGI), with ONVIF
  manufacturer auto-detection.
- Dependency-free baseline-JPEG DC decoder for black / flat / frozen detection,
  validated against images of known luminance.

### Correctness fixes carried over from the audit

- **B1** — a watchdog now alerts when the monitor itself stops. v1 failed silently.
- **B2** — stable camera identity (explicit id → serial → address, with collision
  discrimination for channels behind one NVR). v1 keyed history on the camera *name*,
  so duplicates merged and a healthy namesake cancelled a real outage.
- **B3** — all shared state passes through a mutex. v1's concurrent poll and manual
  refresh silently overwrote each other's events.
- **B4** — confirmation cycles and flap suppression. v1 alerted on a single sample.
- **B5** — 60-second cycles, configurable, versus a fixed 10 minutes.
- **H1** — HTTP status is checked before parsing, so a 401 reports as an auth failure
  rather than a JSON parse error.
- **H3/H4** — bounded concurrency with per-camera and per-cycle budgets; no silent
  truncation at 10,000 devices.
- **M1** — one report formatter. v1 had three divergent copies plus a fourth that was
  generated every poll and never read.
- **M2** — durations render as `5d 1h`, not `121h 30m`.
- **M3** — every timestamp renders in the *site* timezone, not the host's.
- **M4** — nothing is hard-coded; full config file, validator and settings UI.
- **M8** — mass-outage rollup: an entire zone dark is one alert naming the likely
  cause, not twelve alerts.

### Alerting

- Thirteen alert types across camera, zone, site and monitor health.
- Fourteen channels, including five WhatsApp routes (GREEN API, WAHA, Web automation,
  Meta Cloud API, CallMeBot), Telegram, Slack, Teams, Discord, SMTP email, HMAC-signed
  webhook, Windows toast and the dashboard.
- Persisted delivery queue with exponential backoff — an alert raised while the line
  was down still arrives, and one that is too old to be useful is dropped with a
  logged reason rather than retried forever.
- Noise control: confirmation, flap suppression, coalescing, mass-outage rollup, quiet
  hours, maintenance windows, and a per-channel hourly cap that announces itself
  rather than going silently quiet.
- Escalation ladder at 1 h / 6 h / 24 h, and scheduled digests with SLA figures.

### Operations

- Live dashboard over SSE: overview, camera table, timeline, uptime/SLA, channel
  health with one-click test send, delivery log, and settings.
- Encrypted credential vault (AES-256-GCM); credentials never appear in config, logs
  or API responses.
- CSV importer that accepts the v1 extension's export unchanged, plus ONVIF
  WS-Discovery and subnet sweep.
- `doctor` command that checks configuration, inventory, network, channels, freshness,
  queue depth and disk, and says what is wrong.
- 103 tests, run against real RTSP/ONVIF servers rather than mocks.
