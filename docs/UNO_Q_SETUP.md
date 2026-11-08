# UNO Q setup and storage

This project targets the **Arduino UNO Q 4 GB / 32 GB eMMC (ABX00173)**. Its
Qualcomm QRB2210 runs Debian Linux, while its STM32U585 runs Arduino sketches on
**Zephyr RTOS**. Keep sampling and time-sensitive detection on the MCU, and
networking/storage on Linux, joined through Bridge. Installing FreeRTOS is not
needed for this design. [Arduino datasheet](https://docs.arduino.cc/resources/datasheets/ABX00162-datasheet.pdf)

## Recommended setup

| Use | Setup |
| --- | --- |
| Development | Laptop running Arduino App Lab, USB-C data cable, and a port that can provide sufficient board power; configure Wi-Fi during setup |
| Stationary demo / gateway | USB-C wall supply and cable rated **5 V / 3 A**, then Wi-Fi to the laptop/server |
| Moving prototype | A suitable regulated USB-C power bank, with runtime measured on the complete assembly |
| Longer-term wearable design | Consider a small battery BLE sensor with the UNO Q serving as a room gateway; that BLE gateway is not implemented in this repo |

UNO Q requests the **5 V** USB Power Delivery profile, not higher-voltage
profiles. The 15 W supply capability is not a claim of constant consumption.
Do not assume every laptop port or charger can sustain its load.
[Arduino power specifications](https://docs.arduino.cc/tutorials/uno-q/power-specification/)

Wi-Fi is the best fit for the **current code**: the root dashboard talks to a
WebSocket relay on port 8765, and the relay posts HTTP data independently.
Bluetooth 5.1 exists on the board, but Steady currently implements no UNO Q BLE
transport or browser Bluetooth control. USB is useful for App Lab/ADB development;
it does not change the operating system or make the current dashboard a USB
serial application. SSH is available after board/network setup.
[Arduino Debian guide](https://docs.arduino.cc/tutorials/uno-q/debian-guide/)

## Choose the matching application

Use [`hardware/steady_unoq/`](../README.md#other-firmware-builds) with the root
`src/` dashboard and `server/` Node/Databricks API. This App Lab app samples an
external MPU6050 at 50 Hz, passes readings through Bridge, streams diagnostics
over WebSocket and produces one-second backend summaries. Its survey/location
features also call the Worker in `web/`.

[`firmware/steady/`](../README.md#other-firmware-builds) is an alternative 200 Hz
orientation/fall detector with event waveforms, a JSONL outage spool and a
different ingest API in [`web/`](../README.md#cloudflare-worker-web). Its sketch and Python half
must stay together. It is not a drop-in replacement for the integrated relay.
`hardware/steady_wearable/` is older Nano firmware, not the UNO Q application.

Set a unique device ID in the integrated sketch. Its relay adopts the MCU's
identity through `steady_info`, retrying every five seconds until successful;
it does not advertise a fallback identity for pairing. For the alternative app,
follow its separate `config.json` instructions.

Configure `STEADY_SERVER_URL`, `STEADY_SURVEY_URL` and `STEADY_DEVICE_TOKEN` for
the integrated Linux app. The token is the Worker's `DEVICE_TOKEN`, not its
dashboard `VIEW_KEY`. Point URLs at addresses reachable **from the board**. A default
`127.0.0.1:8787` points to the board itself; use the laptop's LAN address when
the backend runs there. Pair the device in Settings and select Live devices.
An HTTPS-hosted dashboard requires `wss://` or an appropriate TLS proxy; the
development relay currently serves plain `ws://`.

## External sensor and I2C

UNO Q has no onboard motion sensor. The current driver is for an **MPU6050**,
not for every I2C IMU. With the integrated sketch's `Wire` object:

| MPU6050 breakout | UNO Q connection |
| --- | --- |
| VCC | 3V3; verify the breakout supports 3.3 V supply and 3.3 V bus pull-ups |
| GND | GND |
| SDA | Dedicated SDA / D20 |
| SCL | Dedicated SCL / D21 |
| AD0 | GND for 0x68; 3V3 selects 0x69 |

**A4/A5 are not aliases of those dedicated SDA/SCL pins on UNO Q.** They use
`Wire2` on recent Arduino Zephyr cores. Qwiic uses **`Wire1`**, and is **3.3 V
only**. Older project notes naming A4/A5 with `Wire` should not be followed.
[UNO Q manual](https://docs.arduino.cc/tutorials/uno-q/user-manual/),
[Arduino core change adding Wire2 on A4/A5](https://github.com/arduino/ArduinoCore-zephyr/pull/355)

Modulino Movement is a convenient Qwiic alternative, but it contains an
**LSM6DSOX**, so it needs its own driver and `Wire1` integration; it cannot use
the existing MPU6050 register code unchanged.
[Modulino Movement specifications](https://docs.arduino.cc/hardware/modulino-movement/)

## Can 32 GB hold a local database?

**Yes, for bounded sensor data and events.** The 32 GB also holds Debian, apps,
containers, logs and updates. Inspect actual free space with `df -h /` on the
board before allocating a database budget. The integrated relay currently has
**no local SQLite store or durable outbox**; this section describes a proposal,
not a feature already delivered. Databricks and Worker/D1 are separate stores.
The new background summary sender retries from a bounded RAM queue; that queue
does not persist across a restart or power loss.

A host SQLite experiment inserted **100,000 rows per schema**, including a
device/time index, then checkpointed the databases. Both `integrity_check`
results were `ok`. Reproduce from the repository root:

```bash
python hardware/steady_unoq/tools/storage_budget.py --rows 100000 --budget-gib 8 --temp-dir .
```

| Example schema | Measured bytes/row including index | Projected MB/day/device | Theoretical days in an 8 GiB data budget |
| --- | --- | --- | --- |
| Six-channel raw samples at 50 Hz | 106.05 | 458.12 | 18.8 |
| Three-value summaries at 1 Hz | 78.52 | 6.78 | 1266.2 |

These measurements concern this host and these example schemas, not UNO Q
speed, eMMC endurance, or an integrated database. The projection excludes
transient WAL, backups, events, logs, OS/containers and free-space headroom.
Eight GiB is a hypothetical allocation, not measured available space on the
board. Device count and schema/index changes reduce retention accordingly.

For a more conservative plan, use the following arithmetic estimates per device
with decimal MB/GB. The
200-byte figures are an assumed effective row budget, including typical
metadata/index allowance; measure the actual schema. WAL, backups, filesystem
overhead and write amplification are additional.

| Retained data | Assumption | Per day | 30 days |
| --- | --- | --- | --- |
| Compact raw values | 50 Hz, six float32 values + 8-byte timestamp = 32 bytes | 138.24 MB | 4.15 GB |
| Raw database records | 50 Hz, 200 bytes per stored sample | 864 MB | 25.92 GB |
| One-second summaries | 1 Hz, 200 bytes per stored summary | 17.28 MB | 0.52 GB |

Multiply by device count: ten devices at the last rate consume about **5.18 GB
per 30 days** before extra overhead. Continuous raw storage for a wing does not
fit indefinitely. Four GB RAM is ample to consider a small Linux service and
SQLite; it is not a measurement of this application's throughput.

Proposed starting policy: keep raw readings for 24 hours, one-second summaries
for 30 days, and short waveform windows around events. Retain event metadata
according to the project's agreed policy and export it with backups. Set a
database size cap based on measured free space, leaving at least 20% of the
filesystem free for the OS, logs, updates and recovery. A headless deployment
avoids running an unnecessary desktop browser alongside the service.

Use a single writer and batch ordinary samples in transactions to reduce
commit overhead and repeated eMMC writes. Persist an event/outbox entry before
acknowledging it; retry with stable IDs and idempotent ingest. SQLite WAL with
`synchronous=FULL` is a suitable starting point for important event durability.
`NORMAL` can lose recent committed transactions on power failure. Checkpoint
the WAL, keep reader transactions short, rotate logs and use a clean shutdown.
These settings do not establish an eMMC lifetime or protect against every
storage fault; endurance and power-loss behavior need measurements.
[SQLite WAL](https://www.sqlite.org/wal.html),
[SQLite synchronous settings](https://www.sqlite.org/pragma.html#pragma_synchronous)

## What simulation can establish

The repo's Python simulator exercises the integrated WebSocket protocol, and
the alternative detector has C++ host tests. Use those to test data handling,
UI states and synthetic thresholds. They do **not** emulate QRB2210, STM32U585,
Zephyr scheduling, Bridge transport, real sensor noise, radio range or power.

Wokwi's published supported hardware list does not include UNO Q. Tinkercad
advertises Arduino circuit simulation, but no official UNO Q model was found.
An ordinary Uno simulation would not validate this dual-processor board.
[Wokwi hardware list](https://docs.wokwi.com/getting-started/supported-hardware),
[Tinkercad Circuits](https://www.tinkercad.com/circuits)

Complete App Lab compilation and a physical bench test before claiming board
support. Check sensor identity/units/range, sample rate, reconnect, reboot,
offline delivery and power stability. Test fall detection with controlled
dummy/mat trials and ordinary activities; do not induce human falls.
