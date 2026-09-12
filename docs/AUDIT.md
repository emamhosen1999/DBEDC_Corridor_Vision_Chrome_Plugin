# Brutal audit — `aiv-camera-status-extension` v1.0.0

Scope: all 1,061 lines shipped in the zip (`manifest.json`, `content.js`, `inject.js`,
`background.js`, `offscreen.js/html`, `popup.html/js/css`).

Verdict up front: **it is a competent demo and an unsafe production monitor.** The
collection logic is genuinely clever — capturing the bearer token from the app's own
XHRs and reusing the page's TLS trust is the right trick for a self-signed appliance.
Everything *around* that core is where it falls down. The headline problems are not
cosmetic:

1. It is **not real-time** (10-minute polling, best case).
2. It **fails silently** — the single most dangerous property a monitor can have.
3. Its camera identity key is **not unique**, so downtime and transitions are wrong.
4. It has a **read-modify-write race** that loses events.
5. It has **no flap suppression**, so one bad poll spams the operator.

Below, every finding, graded. `C` = correctness, `R` = reliability, `S` = security,
`U` = UX, `O` = operability.

---

## Blockers

### B1 · Silent monitoring failure (`R`) — `background.js:120-145`
`isAuthError()` matches only `/token|authenticat|login|expire|unauthor|401/`. The two
most likely real-world failures — `NO_TAB` (someone closed the tab) and
`TAB_NOT_READY` (Chrome restarted, tab not restored) — match nothing. When they
happen the extension writes `lastError`, sets a grey `!` badge, and says nothing.

Nobody looks at a toolbar badge. The extension can be dead for a week and the only
evidence is a grey exclamation mark 40 pixels wide. **A monitor that cannot alert on
its own death is not a monitor.** There is no heartbeat, no staleness watchdog, no
"last successful poll was 14 hours ago" escalation.

### B2 · Camera identity is the camera *name* (`C`) — `background.js:150-183`
`offlineSince` is keyed by `c.name`:
```js
data.offline.forEach(function (c) { currentOffline[c.name] = c.org || ''; });
```
Camera names on a corridor deployment are routinely duplicated — `Gate-01`, `PTZ-1`,
`Entry Cam` repeat per site. Consequences, all silent:
- two cameras with the same name collapse into one history entry;
- if A is down and B (same name) is up, B's presence *cancels* A's outage → **missed
  alert**;
- a rename in AIV-MP registers as one camera vanishing (false "recovered") and a new
  one appearing (false "went offline");
- downtime durations are attributed to the wrong device.

The API returns a real `cameraId`. It is discarded — `aggregate()` only keeps
`{name, org}` in `data.offline`.

### B3 · Read-modify-write race loses events (`C`) — `background.js:124-197`
`collectAndStore()` does `storage.local.get(...)` → mutate → `storage.local.set(...)`
with no lock. The alarm poll and the popup's **Refresh** button can run it
concurrently (and do, every time an operator hits Refresh near the 10-minute mark).
Two in-flight runs read the same `events`/`offlineSince`, and the second `set()`
overwrites the first. Lost outage events, resurrected `offlineSince` entries,
double notifications. There is no mutex, no single-flight, no version check.

### B4 · No flap suppression (`R`) — `background.js:158-177`
A transition is declared on a **single** observation. One slow API response, one
momentary `status:2` during an NVR keyframe hiccup, one switch STP re-convergence,
and every affected camera fires an "OFFLINE" notification plus a beep — then a
"back ONLINE" notification 10 minutes later. On a flapping PoE uplink this produces
hundreds of notifications a day and operators turn notifications off. At that point
the product is worse than nothing, because it has trained its users to ignore it.

No confirmation window, no `N consecutive polls`, no flap counter, no cooldown.

### B5 · Not real-time (`R`) — `background.js:15`
`POLL_MINUTES = 10`. Worst case a camera is down **10 minutes** before the extension
notices and, because notifications only fire after the poll, up to 10 minutes before
anyone is told. No push, no websocket, no event subscription, no configurability.

---

## High

### H1 · `api()` never checks HTTP status (`C`) — `inject.js:53-59`
```js
return fetch(BASE + path, {...}).then(function (r) { return r.json(); });
```
On a 401/403/502 the appliance returns an HTML error page. `r.json()` throws
`SyntaxError: Unexpected token '<'`, which propagates to the popup as
*"Could not reach the platform (Unexpected token '<' ...)"* — and, critically, does
**not** match `isAuthError()`, so the session-expired alert never fires. The single
most common production failure is misreported as a parse error.

### H2 · Token capture hooks `XMLHttpRequest` only (`C`) — `inject.js:21-36`
Modern builds of this platform use `fetch` for parts of the app. If the token never
crosses an XHR, `waitForToken()` burns 15 s and rejects `NO_TOKEN` forever. `fetch`
and `sendBeacon` are not hooked. There is also no cache: after a quiet period with no
app traffic, a perfectly valid session yields `NO_TOKEN` because nothing fired in the
observation window.

### H3 · Org-tree crawl is serial and unbounded (`R`) — `inject.js:62-79`
`crawl()` awaits each child sequentially, depth 8. A 150-node hierarchy is 150
sequential round-trips. At 200 ms each that is 30 s — and `content.js` times out at
40 s (`content.js:39-42`), so the whole collection fails on larger deployments. The
org tree also changes perhaps monthly and is re-crawled **every single poll**. No
cache, no parallelism, no concurrency limit.

### H4 · Silent truncation at 10,000 cameras (`C`) — `inject.js:84`
`for (var page = 1; page <= 50; page++)` with `pageSize: 200`. Past 10,000 cameras
the list is silently cut and every camera beyond the cut is invisible — reported
neither online nor offline. No warning surfaces anywhere.

### H5 · Discarded-tab recovery is a fixed 6-second guess (`R`) — `background.js:33-39`
```js
await chrome.tabs.reload(tab.id);
await wait(6000);
```
A heavy SPA on an appliance behind a VPN does not boot, authenticate and issue its
first authenticated XHR in 6 s. The subsequent `sendMessage` then fails
`TAB_NOT_READY`, which (per B1) alerts nobody. No readiness polling, no retry, no
backoff.

### H6 · `chrome.runtime.sendMessage` unhandled rejection (`R`) — `background.js:86-91`
```js
try { await ensureOffscreen(); chrome.runtime.sendMessage({type:'AIV_BEEP',...}); }
catch (e) {}
```
Without a callback this returns a **promise**. If the offscreen document is not yet
listening it rejects with *"Could not establish connection"* — outside the
`try/catch`, because the throw is asynchronous. Unhandled rejection in the service
worker; the beep is lost.

### H7 · `postMessage(..., '*')` on a shared page (`S`) — `inject.js:225-227`, `content.js:44`
Every script running on the AIV-MP origin can (a) read the full camera report,
including every camera name, IP and device, and (b) **forge** a
`{source:'AIV_PAGE', type:'REPORT'}` message. There is no shared secret and no origin
pinning — `requestId` is predictable enough (`'r' + Date.now() + Math.random()`) and
is echoed in the request anyway. A single XSS or malicious extension on that origin
can feed the monitor fabricated "all cameras online" reports indefinitely. Likewise
`inject.js` answers a `COLLECT` from *any* page script, turning the extension into a
free authenticated-API oracle.

### H8 · Snapshots are collected and never used (`O`) — `background.js:186-187`
2,100 snapshots (~14 days) are written on every poll and read by nothing. No trend,
no uptime %, no SLA, no chart, no export. Pure write amplification. Meanwhile
`chrome.storage.local` is capped at 10 MB and `unlimitedStorage` is **not** requested.

---

## Medium

### M1 · Report-building logic is duplicated three times (`C`)
`inject.js:165-208` `buildReportText()` and `popup.js:48-102` `buildFull/Offline/Summary`
implement the same report with different details — `inject.js` omits downtime,
`popup.js` includes it. `data.reportText` is generated on every poll, stored, and then
**never read by anything**. Two divergent sources of truth for the artefact the whole
product exists to produce.

### M2 · Duration formatting breaks past a day (`U`) — `background.js:60-66`, `popup.js:13-18`
`fmtDuration(ms)` caps at hours: a camera down five days reads **`121h 30m`**.
Also duplicated verbatim in two files.

### M3 · Timezone is whatever the PC says (`C`) — `inject.js:169`, `popup.js:20-24`
`toLocaleTimeString('en-US', ...)` with no `timeZone`. The site is Dhaka Bypass
Expressway; a report generated on a laptop set to another timezone is stamped with
the wrong time and pasted into an ops group as fact. No timezone is configured or
displayed.

### M4 · Everything is hard-coded (`O`)
`192.189.6.5:10002` appears in `manifest.json` (×3), `background.js:14`,
`popup.js:34` and `popup.js:248`. `'Dhaka Bypass Expressway'` is a string literal in
`inject.js:155`. Poll interval, thresholds, retention — all literals. **There is no
options page at all.** Changing the server IP means editing four files and reloading
the extension.

### M5 · No `notifications.onClicked` handler (`U`) — `background.js:93-118`
Clicking an alert does nothing. The operator's instinct — click the toast to see
what broke — is a dead end.

### M6 · Alerts auto-dismiss (`U`) — `background.js:101`
No `requireInteraction: true`. A critical outage toast disappears after ~8 s. If the
operator was getting coffee, the alert never existed. There is no alert history view
either — `events` is a *transition* log, not a *delivery* log.

### M7 · Badge destroys information on error (`U`) — `background.js:49-58`
A failed poll overwrites the offline count with `!`, discarding the last known state
from the only always-visible surface in the product.

### M8 · No alert routing, no grouping, no mass-outage detection (`O`)
When a switch dies and 60 cameras drop, the extension fires one notification listing
**six** names and `…`. It never says "Zone 3 is entirely offline — likely switch or
power", which is the only sentence that matters. No per-group routing, no severity
model, no escalation for a camera still down after an hour, no digest, no quiet hours,
no rate limit.

### M9 · `tabs` permission is unnecessary (`S`) — `manifest.json:6`
`chrome.tabs.query({url})` is satisfied by the existing `host_permissions`. The broad
`tabs` permission grants URL/title visibility across **every** tab and inflates the
Chrome Web Store permission warning for no functional gain.

### M10 · Script injection can be blocked by page CSP (`R`) — `content.js:14-21`
Injecting `<script src=chrome-extension://…/inject.js>` depends on the page's CSP
allowing that origin. Chrome 111+ supports `"world": "MAIN"` in the content-script
registration, which is immune to page CSP and runs strictly earlier. Not used.

---

## Low / UI

- **L1** `$('view-status').className = v === 'status' ? '' : 'hidden'` (`popup.js:223-224`)
  clobbers every other class on the element. It happens to work today only because
  those sections carry no other classes — a latent bug for the next person who adds one.
- **L2** Downtime labels are frozen while the popup is open — `down 4m` still reads
  `4m` ten minutes later. No live ticker.
- **L3** No loading state. First open shows `–  –  –` with no spinner and no
  explanation of whether it is working or broken.
- **L4** No search, no filter, no sort, no collapse in a 360×580 px popup. At 300
  offline cameras the list is an unusable wall of `<li>`.
- **L5** `esc()` (`popup.js:25-29`) does not escape `'`. Harmless where it is used
  today (`innerHTML` text position, double-quoted attrs) but wrong by construction,
  and the code does build HTML by string concatenation from API-supplied names.
- **L6** No accessibility: tabs are `<button>`s without `role="tab"`/`aria-selected`,
  no focus-visible styles, no live region for the toast, no keyboard affordances.
- **L7** `chrome.runtime.lastError` is never checked in any callback
  (`popup.js:231`, `popup.js:248`, `popup.js:259`), producing console noise and
  swallowing real failures.
- **L8** No `default_locale`/i18n, no `minimum_chrome_version`, no storage-schema
  version or migration path, no history export, no tests, no lint, no CI.
- **L9** `ensureAlarm()` runs only on `onInstalled`/`onStartup`. If the alarm is ever
  lost (profile sync edge cases, extension error state) polling stops permanently
  until the browser restarts. Nothing re-asserts it on wake.

---

## The structural problem

Every finding above is a symptom of one architectural choice: **the monitor's
lifeline is a human-maintained browser tab inside a GUI session on a desktop
browser.** That chain has, minimally, these single points of failure:

| Link | Fails when |
|---|---|
| Chrome running | PC reboots, update restarts browser, user closes it |
| Tab open on the exact URL | Anyone closes it, or restores a session without it |
| Tab not discarded | Chrome reclaims memory (routine on 8 GB boxes) |
| AIV-MP session valid | Token expires, password rotates, server restarts |
| AIV-MP server healthy | The thing most likely to fail *with* the cameras |
| Operator logged in | Windows locks/logs out; service accounts can't help |
| Service worker alive | MV3 evicts it; only alarms bring it back |

Six of those seven links break **silently** (B1). And the last one is the killer:
you are asking the video-management server to tell you when the video system is
broken. When a core switch dies, AIV-MP and the cameras go dark **together** — and
the monitor reports "could not reach the platform", which alerts nobody.

That is why the rebuild in this repository **probes the cameras directly** and runs
as a Windows service rather than a browser extension. Direct probing also detects a
failure class AIV-MP structurally cannot report: a camera that is powered, pingable,
and flagged `status: 1`, whose RTSP stream is dead or whose image is black, frozen,
or lens-covered.

---

## What was worth keeping

Credit where due — these ideas survived into the rewrite:

- The hierarchical org grouping with per-group online/offline counts.
- The three report shapes (full / offline-only / summary) and the
  WhatsApp-friendly emoji formatting — genuinely well-judged for the audience.
- Distinguishing *new* transitions from steady state, and recording outage duration.
- The CSV export — which is now the **inventory bootstrap** for the new system
  (`npm run import -- --csv`), so the old extension has an ongoing job.
