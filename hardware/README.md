# Steady hardware

`steady_wearable/steady_wearable.ino` is starter firmware for the wearable. It reads the
accelerometer and gyroscope 50 times a second, detects falls, and sends everything to the
web app. The data format is defined in `src/hardware/protocol.ts`; keep the two in sync.

## Flash a device

1. Install the Arduino IDE and open `steady_wearable/steady_wearable.ino`.
2. In Library Manager, install **ArduinoBLE** and the IMU library for your board (listed at the
   top of the sketch). Uncomment the matching `#define IMU_...` line.
3. Set a unique `DEVICE_ID` (e.g. `ST-0420`), then upload.

## Test it in the web app

Open **Settings** in Chrome or Edge, then:

- **Connect over USB** with the board plugged in, or
- **Connect over Bluetooth** with it powered by battery or USB.

Live gyroscope and accelerometer readings appear, along with a self-test. Pick a resident and
press **Pair** to assign the device.

Bluetooth and USB connections from a web page only work on `localhost` or an `https://` site,
in Chrome or Edge on desktop or Android. Safari and Firefox don't support them.

## How data reaches the dashboard in a real home

The browser connection is for setup and diagnostics: one device, one screen, nearby. Watching a
whole wing all night needs a path that doesn't depend on a browser tab staying open:

```
wearable --BLE--> gateway in the wing --Wi-Fi--> backend --> Databricks --> web app
```

- **Gateway:** a Raspberry Pi or ESP32 that stays connected to every wearable nearby over BLE and
  forwards readings. Alternatively, boards with Wi-Fi (Nano 33 IoT, Nano RP2040 Connect, ESP32)
  can send directly.
- **Backend:** receives readings (MQTT or HTTPS), stores pairings, raises alerts, and serves the
  API the web app reads instead of the placeholder files in `src/data/`.

The fall detection in the sketch is a simple threshold to get started. It needs testing and
tuning with real falls (a crash-test mat, a weighted dummy) before anyone relies on it.
