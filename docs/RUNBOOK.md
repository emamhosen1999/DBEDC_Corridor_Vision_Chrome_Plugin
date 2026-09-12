# Corridor Vision — operator runbook

For the person on shift. No development knowledge assumed.

---

## The one thing to know

**If you get an alert titled "🚨 MONITORING HAS STOPPED", the camera status on every
screen is stale and must not be trusted.** That alert means Corridor Vision itself is
not running. Nothing it showed you since is current. Go to
[Monitoring has stopped](#monitoring-has-stopped).

---

## Alarms — acknowledging and shelving

The **Alarms** tab is the annunciator. Every alarm shows what to do and what happens if
you ignore it.

- **Acknowledge** means *I have seen this*. It does not fix anything, and it does not
  clear the alarm — the alarm clears when the condition does.
- An alarm marked **cleared — awaiting acknowledgement** recovered on its own. It stays
  on screen so the incoming shift knows it happened. Acknowledge it once you have
  noted it.
- **Shelve** silences an alarm temporarily. It **requires a reason** and **always
  expires** (default 4 hours, hard cap 24). Use it when a contractor is on site and
  will be unplugging cameras — not to make a nuisance alarm go away.
- Two alarms cannot be shelved at all: **MONITORING HAS STOPPED** and **alert channel
  failing**. Those two tell you the alarm system itself has failed, and silencing them
  would defeat the entire point.

If an alarm keeps coming back, do not keep shelving it. Say so at handover — repeated
shelving of the same alarm is the signal that something needs fixing properly.

---

## The periodic report

A complete report of **every camera** is issued on a schedule (by default 06:00, 14:00
and 22:00 site time) and sent to the alert channels.

- It lists every device, not just the broken ones. That is deliberate: it is the
  evidence of what was actually checked.
- Each report is numbered, e.g. `CV-DBE-20260912-002`. **A gap in the numbering means a
  report was missed** — worth raising.
- If the report's first line says **MONITORING STALE**, the report is describing history,
  not the present. Do not act on its camera states until monitoring is restored.
- Section 5, *Action required*, is the part to work through on shift.

To send one now: dashboard → **Reports** → **Issue & send now**.
To pull one for a meeting: **Reports** → pick the report → **html** or **csv**.

---

## Daily checks (2 minutes)

1. Open `http://127.0.0.1:8477` on the monitoring PC.
2. The header should read **live** with a green dot, and "last probe" within the last
   couple of minutes.
3. **No red banner** across the top.
4. **Alarms** tab → work anything needing attention; acknowledge what you have seen.
5. **Overview** → fleet health percentage, and the "not serving video" list.
6. **Alerts** tab → delivery queue should be empty or near it.

If all six are right, nothing needs doing.

---

## Reading a camera's state

| State | Meaning | Who fixes it |
|---|---|---|
| 🟢 **Serving** | Reachable and serving video. | — |
| 🔴 **Offline** | Nothing answered at all. | Field team — power, PoE, cabling, switch. |
| 🟠 **Degraded** | Reachable but **not usable**. Read the detail line. | Depends — see below. |
| ⚪ **Unknown** | *We* could not tell. Usually our own network. | Network team, not the camera. |
| 🔁 **Flapping** | Changing state repeatedly. | Field team — unstable power or a failing lead. |

### Degraded detail lines, and what to do

| Detail | What it means | Action |
|---|---|---|
| `not serving video` | The camera is up, its encoder is not. | Reboot the camera. If it recurs, replace it. |
| `credentials rejected` | The password changed. | Update: `node src\cli.mjs secret set cameras.password "…"` |
| `image black` | No picture — stuck IR filter, dead sensor, or lens cap. | Site visit. |
| `image flat` | Uniform picture — lens fogged, sprayed, or facing a wall. | Site visit; clean or re-aim. |
| `image frozen` | Same picture for several cycles. Encoder wedged. | Reboot the camera. **Footage from this period is worthless.** |
| `storage … abnormal` | SD card or disk has failed. **It is recording nothing.** | Replace the card. |
| `clock drift …` | Camera clock is wrong. **Timestamps on footage are wrong.** | Fix NTP on the camera. |
| `resolution changed` | It reverted to a lower profile, usually after a power event. | Restore the profile. |

---

## Common situations

### "Entire zone dark"

```
🚨 ENTIRE ZONE DARK — Zone 3 - Bhulta
All 12 cameras in Zone 3 - Bhulta are unreachable.
```

**Do not dispatch anyone to twelve camera poles.** Twelve cameras do not fail at the
same second. Check, in order:

1. Power to the zone cabinet
2. The zone switch — is it up, are its port LEDs lit?
3. The uplink from the zone back to the control room
4. Only then, individual cameras

### "Site-wide outage"

Same logic, one level up: core switch, fibre run, or main power. Check the control-room
infrastructure before anything in the field.

### Everything shows ⚪ Unknown

The monitoring PC has lost its network path. The cameras are probably fine — Corridor
Vision is deliberately refusing to report them as offline, because it cannot see them.

Check the monitoring PC's own network connection, then the reference hosts configured
in `monitor.gatewayCheck.hosts`.

### Monitoring has stopped

```
🚨 MONITORING HAS STOPPED
No successful monitoring cycle for 3h 30m.
⚠️ Camera status shown anywhere right now is STALE and must not be trusted.
```

On the monitoring PC, in PowerShell:

```powershell
Get-ScheduledTask -TaskName CorridorVision | Get-ScheduledTaskInfo    # is it running?
Start-ScheduledTask -TaskName CorridorVision                          # start it
Get-Content logs\corridor-*.log -Tail 40                              # why did it stop?
node src\cli.mjs doctor                                               # what is wrong
```

When it comes back it sends a **"Monitoring resumed"** message naming the exact gap.
Treat that window as unobserved — you do not know what happened during it.

### A camera is flapping

One alert, then silence by design — a flapping camera would otherwise send hundreds a
day. Almost always physical:

- PoE power budget exceeded on the switch (count the cameras on it)
- A failing patch lead or a water-ingressed connector
- A switch port renegotiating speed

### Alerts stopped arriving

1. **Alerts** tab → is the queue backing up? The error is shown against each attempt.
2. Click **Send test** on the channel.
3. If WhatsApp Web: `node src\cli.mjs wa-login` to re-link.
4. Check you are not inside quiet hours or a maintenance window (Settings).
5. `node src\cli.mjs doctor`.

---

## Routine tasks

### Send a status report to the WhatsApp group

Dashboard → **Report** → choose *Full*, *Offline only* or *Summary* → **Copy** → paste.

Or **Send to alert channels** to push it to every configured channel directly.

### Planned maintenance — suppress alerts

Add a window to `config/config.json` so scheduled work does not page anyone:

```jsonc
"maintenance": [
  { "name": "Zone 3 recabling",
    "from": "2026-09-20T22:00:00Z",
    "to":   "2026-09-21T04:00:00Z",
    "groups": ["Zone 3 - Bhulta"] }
]
```

Times are **UTC** (Dhaka is UTC+6, so 04:00 local = 22:00 UTC the previous day).
Omit `groups` and `cameras` to suppress site-wide. Remove the entry when work finishes.

### Add or remove cameras

Re-export from AIV-MP, then:

```powershell
node src\cli.mjs import --csv cameras.csv
```

The import **merges**: anything you typed in manually (stream paths, per-camera
credentials) is preserved, and cameras missing from the file are kept. Use `--replace`
only when you intend to drop them.

### Pull an availability report for a meeting

Dashboard → **Uptime** → choose the period. Per-camera uptime, outage count, MTTR and
longest outage. The **Cameras** tab exports the current state as CSV.

### Silence overnight

Settings → Alerting → **Quiet hours**. Criticals still get through — that is
deliberate and should not be changed.

---

## Escalation

| Condition | Action |
|---|---|
| One camera offline | Log it. Field team on the next round. |
| Camera offline > 1 hour | Auto-escalates to critical. Raise a job. |
| Entire zone dark | Immediate — infrastructure, not cameras. Call the network team. |
| Site-wide outage | Immediate — control room infrastructure. Escalate to the duty manager. |
| Monitoring stopped | Immediate — **you are blind**. Restart the service; escalate to IT if it will not start. |
| Storage failed on a camera | Raise a job within 24 h — it is recording nothing. |
| Clock drift warning | Raise a job — footage timestamps are inadmissible. |

---

## Proving the system still works

`selftest` runs the whole pipeline against simulated cameras. It touches nothing real,
takes about a second, and is the fastest way to answer "is the software broken, or is
the network broken?"

```powershell
node src\cli.mjs selftest
```

Worth running after any Windows update, any change to the PC, or whenever alarms seem
to have gone quiet. If `selftest` passes and cameras still read as down, the problem is
the network or the cameras — not this software.

---

## Commands you may be asked to run

Always from the Corridor Vision folder on the monitoring PC.

```powershell
node src\cli.mjs selftest                     # does the software work here?
node src\cli.mjs doctor                       # is the config and network right?
node src\cli.mjs support                      # diagnostics bundle to send on
node src\cli.mjs probe --host 192.168.10.11   # test one camera, every layer
node src\cli.mjs report --format offline      # print the offline list
node src\cli.mjs test-alert --channel telegram
Get-Content logs\corridor-*.log -Tail 40 -Wait
Start-ScheduledTask -TaskName CorridorVision
Stop-ScheduledTask  -TaskName CorridorVision
```

---

## What to hand over at shift change

1. Current fleet health % and the count not serving video.
2. Any camera down more than an hour, and whether a job is raised.
3. Any zone-level or site-level alarm in the last 12 hours.
4. Any period where monitoring itself was stopped — and that it is an unobserved gap.
5. Any active maintenance window and when it ends.
6. **Any alarms you shelved**, why, and when the shelf expires — the next shift inherits
   the silence, and an expiring shelf will re-annunciate on their watch.
7. **Any alarms still unacknowledged**, and why they were left.
8. The number of the last report issued, so a gap in the sequence is noticed.
