# Steady

Steady is a fall-detection wearable and a night-shift dashboard for a care home. An
Arduino UNO Q reads an MPU6050, detects falls on the board, and sends readings over
USB or Wi-Fi. A Node server stores them, and the dashboard shows who is asleep, who
is up, and which fall needs a response.

## Status

| Part | State |
| --- | --- |
| UNO Q + MPU6050 | Real hardware |
| Fall detection | Runs on the board, tested with drops |
| Readings, alerts, pairing | Real, over USB or the Wi-Fi relay |
| Heart rate, battery, signal | Simulated |
| Databricks store | Implemented, not exercised end to end; the local store is tested |

There is no NFC reader; a worker confirms a response with the button.

## Quick start

Node 20+, and Chrome or Edge for Web Serial.

```bash
npm install
npm run dev     # dashboard http://localhost:5173, server http://localhost:8787
```

No board: Settings -> Simulated, or:

```bash
npm run sim:device     # 10 Hz telemetry as ST-UNOQ1, a fall every 45 s
npm run relay:mock     # WebSocket stand-in for the board relay
```

## Architecture

```
MPU6050 -> UNO Q -> USB serial -> dashboard (Vite + React)
                  \-> python/main.py -> WS 8765 -> dashboard
                                     \-> HTTP -> server/ -> local JSON or Databricks

web/ is a separate Cloudflare Worker + D1 for device ingest and surveys.
```

The browser connection handles one device for setup and diagnostics. A whole wing
runs through `server/`.

## Hardware

### MPU6050

| MPU6050 | UNO Q |
| --- | --- |
| VCC | 3V3, never 5 V on SDA/SCL |
| GND | GND |
| SDA | SDA (D20) or A4 |
| SCL | SCL (D21) or A5 |
| AD0 | GND, address 0x68 |

A4/A5 are `Wire2`; D20/D21 are `Wire`. The sketch probes both and keeps whichever
answers at `0x68`. `XDA`, `XCL` and `INT` are unused.

### Button

The button spans D2 and D4: D4 is driven low, D2 is pulled up, and a press shorts
them. No GND wire is needed.

| Gesture | Result |
| --- | --- |
| One press | Worker confirms they responded: the fall drops to the lowest urgency and stays open |
| Three presses within 2.5 s | Survey mode: the Linux side scans Wi-Fi |
| Two presses | Ignored as a fumbled double tap |

A gesture is decided after 650 ms with no further press; presses are debounced 25 ms.

### Fall detection

The board samples at 200 Hz and decides for itself:

- weightless: `|a|` under 0.60 g
- impact: over 1.8 g within 1.2 s, or over 3.0 g even when landing flat
- posture change of 40 degrees or more raises confidence

It prints `F,peak,tilt,confidence`; the dashboard turns that into an alert. Printing
happens at about 40 Hz, and sampling at that rate is why a drop can be missed. Tune
thresholds on deliberate drops onto a mat before showing anyone an alert.

### Flashing

1. Open `arduino/steady_mpu6050/steady_mpu6050.ino`.
2. Install **Arduino_RouterBridge** from Library Manager.
3. Select Arduino UNO Q and upload. It flashes over ADB, not the serial port.
4. Open Serial Monitor at 115200 baud and leave the board still for the first second
   so the gyro bias is measured.

```bash
arduino-cli compile -b arduino:zephyr:unoq arduino/steady_mpu6050
arduino-cli upload  -b arduino:zephyr:unoq -p COM4 arduino/steady_mpu6050
```

## Triage

A fall stays on the Alerts page until a member of staff clicks **Mark checked**. A
worker pressing the button only moves it down the list.

| Urgency | What happened | Badge |
| --- | --- | --- |
| Highest | Fell, nothing moved since | No movement since the fall |
| Middle | Fell, no worker has confirmed | No worker yet |
| Lowest | Fell, a worker confirmed they responded | Worker responded |

The highest tier wins even after a press: lying still matters more than a response.
Movement must come from the device, so demo fill cannot clear it.

## Dashboard

Pages: Home, Residents, Alerts (urgency order, Mark checked, Undo), Settings (data
source, connection, self-test, pairing).

- Simulated: the server generates readings for every resident.
- Live devices: only paired wearables count; other residents stay hidden.

`DEMO_FILL=1 npm run dev` fills unpaired residents with dummy `DEMO-<room>` devices.
Self-test reports sending data, accelerometer reads gravity, gyroscope responds and
fall detection fires.

## Server

`server/` stores readings, alerts and pairings and serves `/api/state` (polled every
3 s). Main endpoints:

| Endpoint | Used by |
| --- | --- |
| `GET /api/state`, `/api/devices`, `/api/v1/health` | Dashboard and health checks |
| `POST /api/v1/ingest` | Device batches |
| `POST /api/mode`, `/api/pairings`, `/api/readings`, `/api/falls`, `/api/acks` | Settings, devices and the relay |
| `POST /api/alerts/:id/handle`, `/undo` | Alerts |
| `POST /api/simulate/fall` | Demo a fall |

Batched ingest folds 10-200 Hz samples into one reading per second. `DEVICE_TOKEN` is
optional; without it ingest accepts anyone and the server warns. `movement` is 0-100:
mean gyro magnitude in degrees/second divided by 2, capped at 100.

### Storage

Copy `server/.env.example` to `server/.env`:

```
DATABRICKS_HOST=https://your-workspace.cloud.databricks.com
DATABRICKS_WAREHOUSE_ID=your-sql-warehouse-id
DATABRICKS_SCHEMA=workspace.steady
PORT=8787
DEVICE_TOKEN=
```

With both Databricks variables the server uses Databricks. Without them it uses
`server/.data/local.json` (gitignored) for mode and pairings, with readings and alerts
in memory.

## Device protocol

One text line per message; the contract is `src/hardware/protocol.ts`.

| Line | Meaning |
| --- | --- |
| `I,UNO-MPU1,1.2.0` | device id and firmware, every 2 s |
| `B,87` | battery percent |
| `M,ax,ay,az,gx,gy,gz` | accel in g, gyro in degrees/second |
| `F,peak,tilt,confidence` | fall confirmed; `F` alone is valid |
| `O` | a worker confirmed they responded |
| `S,5,9` | survey capture stored |
| `L,103,1,82` | placed in room 103, floor 1, 82% sure |

App to device: `I?` asks for info, `I` blinks the light, `S` captures the room.

## Wi-Fi relay

`hardware/steady_unoq/` runs the wearable without USB. The STM32 sketch reads the
MPU6050 and detects falls; `python/main.py` serves the protocol on `ws://0.0.0.0:8765`
and posts one-second summaries, falls and worker responses to the server. Survey mode
posts fingerprints to the Worker.

```bash
python hardware/steady_unoq/tools/simulator.py --port 8765
```

Verified on the real board: `ws://<board>:8765` answers `I,ST-UNOQ1,1.2.1`, streams
`M,...` at about 48 Hz, and the dashboard connects over Wi-Fi.

- `app.yaml` needs plain integer ports (`- 8765`), not `"8765:8765"`.
- Set `server_url` to the laptop's LAN address before installing; `127.0.0.1` on the
  board means the board itself.
- The `arduino` user's crontab runs `~/steady-autostart.sh` at reboot; App Lab's
  daemon does not start apps.
- Survey scanning cannot work inside the App Lab container: no `nmcli`, `iw` or
  `/run/dbus`. The gesture fires but no scan returns.

## Cloudflare Worker (web/)

A separate Worker + D1 on port 8788 for ingest, server-side fall analysis and the
survey store. It applies `schema.sql` on start.

```bash
cd web
npm run dev
npm test
npm run simulate -- --url http://127.0.0.1:8788 --token dev-token --device steady-001 --minutes 30 --fall
```

Local secrets go in `web/.dev.vars`: `DEVICE_TOKEN` and `VIEW_KEY`. Ingest is
idempotent per `(device, ts)` and event `uid`; samples are kept 30 days, events until
deleted. Room location is RSSI distance over shared access points, room-level rather
than a position.

## Build and test

```bash
npm run build
arduino-cli compile -b arduino:zephyr:unoq arduino/steady_mpu6050
cd web && npm test
firmware/steady/tools/run_host_test.sh
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `butterfly_recv ... failed` on upload | Select Arduino UNO Q, not Arduino Uno |
| `Please install the Arduino_RouterBridge library` | Install it from Library Manager |
| `adb.exe: device offline` | Replug USB-C and wait about 30 s for the Linux side |
| `# MPU6050 not found at 0x68` | Check 3V3 and GND, swap SDA/SCL, reseat jumpers; it retries every 5 s |
| `Access to the port 'COM4' is denied` | Close the IDE Serial Monitor or another tab holding the port |
| Signals arrive but no fall | Sampling too slow, or the device is unpaired |
| Nothing reaches the dashboard | Set Live devices and pair the device |
| Relay has no `M,...` lines or no port 8765 | Check `ports:` in `app.yaml` and `docker logs steady_unoq-main-1` |
| Readings arrive but the server ignores them | Pair `ST-UNOQ1` in Settings |

## Known limitations

- Auth is optional. Without Auth0 configured, the dashboard API accepts anyone and
  `/api/state` exposes names, rooms and heart rates. `DEVICE_TOKEN` is optional too.
- No retention or export policy for server-side health data.
- Battery and signal are simulated; the UNO Q cannot measure battery.
- Fall detection is a threshold, not a certified detector.
- Databricks has not been exercised end to end here.
- One device per screen over USB/Wi-Fi; a whole wing needs the relay path.
- Survey mode fires but cannot scan inside the App Lab container.
- `web/` echoes any CORS origin and uses one shared `DEVICE_TOKEN`.

Open product decisions (board placement, battery, enclosure, gateway, retention) are
in `hardware/HANDOFF.md`.
