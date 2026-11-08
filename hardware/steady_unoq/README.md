# Steady on the Arduino UNO Q

An Arduino App Lab app: the STM32 sketch reads an MPU6050, detects falls, and the
Debian side relays the readings to the dashboard and to the two backends.

```
MPU6050 ──I2C (A4/A5)──► STM32 sketch ──Bridge──► python/main.py ──WebSocket──► Settings page
                          50 Hz + fall test         8765                        src/hardware/connection.ts
Button (D2→GND) ─────────► presses ─────────────────┬──HTTP──► server/ (Databricks): readings, falls, acks
Optional PN532 (I2C) ────► NFC taps (dummy for now) └──HTTP──► web/ (survey store): surveys, location, ack log
```

## Why this exists next to `../steady_wearable`

`../steady_wearable/steady_wearable.ino` targets the Nano 33 BLE family: it uses
`ArduinoBLE` and the board's built-in IMU. The UNO Q is a different machine.

- Its sketch runs on an **STM32U585 under Zephyr**, and it has **no onboard IMU**,
  so acceleration and rotation come from an **MPU6050** on the I2C header pins.
- The sketch cannot open a Bluetooth radio, so readings leave through the
  **Bridge** to the Linux side, which owns Wi-Fi and the network stack.
- Give the MPU6050 **3.3 V only**, and note that `LED_BUILTIN` (LED3, red) is
  **active LOW** — both differ from a classic UNO.

## Run it

1. Arduino App Lab → **Create new app**, name it `steady_unoq`.
2. Copy this folder's `python/`, `sketch/` and `app.yaml` into the app
   (App Lab manages `sketch/sketch.yaml`; if its FQBN differs, let App Lab
   regenerate it and keep the `Arduino_RouterBridge` library).
3. Wire the sensor: MPU6050 SDA→A4, SCL→A5, VCC→3V3, GND→GND. The address is
   0x68 with AD0 low, 0x69 with it high; both are tried.
4. Set `DEVICE_ID` in `sketch/sketch.ino` (e.g. `ST-0420`) — the dashboard pairs
   on this id — and point `CONFIG` in `python/main.py` at your server.
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
   its IP), and press **Connect over Wi-Fi**. Live readings, the self-test and
   pairing work the same as over Bluetooth or USB.

Find the board's address with `nmcli device show wlan0 | grep IP4.ADDRESS`, or
from the network panel in App Lab.

## Button and NFC reader

| Part | Connect to | Notes |
| --- | --- | --- |
| Momentary button | D2 and GND | `INPUT_PULLUP`, so no resistor; a press reads LOW |
| PN532 (I2C, 0x24) | A4 (SDA), A5 (SCL), 3V3, GND | shares the bus with the MPU6050 |

One press means "I'm OK". Three presses within 2.5 s start a survey, and the
gesture is decided 650 ms after the last press, so a single press reports after
about two thirds of a second. Two presses are ignored as a fumble. The LED
answers each gesture: one blink for OK, two for a tag, four for a survey.

**No NFC reader is fitted yet**, so tag taps are dummy data for now. Set
`dummy_nfc_every_s` in `python/main.py` to have the relay emit a fake tag every
few seconds, or let `tools/simulator.py` emit them. The rest of the responder
flow — the `T` line to the dashboard, `POST /api/acks` to the server, the
"via NFC tag …" note on the cleared alert — runs unchanged once a reader is
wired in. NFC is compiled in only when App Lab has the **Adafruit PN532**
library installed (`__has_include`); without it the Monitor prints
`[steady] NFC off: no reader fitted…` and every other feature keeps working.

## What the sketch sends

Fifty samples a second, one Bridge call each, plus one call per event:

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

`ws://0.0.0.0:8765`, text lines — the same ones USB serial uses, so one parser
covers both (contract in `src/hardware/protocol.ts`):

| Server → app | Meaning |
| --- | --- |
| `I,ST-UNOQ1,1.2.0` | device info, sent on connect and in answer to `I?` |
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

There is no `B` (battery) line: the UNO Q cannot measure it, so the dashboard
shows "–". The server is `python/steady_net.py`, a WebSocket implementation on the
standard library alone — the board has no guaranteed pip packages, and the app
should not depend on an install step.

## What the relay posts

`CONFIG` at the top of `python/main.py`:

```python
"server_url": "http://192.168.1.20:8787",   # server/ — Databricks
"survey_url": "http://127.0.0.1:8788",      # web/ — survey store
"survey_key": "dev-view-key",               # VIEW_KEY from web/.dev.vars
"survey_scans": 5,
"survey_interval_s": 1.5,
"locate_every_s": 300,                      # scan and match every 5 min (0 = on demand)
"dummy_nfc_every_s": 0,                     # >0 fakes an NFC tap this often
```

Every second it averages the last second of samples and posts them exactly like
`server/mock-relay.ts` does:

```json
POST /api/readings {"deviceId":"ST-UNOQ1","movement":42.1,"gyroDps":84.2,"accelG":1.01}
POST /api/falls    {"deviceId":"ST-UNOQ1"}
POST /api/acks     {"deviceId":"ST-UNOQ1","kind":"ok"}            // or kind:"nfc", tag:"…"
```

`/api/acks` clears that resident's newest open alert and records who did it, so
the dashboard reads "handled at 16:48 · via I'm OK button".

The survey store is separate because fingerprints are not readings:

* Three presses run 5 Wi-Fi scans and `POST /api/v1/surveys`. Nothing is stored
  until someone names the room in the dashboard's Settings page, so a capture
  taken in the wrong place costs one row, not a wrong fingerprint.
* Every `locate_every_s` the board scans once and posts `/api/v1/locate`; the
  Worker matches it against the labelled fingerprints and stores where it thinks
  the device is.
* OK presses and tag taps are also logged to `/api/v1/acks`, which is what the
  Settings page's responder list reads.

The scans themselves use `nmcli`, `iw` or `iwlist`, whichever the board has;
`python/wifi_scan.py` holds the parsers and prefers real dBm from `iw`. Leave
either URL empty to run without that backend.

## Testing without the board

```bash
python hardware/steady_unoq/tools/simulator.py --port 8765
```

It speaks the same protocol (`I` info, 50 Hz `M`, `F` every 12 s) and also emits
`O`, `T`, `S` and `L` lines, so the whole Settings page — including the location
panel — can be exercised on a laptop with dummy responder taps. It needs no
third-party packages.

## Tuning the fall test

The detector is a two-stage threshold: weightless (`< 0.55 g` for 100–900 ms)
then impact (`≥ 2.6 g`), or a bare impact (`≥ 3.5 g`) if the free fall was
missed, with a 3 s refractory window. It has **not** been validated on people:

- **Test with real drops** onto a crash mat or a weighted dummy, and record the
  peak g and free-fall duration for each drop (the dashboard shows the fall
  event and its timestamp).
- Sitting down hard, dropping the sensor on a desk, or tossing it in the air can
  all cross these thresholds — that is the classic false-alarm trade-off, and the
  reason the thresholds sit at the top of `sketch.ino` where they are easy to
  adjust.
- There is no posture/stillness check here yet. Adding one (tilt before vs after,
  or stillness for a second) would cut the "dropped device" false alarms a lot.

If the Bridge link ever saturates, lower `SAMPLE_HZ` (25 still looks smooth in
the trace); the Linux side drops samples it cannot keep up with rather than
growing a backlog.
