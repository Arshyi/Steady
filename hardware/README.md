# Steady hardware

Two wearable firmwares live here. They send the same six channels in the same
units, so the dashboard code is shared; they differ in how the data leaves the
device.

| | `steady_wearable/` | `steady_unoq/` |
| --- | --- | --- |
| Board | Nano 33 BLE / BLE Sense / 33 IoT / RP2040 Connect | **Arduino UNO Q** |
| IMU | the board's own (BMI270, LSM9DS1, LSM6DS3, LSM6DSOX) | external **MPU6050** over I2C |
| Link to the app | BLE notify, or USB serial text lines | **Wi-Fi/LAN**: sketch → Bridge → Python → WebSocket |
| Browser side | `connectBluetooth`, `connectUsb` | `connectWifi` |
| Best for | a tablet next to one resident | a device that stays on the care network |

Both speak the contract in `src/hardware/protocol.ts`.

## The UNO Q app

`steady_unoq/` is an Arduino App Lab app, not a single sketch: the STM32 half
reads the MPU6050 and detects falls, the Debian half serves them over WebSocket
and relays them to the backends in `server/` (readings, falls, acks) and `web/`
(Wi-Fi fingerprints, location, responder log).
See `steady_unoq/README.md` for wiring, the Bridge/WebSocket message tables and
the tuning workflow. Short version:

```bash
python hardware/steady_unoq/tools/simulator.py --port 8765   # no board needed
```

then in the dashboard: **Settings → `127.0.0.1` → Connect over Wi-Fi** (port 8765 is assumed).

## The BLE / USB wearable

`steady_wearable/steady_wearable.ino` is the original firmware for the Nano 33
BLE family. It reads the accelerometer and gyroscope 50 times a second, detects
falls, and sends everything to the web app over BLE or USB serial.

### Flash a device

1. Install the Arduino IDE and open `steady_wearable/steady_wearable.ino`.
2. In Library Manager, install **ArduinoBLE** and the IMU library for your board
   (listed at the top of the sketch). Uncomment the matching `#define IMU_...`.
3. Set a unique `DEVICE_ID` (e.g. `ST-0420`), then upload.

### Test it in the web app

Open **Settings** in Chrome or Edge, then:

- **Connect over USB** with the board plugged in, or
- **Connect over Bluetooth** with it powered by battery or USB.

Live gyroscope and accelerometer readings appear, along with a self-test. Pick a
resident and press **Pair** to assign the device.

Bluetooth, USB and network connections from a web page need `localhost` or an
`https://` page. Bluetooth and USB need Chrome or Edge on desktop or Android
(Safari and Firefox support neither). The network transport only needs a
WebSocket, which every browser has — but a page served over `https://` may not
open a plain `ws://` socket, so use `localhost`, or put the board behind TLS if
the dashboard is served from an https origin.

## How data reaches the dashboard in a real home

A browser connection is for setup and diagnostics: one device, one screen,
nearby. Watching a whole wing all night needs a path that doesn't depend on a
browser tab staying open:

```
wearable --BLE--> gateway in the wing --Wi-Fi--> backend --> Databricks --> web app
   └── or, on the UNO Q: ──Bridge──► Python on the board ──Wi-Fi──► backend
```

- **Gateway:** the UNO Q itself, or a Raspberry Pi/ESP32 for BLE wearables, that
  stays connected and forwards readings.
- **Backend:** receives readings (MQTT or HTTPS), stores pairings, raises alerts,
  and serves the API the web app reads instead of the placeholder files in
  `src/data/`.

The Python app does exactly this: `server/` is the backend, it keeps readings and
alerts in Databricks, and the UNO Q relay posts a one-second summary to
`/api/readings` and every fall to `/api/falls`. Survey mode's fingerprints are
posted to the separate store in `web/`.

The fall detection in both sketches is a simple threshold. It needs testing and
tuning with real falls (a crash-test mat, a weighted dummy) before anyone relies
on it.
