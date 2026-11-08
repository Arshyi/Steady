# Steady hardware

The current board is an **Arduino UNO Q with 4 GB RAM and 32 GB eMMC**. Start
with the [UNO Q setup and storage guide](../docs/UNO_Q_SETUP.md).

| Implementation | What it connects to | Status and scope |
| --- | --- | --- |
| [`steady_unoq/`](steady_unoq/README.md) | Root React dashboard (`src/`), Node/Databricks backend (`server/`), and survey routes in `web/` | Current integrated path: external MPU6050, 50 Hz MCU samples, Bridge, Linux WebSocket relay on port 8765, one-second backend summaries |
| [`../firmware/steady/`](../firmware/steady/README.md) | The separate Worker/D1 application in [`../web/`](../web/README.md) | Alternative detector: 200 Hz sampling, orientation/fall state machine, waveform uploads and JSONL outage spool; different Bridge/API contract |
| `steady_wearable/` | Legacy Nano BLE/USB protocol | Original Nano firmware, retained for reference. It is not the UNO Q app, and the current dashboard has no Bluetooth or USB connection controls. |

Do not combine the two UNO Q sketches or Python halves: their Bridge methods and
backend payloads differ. The integrated app does not yet persist a local SQLite
database. The alternative app's JSONL spool is not that database either.

## Current setup

Use Arduino App Lab to run `steady_unoq/`. The MCU runs Arduino on **Zephyr**;
Debian Linux runs the relay, networking and any future local database. Use
USB-C power rated **5 V / 3 A** and Wi-Fi for the current dashboard connection.
USB to a sufficiently powered laptop port is useful for programming and debug.

The UNO Q needs an external IMU. The integrated sketch uses `Wire`: connect the
MPU6050 to the dedicated **SDA/D20 and SCL/D21** pins, plus **3V3 and GND**.
A4/A5 are a different bus (`Wire2` on recent cores); Qwiic uses `Wire1`.
See the setup guide before wiring either alternative.

Set a unique device ID in the integrated sketch; the relay reads its identity
through Bridge before advertising it or posting data. Set the relay's backend URLs
to addresses reachable from the board. `127.0.0.1` on the board means the board,
not your laptop. In the root dashboard, use **Settings → Connect over Wi-Fi**
with the board's address, then pair the device to a resident. Keep the browser
connection for diagnostics; the Linux relay sends readings and events to the
backend independently.

## Exercise the protocol without a board

From the repository root:

```bash
python hardware/steady_unoq/tools/simulator.py --port 8765
```

Connect Settings to `127.0.0.1`. This exercises WebSocket messages and UI states;
it does not emulate the UNO Q, validate the sensor wiring, or measure real fall
detection performance. The separate `npm run relay:mock` tool also posts to the
Node backend; see the [server guide](../server/README.md).

An HTTPS dashboard needs a secure WebSocket endpoint (`wss://`) or an appropriate
same-origin proxy; the board's plain `ws://` development server is not a deployed
TLS endpoint. Fall detection remains a prototype requiring controlled bench and
activity testing before operational use.

See [HANDOFF.md](HANDOFF.md) for the integration boundaries and remaining checks.
