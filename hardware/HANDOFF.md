# Hardware integration handoff

Where the wearable integration stands, what's left, and the rules for changing it.
Written for a teammate or an AI agent picking this up.

## The goal

Each resident wears a small device with a motion sensor (accelerometer + gyroscope). It detects
falls and streams movement so the Steady dashboard can show who's asleep, up, needs a check, or
has fallen. Staff use **Settings** in the web app to test devices and pair them to residents.

## What exists today

| Piece | File | Status |
| --- | --- | --- |
| Data contract (UUIDs, byte layout, serial format) | `src/hardware/protocol.ts` | Done. **Source of truth** |
| Firmware | `hardware/steady_wearable/steady_wearable.ino` | Written, **never compiled or run on a board** |
| Browser connection (Bluetooth, USB, simulator) | `src/hardware/connection.ts` | Done, tested only with the simulator |
| Settings page (live readings, self-test, pairing, device table) | `src/pages/Settings.tsx` | Done |
| Live gyroscope chart | `src/components/LiveTrace.tsx` | Done |
| Pairings | `src/hardware/pairings.ts` | Saved in browser `localStorage` only, no backend yet |
| Device data shown elsewhere (battery, signal, firmware) | `src/data/residents.ts` | **Placeholder data** |
| Flashing guide | `README.md` | Done |

## The data contract

Defined in `src/hardware/protocol.ts`. Any change must be made in **both** that file and the `.ino`.

**Bluetooth (BLE):** service `53746561-6479-4000-8000-000000000000`

| Characteristic | UUID suffix | Access | Payload |
| --- | --- | --- | --- |
| motion | `...0001` | notify | 24 bytes: ax, ay, az (g), gx, gy, gz (°/s), float32 little-endian |
| info | `...0002` | read | text `"<deviceId>;<firmware>"`, e.g. `ST-0419;1.4.2` |
| command | `...0003` | write | 1 byte, `1` = blink the LED for 3 s |
| fall | `...0004` | notify | 1 byte, `1` = fall detected |

The device also exposes the standard Battery Service (`0x180F` / `0x2A19`, percent).

**USB serial:** 115200 baud, one text line per message

```
I,ST-0419,1.4.2        device info (sent when the app writes "I?")
B,87                   battery percent (every 30 s)
M,ax,ay,az,gx,gy,gz    motion sample, 50 per second
F                      fall detected
```

The app writes `I?\n` to request info and `I\n` to blink the LED.

## Step 1: get one board working on the bench

1. **Pick the board.** The sketch supports the Nano 33 BLE / BLE Sense (Rev1 and Rev2), the
   Nano 33 IoT and the Nano RP2040 Connect. Uncomment the matching `#define IMU_...` line.
   An Uno + MPU6050 has no Bluetooth and would need a USB-only variant plus the MPU6050 library.
2. **Compile and flash** with the Arduino IDE. Install `ArduinoBLE` plus the IMU library named
   in the sketch. Set a unique `DEVICE_ID`.
3. **Test over USB first.** Run `npm run dev`, open `http://localhost:5173/settings` in Chrome or
   Edge, and press *Connect over USB*. All four self-test rows should pass.
4. **Then test over Bluetooth** with *Connect over Bluetooth*.

On WSL, run the Arduino IDE on Windows. The browser runs on Windows too, so USB ports work
normally even though the dev server runs in WSL.

## Known risks to check on real hardware

These are written but unverified. Check them first.

1. **The motion packet may be too big for BLE.** 24 bytes is over the default BLE payload of
   20 bytes. Chrome usually negotiates a larger packet size (MTU), but if readings look wrong or
   stop over Bluetooth while USB works, switch to int16: accel in milli-g, gyro in 0.1 °/s,
   12 bytes. Update `parseMotion` in `protocol.ts` and the `.ino` together.
2. **50 notifications a second may be dropped** on slow connections. If the *samples/s* shown in
   Settings is well below 50 over Bluetooth, batch several samples per notification or lower the
   rate to 25 Hz.
3. **The fall notification may be lost.** The sketch writes `1` then immediately `0`, and the
   `1` can be coalesced away. Safer: make the fall characteristic a counter that goes up by 1 per
   fall, and have the app fire whenever the counter changes.
4. **Fall detection is a rough threshold:** free fall under 0.4 g, then impact over 2.5 g
   within 1 s. Tune it with real drops on a mat. **Nobody should rely on it until it's tested.**
5. **The battery always reads 100%.** The boards can't measure a battery on their own. Wire the
   LiPo through a 2:1 divider to `A0` and set `HAS_BATTERY_DIVIDER 1`.
6. **Sensor orientation and units** differ slightly between IMU chips. Check that the
   accelerometer reads about 1.00 g at rest and the gyroscope reads about 0 °/s when still.

## Step 2: production path (not started)

The browser connection is only for setup and diagnostics. One tab can hold a few devices, and
only while it stays open. Monitoring a whole wing overnight needs:

```
wearables --BLE--> gateway per wing --Wi-Fi--> backend --> Databricks
                                        |
                                        +--> fall alerts go straight to the backend (fast path)
```

- **Gateway:** a Raspberry Pi running Python with `bleak`, or an ESP32. It connects to every
  wearable nearby using the same UUIDs above, reconnects automatically, and forwards readings.
- **Gateway → backend message** (proposed):
  `{ "deviceId": "ST-0419", "ts": "2026-11-08T02:13:04.120Z", "kind": "motion", "ax": 0.02, ..., "battery": 58, "rssi": -63 }`.
  Use `kind: "fall"` for falls and send them immediately; motion can be batched every second.
- **Alternative:** boards with Wi-Fi (Nano 33 IoT, Nano RP2040 Connect, ESP32) can post
  directly, which costs more battery.
- **Backend and Databricks:** not built yet. The plan is to ingest raw readings, run a pipeline
  that produces resident status, device health and alerts, and expose an API the web app reads
  instead of `src/data/`.

## Open decisions for the team

- Which board, and where it's worn (wrist, chest, belt). This affects fall detection a lot.
- Battery, charging and enclosure.
- Gateway hardware: Raspberry Pi or ESP32.
- How long data is kept and who can see it. It's health data.

## Rules for anyone (or any agent) changing this

- Keep `src/hardware/protocol.ts` and `steady_wearable.ino` in sync. Change both or neither.
- Test UI changes with **Settings → Try a simulated device** when no board is plugged in.
- Run `npm run build` before committing. It type-checks everything.
- In a fresh shell, run `source ~/.nvm/nvm.sh` before `npm`, since Node is installed through nvm.
- UI changes follow the design guide in `.claude/skills/unslop`: calm grey interface, red only
  for falls, no glows or emoji, sentence case.
- Never commit secrets (`.env`, tokens, Databricks credentials).

## Where the device data goes

The Python uplink posts to POST /api/v1/ingest on the Steady server with an
Authorization: Bearer <token> header and X-Device-Id. The server stores one
reading per second, raises a fall alert from each events[] entry, and shows the
device in Settings under "Wearables reporting in" so it can be paired to a
resident. GET /api/v1/health is an unauthenticated liveness check for the
device config. npm run sim:device in the repo root posts the same payloads,
which is the quickest way to check a change before flashing an UNO Q.
