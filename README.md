# Steady

Steady is a fall-detection wearable and a night-shift dashboard for a care home. The
wearable tracks movement and detects falls, a small server stores the readings, and
the dashboard shows who is asleep, who is up, who needs a check — and alerts staff
the moment someone falls.

- **Real hardware.** An Arduino UNO Q with an MPU6050 accelerometer and gyroscope.
- **Real fall detection.** Runs on the board itself, verified with deliberate drops.
- **Two transports.** USB serial, or Wi-Fi through the App Lab relay.
- **Simulated supporting cast.** Heart rate, battery, signal and the other residents,
  so the whole wing looks alive without more hardware.

This is the single README for the project: hardware, firmware, dashboard, server, the
Cloudflare Worker, and how to run the demo.

## Contents

- [At a glance](#at-a-glance)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Hardware](#hardware)
- [Fall detection](#fall-detection)
- [Dashboard](#dashboard)
- [Server](#server)
- [Device protocol](#device-protocol)
- [Wi-Fi relay (App Lab app)](#wi-fi-relay-app-lab-app)
- [Other firmware builds](#other-firmware-builds)
- [Cloudflare Worker (web/)](#cloudflare-worker-web)
- [Build and test](#build-and-test)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

## At a glance

| Part | State |
| --- | --- |
| MPU6050 accelerometer and gyroscope | **Real**, wired to an Arduino UNO Q |
| Fall detection | **Real**, runs on the board, verified with drops |
| Readings → dashboard → alerts | **Real**, over USB serial (Web Serial) |
| Pairing a device to a resident | **Real** |
| Wi-Fi relay (`hardware/steady_unoq`) | **Real.** The App Lab app runs on the board, serves the protocol on `:8765`, streams the MPU6050 to the dashboard over the network, and posts one-second summaries to `server/` |
| Heart rate, battery, signal | Dummy values from each resident's profile |
| Other residents | Shown only in Simulated mode; live mode lists only residents with a paired wearable |
| Databricks storage | Implemented, selected by env vars; every run here used the local store |

## Quick start

Requirements: Node 20+, and Chrome or Edge for the USB and Bluetooth transports.

```bash
npm install
npm run dev          # dashboard on http://localhost:5173, server on http://localhost:8787
```

No board? Open **Settings** and switch the data source to **Simulated**, or press
**Try a demo device**. To exercise the ingest path without hardware:

```bash
npm run sim:device                          # 10 Hz telemetry as ST-UNOQ1, a fall every 45 s
npm run sim:device -- --fall-every 90 --minutes 5
npm run relay:mock                          # WebSocket stand-in for the board's relay
```

With a board, see [Hardware](#hardware) for the USB path or
[Wi-Fi relay](#wi-fi-relay-app-lab-app) for the network path.

## Architecture

```
MPU6050 ──I2C──► UNO Q (STM32, Zephyr) ──USB serial──► Dashboard (Vite + React)
                        │                                     │
                        │                                     └──HTTP──► server/ ──► local JSON store
                        │                                                    └──► Databricks
                        └─ App Lab path: sketch ─Bridge─► python/main.py ─WS 8765─► Dashboard
                                                              └──HTTP──► server/ + web/

web/ is a separate Cloudflare Worker + D1: device ingest, server-side fall
analysis, and the Wi-Fi survey/location store.
```

The App Lab app publishes `8765` with a `ports:` list in
`hardware/steady_unoq/app.yaml`; without it the relay listens only inside its Docker
container and nothing on the network can reach it.

The browser connection (USB or Wi-Fi) is for setup and diagnostics: one device, one
screen. A whole wing runs through the server and the datastore.

## Repository layout

| Path | What it is |
| --- | --- |
| `src/` | Dashboard: pages, components, hardware transports, protocol |
| `server/` | Node backend: ingest, readings, alerts, pairings; local or Databricks store |
| `arduino/steady_mpu6050/` | The sketch used for the USB demo (UNO Q + MPU6050, fall detection) |
| `hardware/steady_unoq/` | App Lab app: STM32 sketch + Python relay over WebSocket |
| `firmware/steady/` | RTOS-flavoured UNO Q app: threaded sampler, waveform per fall, offline spool |
| `hardware/steady_wearable/` | Original Nano 33 BLE firmware |
| `web/` | Cloudflare Worker + D1: ingest, fall analysis, survey store |
| `hardware/HANDOFF.md` | Background, open decisions and the BLE characteristics |

## Hardware

### Wiring the MPU6050

```
MPU6050 breakout      Arduino UNO Q
  VCC   ────────────  3V3      (3.3 V logic; do not feed 5 V into SDA/SCL)
  GND   ────────────  GND
  SDA   ────────────  SDA (D20)   or  A4
  SCL   ────────────  SCL (D21)   or  A5
  AD0   ────────────  GND      (address 0x68; 0x69 if tied high)
```

`XDA`, `XCL` and `INT` are unused: the sketch polls at 200 Hz and never needs the
interrupt pin.

### I2C buses on the UNO Q

The board splits I2C across three buses, which is why the wiring is confusing:

| Bus | Pins | In code |
| --- | --- | --- |
| Default | SDA/SCL silkscreen (D20/D21) | `Wire` |
| Qwiic connector | Qwiic | `Wire1` |
| Secondary | A4/A5 | `Wire2` |

The sketch probes `Wire` and then `Wire2` and keeps whichever answers at `0x68`, so
either wiring works. It reports the winner in the serial log.

### Wiring the button

The button's two legs go to **D2** and **D4**. No GND wire is needed: the sketch
drives D4 low and holds D2 up through its pull-up, so a press shorts the two and D2
reads LOW.

| Button leg | Pin |
| --- | --- |
| A | D2 (pulled up, read) |
| B | D4 (driven low) |

Either leg order works - a button is not polarised. The same sketch also runs with
the old D2-to-GND wiring, because D4 idling low changes nothing.

| Gesture | Result |
| --- | --- |
| One press | "I'm OK": the fall drops to the lowest urgency and still needs a visit |
| Three presses within 2.5 s | Survey mode: the Linux side scans Wi-Fi |
| Two presses | Ignored as a fumbled double tap |

### How a fall is triaged

A fall stays on the Alerts page until a member of staff marks it checked. Pressing
"I'm OK" never closes it: it only moves the fall down the list.

| Urgency | What happened | Badge on the row |
| --- | --- | --- |
| Highest | Fell, and nothing has moved since | No movement since the fall |
| Middle | Fell, and no "I'm OK" press | Not acknowledged yet |
| Lowest | Fell, and the wearer pressed "I'm OK" | Says they’re OK |

The highest tier wins even after a press: lying still matters more than pressing a
button. Movement has to come from the device itself, so the demo fill cannot clear
it. **Mark checked**, pressed by staff on the dashboard, is the only thing that
removes a fall from the queue.

A gesture is decided after 650 ms with no further press, so a single press reports
shortly after you release rather than instantly. Presses are debounced for 25 ms.

D4 is shared with the optional PN532 reader's reset line, so move that jumper to a
free pin if you fit the reader.

### Flash the sketch

1. Open `arduino/steady_mpu6050/steady_mpu6050.ino` in the Arduino IDE.
2. Install **Arduino_RouterBridge** from the Library Manager. The UNO Q core refuses
   to compile without it, because `Serial` is routed through the board's Linux side.
3. Select **Arduino UNO Q** and the port (`USB Serial Device (COM4)` on Windows),
   then upload. The board flashes over ADB, not the serial port.
4. Open the Serial Monitor at **115200 baud** and leave the board still for the first
   second: that is when the gyro zero-rate offset is measured.

From a shell (Arduino IDE 2.x bundles this CLI):

```bash
arduino-cli compile -b arduino:zephyr:unoq arduino/steady_mpu6050
arduino-cli upload  -b arduino:zephyr:unoq -p COM4 arduino/steady_mpu6050
```

Expected output:

```
# MPU6050 on SDA/SCL (Wire)
# gyro bias (raw) 12.0 -4.0 7.0
I,UNO-MPU1,1.2.0
M,0.021,-0.004,1.003,0.4,-0.2,0.1
```

Lying flat, `az` should be close to `1.000`, `ax`/`ay` near `0`, and the gyro near
`0` when still. The `#` lines are diagnostics and are ignored by the dashboard. The
sketch uses ±8 g and ±250 °/s (±2 g clipped hard landings); if you change `REG_ACCEL_CONFIG` or
`REG_GYRO_CONFIG`, update `ACCEL_LSB_PER_G` and `GYRO_LSB_PER_DPS` to match.

### Run the USB demo

Open the dashboard's **Settings** screen, choose **Live devices**, click **Connect
Arduino (USB)**, and pick the board's port (Chrome or Edge only).

The panel should show `UNO-MPU1`, about 40 samples/s (the sketch asks for 50; the
board's serial bridge adds a few milliseconds per line), with **Accelerometer reads
gravity** and, once you turn the board, **Gyroscope responds** ticked. Pick a
resident and press **Pair**: the browser then sends a one-second summary to the
server, so that room follows the real sensor.

The device id is `UNO-MPU1`; change it in the sketch if you run more than one board.

## Fall detection

The board decides for itself whether a drop was a fall:

- the sensor goes weightless: `|a|` under **0.60 g**
- then takes a hard impact: over **1.8 g**, within 1.2 s
- a landing harder than **3.0 g** counts even if the board lands flat
- a posture change of **40°** or more raises the confidence and is reported

On a fall it prints one line, which the dashboard turns into the alert text:

```
F,6.0,82,88        peak g, posture change in degrees, confidence
```

Sampling matters more than the thresholds: the sensor is read at **200 Hz** for
detection and printed at about **40 Hz**, because a landing spike lasts only a few
tens of milliseconds and the serial link cannot see that often. Sampling at the
print rate is why a drop can look like "signals arrive but no fall". `# weightless`
and `# impact … g` diagnostics appear in the Serial Monitor while tuning, and
`FALL_COOLDOWN_MS` (5 s) stops one drop from firing repeatedly.

These thresholds are where tuning starts, not where it ends. Test with deliberate
drops onto a mat before showing anyone a fall alert, and note that a fall only
reaches the dashboard when the device is paired to a resident.

## Dashboard

Pages: **Home** (the wing at a glance), **Residents**, **Alerts** (sorted by urgency,
mark checked, Undo), **Settings** (data source, connection, self-test, pairing).

**Data sources** in Settings:

- **Simulated** — the server generates readings for every resident.
- **Live devices** — only real wearables count. Residents appear only once a device
  is paired to them; everyone else stays hidden until then.

With the local store, `DEMO_FILL=1 npm run dev` fills unpaired residents with dummy
`DEMO-<room>` devices so the wing looks populated around one real sensor.

**Self-test** rows while a device is connected: sending data, accelerometer reads
gravity, gyroscope responds, fall detection fires.

## Server

`server/` is a small Node backend between the dashboard and the store. It creates its
tables on first start, runs the simulator in **Simulated** mode, serves `/api/state`
(polled every 3 s), and accepts readings and falls from devices.

| Endpoint | Used by |
| --- | --- |
| `GET /api/state` | Every screen |
| `GET /api/devices` | Settings, "devices the server has seen" |
| `GET /api/v1/health` | Health check, reports the store in use |
| `POST /api/v1/ingest` | Device batches: `{device, firmware, samples[], events[], heartbeat}` |
| `POST /api/mode` `{mode}` | Settings, data source |
| `POST /api/alerts/:id/handle` and `/undo` | Alerts, Acknowledge / Done / Undo |
| `POST /api/pairings` `{residentId, deviceId, firmware}` | Settings, Pair |
| `POST /api/readings` | Devices, the relay, or Settings with a device connected |
| `POST /api/falls` `{deviceId, detail}` | Fast path for a fall |
| `POST /api/acks` `{deviceId, kind, tag}` | "I'm OK" button and NFC taps |
| `POST /api/simulate/fall` `{residentId}` | Settings, demo a fall |

Batched ingest folds 10–200 Hz samples into one reading per second, and each event
raises a fall alert with the peak g and posture change in its detail. If
`DEVICE_TOKEN` is set, devices must send `Authorization: Bearer <token>`; when it is
unset the endpoint accepts anyone and the server logs a warning.

`movement` is 0–100: mean gyroscope magnitude in °/s divided by 2, capped at 100.

### Storage

Configured by `server/.env` (copy `server/.env.example`):

```
DATABRICKS_HOST=https://your-workspace.cloud.databricks.com
DATABRICKS_WAREHOUSE_ID=your-sql-warehouse-id
DATABRICKS_SCHEMA=workspace.steady
PORT=8787
DEVICE_TOKEN=
```

With both Databricks variables set the server uses your Databricks CLI login and the
tables `residents`, `devices`, `pairings`, `readings`, `alerts` and `app_settings`.
Without them it uses a local store: data mode, pairings and firmware versions live in
`server/.data/local.json` (gitignored), readings and alerts in memory. Everything the
dashboard shows, the ingest endpoint and the simulator behave the same on either
store.

## Device protocol

One text line per message. USB serial, the Wi-Fi relay and the simulators all speak
it, and the contract lives in `src/hardware/protocol.ts`.

Device to app:

| Line | Meaning |
| --- | --- |
| `I,UNO-MPU1,1.2.0` | device id and firmware, every 2 s |
| `B,87` | battery percent (the UNO Q cannot measure it and sends none) |
| `M,ax,ay,az,gx,gy,gz` | one sample: accel in g, gyro in °/s |
| `F,peak,tilt,confidence` | fall confirmed by the board (`F` alone is also valid) |
| `O` | the wearer pressed the button once: "I'm OK" |
| `T,04A2339C1B80` | a staff member tapped an NFC tag |
| `S,5,9` | a survey capture was stored (scans, access points) |
| `L,103,1,82` | the survey store placed the device in room 103, floor 1, 82% sure |

App to device: `I?` asks for the info line, `I` blinks the light so staff can find
the device, `S` captures the current room.

## Wi-Fi relay (App Lab app)

`hardware/steady_unoq/` runs the wearable without USB. The STM32 sketch reads the
MPU6050 and detects falls; the Debian side (`python/main.py`) serves the protocol
over `ws://0.0.0.0:8765` and posts a one-second summary to `/api/readings`, falls to
`/api/falls`, and "I'm OK"/NFC taps to `/api/acks`. It also runs survey mode: three
button presses scan Wi-Fi and post fingerprints to the Worker, and later scans are
matched to a room and stored as a location. A button across D2 and D4 and an optional
PN532 on the same I2C bus are supported; no reader is fitted yet, so tag taps are
dummy unless `dummy_nfc_every_s` is set.

Simulate it without a board:

```bash
python hardware/steady_unoq/tools/simulator.py --port 8765
```

Then connect the dashboard over Wi-Fi to `127.0.0.1`.

### Verified on the board

The UNO Q and the laptop are both on `ubcIoT` (WPA2-Personal from iot.ubc.ca, which
does not isolate a user's own devices), the app is installed at
`~/ArduinoApps/steady_unoq`, and the relay publishes `8765`. Verified:
`ws://<board>:8765` answers `I,ST-UNOQ1,1.2.1` and then streams `M,…` lines sampled
at ~48 Hz; `server_url` is set to the laptop's LAN address, so summaries reach
`server/`; and the Settings page connects over Wi-Fi and shows live accelerometer
and gyroscope values. The button has been pressed on the real board: one press posts
an "I'm OK" ack (the server records `acknowledgedBy`) that only lowers the fall's
urgency, and three presses fire the survey gesture.

Set the server address before installing: copy `python/config.example.json` to
`python/config.json` (git-ignored, so each laptop keeps its own) and set
`server_url` to the laptop's address on the board's Wi-Fi, port 8787, e.g.
`http://10.200.3.118:8787`. `127.0.0.1` on the board means the board itself, so
uploads go nowhere. The relay prints the address it uses when it starts.
`STEADY_SERVER_URL` overrides the file. `survey_url` is separate and can stay empty
until the Worker in `web/` is running somewhere the board can reach.

If the server runs inside WSL, the board can't reach it on WSL's private address.
Turn on mirrored networking (`[wsl2]` / `networkingMode=mirrored` in
`%UserProfile%\.wslconfig`, then `wsl --shutdown`) and allow port 8787 through the
Windows firewall.

### Two things that are easy to get wrong

- **`ports:` in `app.yaml` takes plain integers** (`ports:` then `- 8765`). The
  Compose-style `- "8765:8765"` string is rejected with
  `cannot unmarshal string into Go struct field AppDescriptor.Ports of type int` and
  the app refuses to start.
- **A4/A5 on the UNO Q is `Wire2`, not `Wire`.** The pins labelled SDA/SCL are
  D20/D21 on plain `Wire`. The sketch probes both buses and keeps whichever answers
  at `0x68`; a sketch that only calls `Wire.begin()` finds no IMU on A4/A5 and
  silently publishes nothing.

### Autostart after a reboot

The App CLI daemon (`arduino-app-cli.service`) starts at boot, but it does not start
apps: a board that reboots leaves `:8765` closed until someone runs
`arduino-app-cli app start` by hand. The `arduino` user's crontab starts the app
instead, which needs no elevated privileges:

```bash
crontab -l        # on the board, as arduino; should show:
@reboot /home/arduino/steady-autostart.sh
```

`~/steady-autostart.sh` waits for the daemon on `:8800`, runs
`arduino-app-cli app start /home/arduino/ArduinoApps/steady_unoq`, retries until
`:8765` answers, and appends to `~/steady-autostart.log`. It exits immediately when
the relay is already listening, so it is safe to run by hand. The board gives
`arduino` only a few specific passwordless root commands, and none of them reboot,
so `adb reboot`, `systemctl reboot` and `reboot` all fail; a power cycle is the only
way to boot it. Verified by stopping the app, then running the `@reboot` command with
`env -i` (the environment cron gives it): the relay came back and streamed within
about 45 seconds. A full power cycle has not been run since this was installed.

### Not yet proven

The survey *scan* cannot work as shipped. Three presses fire the gesture and the
relay logs `survey: scanning the room…`, then `no Wi-Fi scans came back`: the App Lab
container has no `nmcli`, no `iw` and no `/run/dbus`, so there is nothing to query
NetworkManager with. The gesture path is proven; the scanning needs wireless tools
in the container or a helper on the host side.

NFC taps are untested because no reader is fitted, and the `web/` Worker store was
not reachable from the board.

## Other firmware builds

**`firmware/steady/` — RTOS app with waveform capture.** A Zephyr build with a 200 Hz
sampler thread, a detector thread, an orientation filter, a per-fall waveform ring
buffer, and a Python uplink that spools to disk while the network is down and replays
oldest-first. Bridge RPCs expose `steady_status`, `steady_event_meta`,
`steady_event_chunk`, `steady_event_ack` and `steady_set_thresholds`; configuration
lives in `sketch/config.h` and `FallConfig`. Host tests need no board:
`tools/run_host_test.sh` (or `tools\build_host_test.bat` on Windows) compiles the
detector and runs seven synthetic scenarios, ending with `ALL CHECKS PASSED`.

**`hardware/steady_wearable/` — Nano 33 BLE.** The original firmware: reads its
onboard IMU 50 times a second, detects falls with a free-fall/impact threshold, and
speaks the same lines over BLE notify or USB serial.

## Cloudflare Worker (web/)

A separate Worker + D1 on port 8788 for device ingest, server-side fall analysis and
the survey store. It applies `schema.sql` on start, so there is no migration step.

```bash
cd web
npm run dev                 # http://127.0.0.1:8788 (wrangler)
npm test                    # node --test: analysis engine + location matcher
npm run simulate -- --url http://127.0.0.1:8788 --token dev-token --device steady-001 --minutes 30 --fall
```

Local secrets go in `web/.dev.vars`: `DEVICE_TOKEN` for devices and `VIEW_KEY` for the
dashboard's read key. The API covers ingest, health, devices, summary, series, events
(with waveform and review labels), CSV export, surveys, locate, location and acks.
Ingest is idempotent per `(device, ts)` and event `uid`, so a device replaying its
offline spool does not duplicate rows. Retention is 30 days for samples, kept until
deleted for events.

Room location is mean absolute RSSI distance over shared access points, with two
required in common; it is room-level, not a position, and confidence drops when only
a couple of APs overlap.

Deploy with `npx wrangler d1 create steady` (put the id in `wrangler.jsonc`), then
`npx wrangler secret put DEVICE_TOKEN`, `npx wrangler secret put VIEW_KEY`, and
`npx wrangler deploy`.

## Build and test

```bash
npm run build                                   # type-checks the dashboard (tsc -b) and bundles it
arduino-cli compile -b arduino:zephyr:unoq arduino/steady_mpu6050
cd web && npm test                              # Worker analysis + location tests
firmware/steady/tools/run_host_test.sh          # detector host tests (no board)
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `butterfly_recv … failed` on upload | avrdude was aimed at an AVR board. Select **Arduino UNO Q**, not Arduino Uno |
| `Please install the Arduino_RouterBridge library` | Install it from the Library Manager; the UNO Q core requires it for `Serial` |
| `adb.exe: device offline` | The board's Linux side is not up. Unplug USB-C, wait five seconds, replug, wait ~30 s |
| `# MPU6050 not found at 0x68` | Power or wiring. Check 3V3 and GND, swap SDA/SCL, reseat jumpers; the sketch retries every 5 s |
| `Access to the port 'COM4' is denied` | The Arduino IDE's Serial Monitor, or another tab, holds the port. Close it; the dashboard needs exclusive access |
| Signals arrive but no fall fires | Sampling too slow to catch the impact spike, or the device is unpaired. This firmware samples at 200 Hz and only forwards falls when paired |
| Gyro drifts slowly | The bias calibration ran while the board was moving. Reset it and leave it still for a second |
| `Connect Arduino (USB)` is disabled | The browser has no Web Serial. Use Chrome or Edge on desktop |
| Nothing reaches the dashboard | The data source must be **Live devices** and the device paired |
| Board joins Wi-Fi but nothing connects | A captive portal or client isolation. `curl http://captive.apple.com/hotspot-detect.html` on the board returns the portal page; use a network where your own devices see each other |
| `invalid library reference: Adafruit PN532 ()` | `sketch/sketch.yaml` lists a library that is not installed on the board. The NFC reader is optional: leave the entry out and the sketch compiles the NFC block out |
| `cannot unmarshal string into Go struct field AppDescriptor.Ports of type int` | `ports:` in `app.yaml` wants bare integers (`- 8765`), not `"8765:8765"` |
| Relay logs `skipping`/no `M,…` lines, `ss -ltn` has no 8765 | Either `ports:` is missing from `app.yaml` or the sketch found no IMU. `docker logs steady_unoq-main-1` shows which |
| Button does nothing | It must straddle D2 and D4, and D4 must not be driven by another device (the optional PN532 reset). Check nothing else is wired to D4 |
| Readings arrive but the server ignores them | `pair ST-UNOQ1 to a resident` — pair it in Settings → "Wearables reporting in" |

## Known limitations

- **No authentication on the dashboard API.** `/api/state`, `/api/mode`,
  `/api/pairings`, `/api/falls` and `/api/acks` are open to anyone who can reach the
  server, and `/api/state` contains resident names, rooms and heart rates.
  `DEVICE_TOKEN` is optional.
- **This is health data with no retention or export policy** on the server side.
- **Battery and signal are simulated**; the UNO Q cannot measure a battery.
- **Fall detection is a threshold, not a certified detector.** It is tuned on drops,
  not on people; validate before anyone relies on it.
- **Databricks has not been exercised end to end** in this workspace; the local store
  has.
- **One device per screen** over USB/Wi-Fi; a whole wing needs the relay path.
- **Survey mode fires but cannot scan** from inside the App Lab container; see
  [Not yet proven](#not-yet-proven).
- **The Wi-Fi path runs, but only what was exercised is proven.** Wi-Fi join, the
  relay on `:8765`, live readings to the dashboard, server summaries and pairing have
  all run on the real board. See [Not yet proven](#not-yet-proven) for what has not.
- `web/` echoes any CORS origin, and `DEVICE_TOKEN` is shared by all devices. Restrict
  the origin and move to per-device tokens before deploying.

Open product decisions (board placement, battery and enclosure, gateway hardware,
data retention) are tracked in `hardware/HANDOFF.md`.
