# Steady on the Arduino UNO Q

An Arduino App Lab app: the STM32 sketch reads an MPU6050, detects falls, and the
Debian side relays the readings to the dashboard and to the two backends.
The target is the **4 GB RAM / 32 GB eMMC** model. See the
[setup and storage guide](../../docs/UNO_Q_SETUP.md) for power, operating systems
and local database recommendations.

```
MPU6050 ──I2C (SDA/SCL)► STM32 sketch ──Bridge──► python/main.py ──WebSocket──► Settings page
                          50 Hz + fall test         8765                        src/hardware/connection.ts
Button (D2→GND) ─────────► presses ─────────────────┬──HTTP──► server/ (Databricks): readings, falls, acks
Optional PN532 (I2C) ────► NFC taps (dummy for now) └──HTTP──► web/ (survey store): surveys, location, ack log
```

## Why this exists next to `../steady_wearable`

`../steady_wearable/steady_wearable.ino` targets the Nano 33 BLE family: it uses
`ArduinoBLE` and the board's built-in IMU. The UNO Q is a different machine.

- Its sketch runs on an **STM32U585 under Zephyr**, and it has **no onboard IMU**,
  so acceleration and rotation come from an **MPU6050** on the I2C header pins.
- This app sends readings through **Bridge** to the Linux Wi-Fi relay.
  It does not implement a Bluetooth transport.
- Give the MPU6050 **3.3 V only**, and note that `LED_BUILTIN` (LED3, red) is
  **active LOW** — both differ from a classic UNO.

## Run it

1. Arduino App Lab → **Create new app**, name it `steady_unoq`.
2. Copy this folder's `python/`, `sketch/` and `app.yaml` into the app
   (App Lab manages `sketch/sketch.yaml`; if its FQBN differs, let App Lab
   regenerate it and keep the `Arduino_RouterBridge` library).
3. Wire the sensor: MPU6050 SDA→dedicated SDA/D20, SCL→SCL/D21, VCC→3V3,
   GND→GND. Verify that the breakout supports 3.3 V supply and bus pull-ups.
   The address is 0x68 with AD0 low, 0x69 with it high; both are tried.
   This sketch uses `Wire`: A4/A5 require `Wire2` on recent cores, while the
   Qwiic connector requires `Wire1`.
4. Set `DEVICE_ID` in `sketch/sketch.ino` (e.g. `ST-0420`) — the dashboard pairs
   on this id. The relay adopts the MCU's ID and firmware after `steady_info`
   succeeds, retrying every five seconds while the MCU starts. It withholds
   pairing identity and backend posts until that succeeds. Configure the server
   URLs and device token below; a loopback URL on the board does not reach a
   backend running on your laptop.
5. Run the app. The sketch console should show:

```
[steady] MPU6050 online at 0x68, WHO_AM_I 0x68
[steady] ST-UNOQ1 firmware 1.2.0
```

and the Python console:

```
[steady] ST-UNOQ1 serving ws://0.0.0.0:8765
[steady] readings and falls to http://127.0.0.1:8787
[steady] surveys, location and acks to http://127.0.0.1:8788
[steady] sketch reports ST-UNOQ1;1.2.0
```

6. In the dashboard, open **Settings**, enter the board's address (`unoq.local` or
   its IP), and press **Connect over Wi-Fi** to see readings, run the self-test
   and pair the device. Bluetooth and USB controls are not in the current UI.

Find the board's address with `nmcli device show wlan0 | grep IP4.ADDRESS`, or
from the network panel in App Lab.

## Button and NFC reader

| Part | Connect to | Notes |
| --- | --- | --- |
| Momentary button | D2 and GND | `INPUT_PULLUP`, so no resistor; a press reads LOW |
| PN532 (I2C, 0x24) | SDA/D20, SCL/D21, 3V3, GND; IRQ→D3, RESET→D4 | shares the `Wire` bus with the MPU6050; verify the breakout's voltage requirements |

One press means "I'm OK". Three presses within 2.5 s start a survey, and the
gesture is decided 650 ms after the last press, so a single press reports after
about two thirds of a second. Two presses are ignored as a fumble. The LED
answers each gesture: one blink for OK, two for a tag, four for a survey.

**No NFC reader is fitted yet**, so tag taps are dummy data for now. Set
`dummy_nfc_every_s` in `python/main.py` to have the relay emit a fake tag every
few seconds, or let `tools/simulator.py` emit them. The rest of the responder
flow — the `T` line to the dashboard, `POST /api/acks` to the server, the
"via NFC tag …" note on the cleared alert — runs unchanged once a reader is
wired in. NFC is **disabled by default**. To enable it, install **Adafruit PN532**
in App Lab and set `STEADY_ENABLE_NFC` to `1` in the sketch. Installing the library
alone does not enable the reader. PN532 polling can block this shared loop for
80 ms, so 50 Hz sampling is not guaranteed with NFC enabled; move that work to
a separate task before relying on its timing.

## What the sketch sends

Fifty samples a second use `Bridge.notify("steady_motion", ...)`, without waiting
for a reply. Falls, button gestures and NFC events use `Bridge.call(...)`.
This is a transport distinction, not durable delivery to a backend.

| Sketch → Python | Payload |
| --- | --- |
| `steady_motion` | `"<ms>,<ax>,<ay>,<az>,<gx>,<gy>,<gz>"` g and °/s |
| `steady_fall` | `"<ms>,<peak_g>,<free_fall_ms>"` |
| `steady_ok` | `"<ms>,1"` — one button press, "I'm OK" |
| `steady_survey` | `"<ms>,3"` — three presses, capture this room |
| `steady_nfc` | `"<ms>,<uid hex>"` — an NFC tag was tapped on the reader |

| Python → Sketch | Effect |
| --- | --- |
| `steady_info` | returns `"<deviceId>;<firmware>"` |
| `steady_identify` | blinks the red LED three times |

## What the Linux side serves

`ws://0.0.0.0:8765`, text lines defined in `src/hardware/protocol.ts`:

| Server → app | Meaning |
| --- | --- |
| `I,ST-UNOQ1,1.2.0` | MCU-confirmed device info, sent after identity is available and in answer to `I?` |
| `M,0.02,-0.01,1.00,12.4,-3.1,0.8` | one sample (accel g, gyro °/s) |
| `F` | fall confirmed by the MCU |
| `O` | the wearer pressed the button once: "I'm OK" |
| `T,04A2339C1B80` | a responder tapped an NFC tag |
| `S,5,9` | a survey capture was stored (scans, access points) |
| `L,103,1,82` | the survey store matched the newest scan to a room |

| App → server | Meaning |
| --- | --- |
| `I?` | report the info line |
| `I` | blink the LED |
| `S` | capture the current room now (same as three presses) |

There is no `B` (battery) line: this assembly has no battery measurement, so the
dashboard shows "–". Malformed or non-finite motion values are discarded.
The server is `python/steady_net.py`, a WebSocket implementation on the
standard library alone — the board has no guaranteed pip packages, and the app
should not depend on an install step.

## What the relay posts

Set these environment variables for the Linux app; do not commit credentials:

| Variable | Purpose |
| --- | --- |
| `STEADY_SERVER_URL` | Root Node backend, e.g. `http://192.168.1.20:8787` |
| `STEADY_SURVEY_URL` | Worker survey store, e.g. `http://192.168.1.20:8788` |
| `STEADY_DEVICE_TOKEN` | The Worker's `DEVICE_TOKEN` for device write requests |

The defaults for the URLs are loopback ports 8787/8788. The device token defaults
to empty, so configure it before posting to a protected Worker. `VIEW_KEY` is a
dashboard read credential and must not be substituted for `DEVICE_TOKEN`.
Other options live in `CONFIG` at the top of `python/main.py`:

```python
"survey_scans": 5,
"survey_interval_s": 1.5,
"locate_every_s": 0,                        # default: on demand; 300 = every 5 min
"dummy_nfc_every_s": 0,                     # >0 fakes an NFC tap this often
```

Each second it summarizes the samples received and hands the result to a
background sender. That sender batches up to 60 summaries per request and waits
for the backend's database commit, with a 45-second HTTP timeout. Its bounded
300-summary RAM queue retains original timestamps and retries failed requests.
At capacity it drops new summaries with an explicit warning. This keeps normal
summary HTTP waits off the diagnostic loop; event HTTP and slow WebSocket
clients can still stall that loop. The backend payloads are:

```json
POST /api/readings {"deviceId":"ST-UNOQ1","movement":42.1,"gyroDps":84.2,"accelG":1.01}
POST /api/falls    {"deviceId":"ST-UNOQ1"}
POST /api/acks     {"deviceId":"ST-UNOQ1","kind":"ok"}            // or kind:"nfc", tag:"…"
```

`/api/acks` clears that resident's newest open alert and records who did it, so
the dashboard reads "handled at 16:48 · via I'm OK button".

The survey store is separate because fingerprints are not readings:

* Three presses run 5 Wi-Fi scans and `POST /api/v1/surveys`. The Worker stores
  the capture and fingerprints without a room label; staff label them in
  Settings before they can participate in room matching. The relay sends an
  `S` success message only after a successful store response.
* Every `locate_every_s` the board scans once and posts `/api/v1/locate`; the
  Worker matches it against the labelled fingerprints and stores where it thinks
  the device is.
* OK presses and tag taps are also logged to `/api/v1/acks`, which is what the
  Settings page's responder list reads.

The scans themselves use `nmcli`, `iw` or `iwlist`, whichever the board has;
`python/wifi_scan.py` holds the parsers and prefers real dBm from `iw`. Leave
either URL empty to run without that backend.

This integrated relay has no local SQLite database or durable retry outbox.
Summary retries survive temporary network failures only while the process and
bounded RAM queue survive. Power loss, overflow and ambiguous responses still
need a durable outbox and idempotent backend writes. Falls and acknowledgments
do not yet have equivalent retry handling.
Network failures can lose readings/events. The separate `firmware/steady/`
JSONL spool is not part of this path; see the setup guide for proposed storage.

## Testing without the board

```bash
python hardware/steady_unoq/tools/simulator.py --port 8765
```

It speaks the same protocol (`I` info, 50 Hz `M`, `F` every 12 s) and also emits
`O`, `T`, `S` and `L` lines, so the whole Settings page — including the location
panel — can be exercised on a laptop with dummy responder taps. It needs no
third-party packages.
This is a software protocol simulator, not UNO Q hardware or radio emulation.

## Tuning the fall test

The detector is a two-stage threshold: weightless (`< 0.55 g` for 100–900 ms)
then impact (`≥ 2.6 g` within 250 ms of leaving the low-g interval), or a bare
impact (`≥ 3.5 g`) if the free fall was missed, with a 3 s refractory window.
The MPU6050 uses ±8 g so those impacts are not clipped at ±2 g. It has **not**
been validated on people:

- **Test with real drops** onto a crash mat or a weighted dummy, and record the
  peak g and free-fall duration for each drop (the dashboard shows the fall
  event and its timestamp).
- Sitting down hard, dropping the sensor on a desk, or tossing it in the air can
  all cross these thresholds — that is the classic false-alarm trade-off, and the
  reason the thresholds sit in `sketch/fall_detector.h` where they are easy to
  adjust.
- There is no posture/stillness check here yet. Adding one (tilt before vs after,
  or stillness for a second) would cut the "dropped device" false alarms a lot.

If the Bridge link ever saturates, lower `SAMPLE_HZ` (25 still looks smooth in
the trace); the Linux side drops samples it cannot keep up with rather than
growing a backlog.
