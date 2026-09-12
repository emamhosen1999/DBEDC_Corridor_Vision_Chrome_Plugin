# Commissioning handover — DBEDC Corridor Vision

**Read this first if you are picking up commissioning on the monitoring PC.**

Written 2026-09-12 from a session on the operator's laptop (Wi-Fi only, **no route to
the camera network**). Steps 1–3 are done; steps 4–7 need a machine with ethernet to
`10.x` / `11.151.x`.

Branch: `commissioning/dbedc-windows` (2 commits on top of `main`).

---

## The site, in one paragraph

162 cameras on `11.151.0.0/16` across six /24s, in 10 zones, exported from AIV-MP
(VPAASPlat). Protocol ONVIF; the camera account and password come from the operator
and are deliberately **not** recorded here - this file is in git. The platform
already reports 28 Offline and 11 Inactive. Dashboard on `127.0.0.1:8477`, timezone
`Asia/Dhaka`, site "Dhaka Bypass Expressway".

---

## What is already done

| Step | State |
|---|---|
| 1. `scripts\setup.ps1` | **Passes.** Three Windows defects fixed (see below). |
| 2. `node src\cli.mjs selftest` | **Passes**, 25 checks. Silent-failure bug fixed. |
| 3. Inventory import | **Done on the laptop** — 162 cameras, 10 zones. Must be **redone here** (see "First 10 minutes"). |
| 4. Probe a real camera | **Not started — needs this machine.** |
| 5. `monitor.gatewayCheck.hosts` | **Not set.** Needs the core switch and NVR addresses. |
| 6. WhatsApp + Telegram | **Not started.** Needs tokens from the operator. |
| 7. Foreground run → `install-task.ps1` | **Not started.** |

Tests: **175, 0 failing** on Windows / Node 24.15.

---

## First 10 minutes on this PC

`config/`, `data/`, `cameras.csv` and the credential vault are all gitignored, so they
do **not** arrive with the checkout. Recreate them:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\scripts\setup.ps1                       # writes config.json, runs the self-test
npm test                                  # expect 175 passing, 7 skipped

# Re-export "Camera Information" from AIV-MP as CSV, or copy cameras.csv across.
node src\cli.mjs import --csv cameras.csv --vendor uniview
node src\cli.mjs secret set cameras.username <camera-user>
node src\cli.mjs secret set cameras.password "<camera-password>"
node src\cli.mjs doctor
```

`--vendor uniview` matters: AIV-MP writes `Others` in the manufacturer column for all
162 cameras, which is treated as "not identified", so the default supplies the adapter.

Sanity check after import — this must print 10 zones, not one called `Ungrouped`:

```powershell
node -e "const i=require('fs').readFileSync('data/inventory.json','utf8');const c=JSON.parse(i).cameras;const g={};for(const x of c)g[x.group]=(g[x.group]||0)+1;console.log(c.length);console.table(g)"
```

---

## Step 4 — the actual job

**The Uniview LAPI endpoints, RTSP path templates and snapshot URLs in this codebase
were written from documentation and have never touched hardware. Expect them to be
wrong. Do not replace one guess with another — capture what the camera says.**

```powershell
node scripts\capture-camera-evidence.mjs --host 11.151.11.114 --user <camera-user> --pass <camera-password> --out evidence-fisheye.json
```

Run it against at least three cameras of different types, because they will not agree:

| Type | Example | Zone |
|---|---|---|
| Panoramic fisheye | `11.151.11.114` | Panoramic Fisheye Camera |
| Fixed bullet | `11.151.11.115` | EastBound K4 To K26 |
| PTZ dome | `11.151.11.112` | Road Section PTZ Dome Camera |

The script is read-only (GET / DESCRIBE / ONVIF queries only), scrubs credentials from
its output, and records: every open TCP port, ONVIF device+media+snapshot answers,
RTSP `DESCRIBE` against both the ONVIF-supplied URL and all 13 candidate templates,
every Uniview LAPI endpoint the adapter depends on plus known alternates, and every
snapshot URL candidate.

Then compare with the ladder's own view:

```powershell
node src\cli.mjs probe --host 11.151.11.114 --user <camera-user> --pass <camera-password> --verbose
```

### What to change, and where

- **`src/probe/vendor/uniview.mjs`** — `LAPI` base path, the `/System/DeviceInfo`,
  `/System/Time`, `/System/StorageInfo` paths, the JSON field names (`DeviceModel`,
  `RunningTime`, `NTPEnable`, `StorageList`…) and `snapshotPaths` / `rtspPaths`.
  Every one of these is currently a guess.
- **`probe.rtsp.pathTemplates`** in `config/config.json` (default in
  `src/core/config.mjs`) — put whatever actually answered first.
- **Add a test for whatever you change**, against `tests/helpers/fake-camera.mjs`
  rather than a mock. That helper now implements an ONVIF `media_service`.

### Known gotchas already handled — don't "re-fix" them

- If every RTSP template misses, the probe now asks the camera via ONVIF
  `GetStreamUri` and caches the answer on the camera's state. So a wrong template
  degrades to "one-off discovery", not a false outage. Check `layers.rtsp.via ===
  'onvif-getstreamuri'` to see when this fired — **if it fires on every camera, the
  templates are wrong and should be corrected anyway**, because discovery costs two
  SOAP calls per new camera.
- An explicit RTSP URL is probed on the host and port *inside the URL*, not 554.

### A real data problem to resolve while you are on site

Four IPs are each claimed by two differently-named cameras in the export:

| IP | Camera A | Camera B |
|---|---|---|
| `11.151.11.52` | K27 Exit Booth 08 Camera | vogra 101 lane |
| `11.151.11.54` | K27 Exit inner Plaza dome | vogra 103 lane |
| `11.151.11.55` | K27 Exit outer Plaza dome | vogra 104 lane |
| `11.151.11.56` | Vogra Square ball machine  inside the exit | Vogra Square ball machine inside the exit |

The first three pair a Purbachal (K27) camera with a Vogra (K4) camera — different
physical sites, ~23 km apart, so this is either an IP conflict on the network or bad
data in AIV-MP. The fourth is one camera listed twice (note the double space). They
survive import because each has a distinct platform `Camera ID`, but two devices on
one IP cannot both be monitored.

---

## Step 5 — gateway reference hosts

Without these the monitor cannot tell **its own** outage from a camera outage, and
will report both identically. Set them to the core switch and the NVR:

```jsonc
"monitor": { "gatewayCheck": { "enabled": true, "hosts": ["<core switch>", "<NVR>"] } }
```

Pick hosts that are on the monitoring PC's side of the camera network and that fail
*only* when the monitoring path itself is broken. `doctor` currently reports
`no reference host reachable` because the defaults are placeholders.

---

## Step 6 — alerting

Primary WhatsApp Cloud API, Telegram as backup. **The 24-hour window decides whether
3am alarms arrive**: Meta rejects free-form text outside it with error 131047, so an
approved **UTILITY** template is required, body exactly:

```
Corridor Vision alert:

{{1}}
```

```powershell
node src\cli.mjs secret set whatsappCloud.accessToken "<token>"
node src\cli.mjs wa-groups
node src\cli.mjs secret set telegram.botToken "<token>"
node src\cli.mjs selftest --channels
```

Enable Telegram too — no messaging window, no template approval, no participant cap.

---

## Step 7 — run it

```powershell
node src\cli.mjs run           # watch several cycles; 162 cameras at concurrency 40
# dashboard: http://127.0.0.1:8477
.\scripts\install-task.ps1     # elevated; SYSTEM, at boot
.\scripts\protect-key.ps1
```

Watch for `cycle exceeded its budget` in the log — 162 cameras on a 60 s interval with
snapshot analysis is the first thing likely to overrun. Raise `monitor.concurrency` or
`monitor.intervalSec` if so.

---

## Defects fixed during steps 1–3 (context, not to redo)

1. `setup.ps1` wrote `CORRIDOR_HOME` to Machine scope → `SecurityException` unelevated.
2. `setup.ps1` wrote `config.json` **with a BOM** → `JSON.parse` rejected it, so
   `doctor`, `run` and `selftest` all refused to start on a fresh install.
3. `setup.ps1` read the example config as ANSI → mojibake in every em-dash.
4. `loadConfig` / `loadInventory` now tolerate a BOM from any source;
   `loadInventory` had been swallowing the error and returning an **empty fleet**.
5. `selftest` could exit 1 with **no output at all** — `process.exit()` discards
   buffered stdout, which on Windows is async whenever stdout is a pipe.
6. CSV import ignored **"Organization Name"**, so all 162 cameras imported as
   `Ungrouped` while reporting "0 rejected" — silently disabling `NET_ZONE_DOWN`.
7. `rtspProbe` ignored the port inside an explicit URL and always used 554.

### Still outstanding

- **7 skipped tests**: the image-analysis precision suite points at a Linux sandbox
  path (`/tmp/claude-0/…/jpegs`) that was never committed, so the README's "validated
  against reference images" claim is unverified on Windows. The self-test does
  exercise layer 5 with inline JPEGs. Fix by committing generated fixtures.
- **A rare self-test flake**: one truncated failure in ~230 piped runs after fix 5,
  not reproducible in 160 instrumented runs. Now diagnosable rather than silent — if
  it recurs, capture with `node src\cli.mjs selftest > selftest.log 2>&1`.
- **Addressing**: `11.0.0.0/8` is public space (US DoD), not RFC1918. From any machine
  without an internal route, camera traffic leaks toward the internet — confirmed by
  traceroute from the operator's laptop. Worth raising with the network owner.
