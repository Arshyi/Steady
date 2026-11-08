# Hardware integration handoff

The board is an **Arduino UNO Q, 4 GB RAM / 32 GB eMMC**. Read
[UNO_Q_SETUP.md](../docs/UNO_Q_SETUP.md) for power, wiring, architecture and
storage sizing, then the [integrated app guide](steady_unoq/README.md).

## Integration map

| Piece | Files | Current role |
| --- | --- | --- |
| Dashboard | `src/`, especially `src/pages/Settings.tsx` | Root React application; Wi-Fi relay connection, diagnostics and pairing |
| Dashboard data | `server/` | Node API and Databricks persistence; supports simulated and live modes |
| Device contract | `src/hardware/protocol.ts`, `src/hardware/connection.ts` | WebSocket text messages on port 8765; keep in sync with integrated relay |
| Integrated MCU | `hardware/steady_unoq/sketch/sketch.ino` | External MPU6050, 50 Hz motion, fall thresholds, button and optional NFC |
| Integrated Linux app | `hardware/steady_unoq/python/` | Bridge handlers, WebSocket diagnostics, HTTP readings/events, Wi-Fi surveys |
| Protocol simulator | `hardware/steady_unoq/tools/simulator.py` | Synthetic device messages for Settings; no board emulation or persistent backend |
| Backend mock relay | `server/mock-relay.ts` | Synthetic WebSocket device plus Node backend posts |
| Alternative pipeline | `firmware/steady/` and `web/` | 200 Hz detector, waveforms, JSONL outage spool, Worker/D1 API and separate UI |
| Legacy firmware | `hardware/steady_wearable/` | Nano BLE/USB reference; unsupported by the current dashboard controls |

The two UNO Q apps use different Bridge methods and server APIs. Select one
complete path. The root dashboard path uses `hardware/steady_unoq/`; the
alternative `firmware/steady/` is not a replacement sketch for that relay.
Worker survey/location routes are also used by the integrated path.

## Boundaries to preserve

- Debian owns high-level networking and storage; the STM32 runs Arduino on
  Zephyr for sampling. FreeRTOS is not the current board runtime.
- Keep Bridge callbacks short and move HTTP, storage and scanning work out of
  them. Use `Bridge.provide_safe()` for MCU callbacks that use Arduino APIs.
- Use Bridge rather than opening the router-owned `/dev/ttyHS1` directly.
- Keep device identity and units consistent: acceleration in g, rotation in
  degrees/second. `B` is optional; do not invent a battery reading on USB power.
- Keep `src/hardware/protocol.ts`, the integrated sketch/relay and its simulator
  in sync when changing their contract. The legacy Nano protocol is separate.
- Keep local credentials and generated data out of commits.

## Storage status and next work

The integrated relay has no local SQLite persistence or durable offline outbox.
Its HTTP path is not a guarantee of delivery during network loss. Databricks
storage is remote. The alternative app's bounded JSONL spool and the Worker's
D1 database do not add SQLite persistence to the integrated board app.

A proposed local store should retain one-second summaries, event metadata and
short event waveforms, with bounded raw-data retention and a durable retry
outbox. Implement stable event IDs and idempotent ingest before replaying
events. See the setup guide for sizing and SQLite durability tradeoffs.

## Checks before claiming hardware support

1. Compile the chosen App Lab app with its actual core/library versions.
2. Verify I2C wiring: `Wire` uses dedicated SDA/D20 and SCL/D21; Qwiic is
   `Wire1`; A4/A5 need `Wire2` on a core that exposes it. Use 3.3 V logic.
3. Check sensor identity, approximately 1 g at rest, near-zero gyro at rest,
   axis orientation, scale range, sample rate and missing-sensor behavior.
4. Confirm a controlled test event reaches the backend once, even with a
   diagnostic browser connected; confirm button/NFC acknowledgements separately.
5. Test reconnect, backend failure, reboot, power loss and retention behavior.
   Synthetic tests alone do not establish those physical properties.
6. Measure supply stability and power consumption before choosing a battery.

Run the root build and relevant host tests after code changes. Record separately
what passed on the development computer, what compiled for the board, and what
actually ran on hardware. The fall thresholds are experimental and need
controlled dummy/mat and everyday-activity testing, not intentional human falls.

## Where the device data goes

The alternative `firmware/steady/` Python uplink posts to POST /api/v1/ingest on the Steady server with an
Authorization: Bearer <token> header and X-Device-Id. The server stores one
reading per second, raises a fall alert from each events[] entry, and shows the
device in Settings under "Wearables reporting in" so it can be paired to a
resident. GET /api/v1/health is an unauthenticated liveness check for the
device config. npm run sim:device in the repo root posts the same payloads,
which is the quickest way to check a change before flashing an UNO Q.
