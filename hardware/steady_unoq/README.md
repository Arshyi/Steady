# Steady on the Arduino UNO Q

An Arduino App Lab app: the STM32 sketch reads the accelerometer and gyroscope
and detects falls, and the Debian side serves the readings to the dashboard over
the local network.

```
Modulino Movement ──Qwiic (Wire1)──► STM32 sketch ──Bridge──► python/main.py ──WebSocket──► Settings page
        LSM6DSOX                    50 Hz + fall test          8765                       src/hardware/connection.ts
```

## Why this exists next to `../steady_wearable`

`../steady_wearable/steady_wearable.ino` targets the Nano 33 BLE family: it uses
`ArduinoBLE` and the board's built-in IMU. The UNO Q is a different machine.

- Its sketch runs on an **STM32U585 under Zephyr**, and it has **no onboard IMU**,
  so acceleration and rotation come from an external sensor — here the Modulino
  Movement (LSM6DSOX) on the Qwiic connector, which is `Wire1` (I2C4).
- The sketch cannot open a Bluetooth radio, so readings leave through the
  **Bridge** to the Linux side, which owns Wi-Fi and the network stack.
- The Qwiic connector is **3.3 V only**, and `LED_BUILTIN` (LED3, red) is
  **active LOW** — both differ from a classic UNO.

## Run it

1. Arduino App Lab → **Create new app**, name it `steady_unoq`.
2. Copy this folder's `python/`, `sketch/` and `app.yaml` into the app
   (App Lab manages `sketch/sketch.yaml`; if its FQBN differs, let App Lab
   regenerate it and keep the `Arduino_Modulino` library).
3. Plug the Modulino Movement into the Qwiic connector with a Qwiic cable.
4. Set `DEVICE_ID` in `sketch/sketch.ino` (e.g. `ST-0420`) — the dashboard pairs
   on this id.
5. Run the app. The sketch console should show:

```
[steady] Modulino Movement online
[steady] ST-UNOQ1 firmware 1.0.0
```

and the Python console:

```
[steady] ST-UNOQ1 serving ws://0.0.0.0:8765
[steady] sketch reports ST-UNOQ1;1.0.0
```

6. In the dashboard, open **Settings**, enter `ws://<board-ip>:8765`, and press
   **Connect over network**. Live readings, the self-test and pairing work the
   same as over Bluetooth or USB.

Find the board's address with `nmcli device show wlan0 | grep IP4.ADDRESS`, or
from the network panel in App Lab.

## What the sketch sends

Fifty samples a second, one Bridge call each, plus one call per fall:

| Sketch → Python | Payload |
| --- | --- |
| `steady_motion` | `"<ms>,<ax>,<ay>,<az>,<gx>,<gy>,<gz>"` g and °/s |
| `steady_fall` | `"<ms>,<peak_g>,<free_fall_ms>"` |

| Python → Sketch | Effect |
| --- | --- |
| `steady_info` | returns `"<deviceId>;<firmware>"` |
| `steady_identify` | blinks the red LED three times |

## What the Linux side serves

`ws://0.0.0.0:8765`, JSON text frames (contract in `src/hardware/protocol.ts`):

| Server → app | Meaning |
| --- | --- |
| `{"type":"hello","device":"ST-UNOQ1","firmware":"1.0.0","rate":50}` | sent once on connect |
| `{"type":"motion","t":12345,"ax":0.02,"ay":-0.01,"az":1.0,"gx":12.4,"gy":-3.1,"gz":0.8}` | one sample |
| `{"type":"fall","t":12980,"peak":3.42}` | fall confirmed by the MCU |

| App → server | Meaning |
| --- | --- |
| `{"type":"identify"}` | blink the LED |

The server is `python/steady_net.py`, a WebSocket implementation on the standard
library alone — the board has no guaranteed pip packages, and the app should not
depend on an install step.

## Forwarding to the backend (optional)

Under `CONFIG` in `python/main.py`, set `forward_url` (and `forward_token`) to
have falls POSTed the moment they happen:

```python
"forward_url": "http://192.168.1.20:8787/api/v1/ingest",
"forward_samples": False,   # leave off until the backend can take 50 Hz per resident
```

Falls always go immediately; samples only if you turn `forward_samples` on.
Databricks/analytics sits behind that backend and is not implemented here.

## Testing without the board

```bash
python hardware/steady_unoq/tools/simulator.py --port 8765
```

It speaks the same protocol (hello, 50 Hz motion, a fall every 12 s) so the
Settings page can be exercised on a laptop. It needs no third-party packages.

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
