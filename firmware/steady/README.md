# Steady firmware — Arduino UNO Q

An Arduino App Lab App: a Zephyr sketch on the STM32U585 (real-time) plus a
Python program on the QRB2210 (Wi-Fi uplink).

## Install

1. **Arduino App Lab** → *Create new app* → name it `steady`.
2. Copy this folder's `python/` and `sketch/` contents into the App (App Lab
   creates `app.yaml` and `sketch.yaml`; keep its `sketch.yaml`).
3. Wire the MPU6050 (see the table below), power the board over USB-C.
4. `cp python/config.example.json python/config.json` and edit:
   * `endpoint` — full URL of the site's ingest route,
     e.g. `http://192.168.1.10:8787/api/v1/ingest` (or your deployed worker).
   * `token` — the site's `DEVICE_TOKEN`.
   * `device_id` — unique per resident/device, `A-Z a-z 0-9 . _ -`.
5. Press **Run**. The console shows the sketch output plus the Python log.

Wi-Fi lives on the Linux side. From the App Lab network panel, or a shell:

```bash
nmcli device wifi connect "<SSID>" password "<password>"
nmcli device show wlan0 | grep IP4.ADDRESS
```

## Wiring

| MPU6050 | UNO Q | Notes |
| --- | --- | --- |
| VCC | 3V3 | 3.3 V logic board — never feed 5 V into an I2C pin |
| GND | GND | |
| SDA | A4 (or Qwiic SDA) | `Wire` is tried first, then `Wire1` (Qwiic) |
| SCL | A5 (or Qwiic SCL) | |
| AD0 | GND | `0x68` (default); `0x69` if tied high |

Only four wires are needed: the firmware polls the sensor at 200 Hz and does not
use the INT pin. If you later want interrupt-driven sampling, wire INT to a free
GPIO and gate the sampler on it.

## RTOS layout

| Thread | Priority | Stack | Job |
| --- | --- | --- | --- |
| `steady_sampler` | 2 | 4 kB | 200 Hz I2C burst read, pushes into a 96-slot queue, retries the sensor every 2 s if it disappears |
| `steady_detector` | 3 | 4 kB | orientation filter, fall FSM, 640-sample ring, 10 Hz telemetry snapshots |
| `steady_uplink` | 5 | 4 kB | Bridge notifications, fall announcement |
| Arduino `loop` | idle | — | hosts the `provide_safe()` callbacks |

Priorities are Zephyr priorities (lower number = more urgent). The sampler never
blocks: if the detector falls behind, the oldest queued sample is dropped rather
than the newest (`SteadyQueue::push`).

`rtos.h` is a thin shim over `k_thread_create`, `k_msgq`, `k_mutex` and
`k_msleep`. When built for a board without Zephyr it degrades to the
single-threaded path driven from `loop()`, which is handy for bench-testing the
wiring on a classic Uno/Nano.

## Bridge contract

The Linux side (and anything else on the board) can call these MCU functions:

| Method | Returns | Purpose |
| --- | --- | --- |
| `steady_status` | JSON string | firmware version, uptime, rate, sensor present, WHO_AM_I, counters, FSM state |
| `steady_event_meta` | JSON string | pending waveform: `ready`, `seq`, `n`, `hz`, peak/min g, tilt before/after, confidence, flags |
| `steady_event_chunk(start, count)` | `bytes` | packed little-endian `int16` sextuplets `ax ay az gx gy gz` (milli-g / 0.1 dps), max 18 samples |
| `steady_event_ack` | bool | releases the pending waveform |
| `steady_set_thresholds(impact_g, tilt_deg)` | bool | retunes the detector at runtime (impact 1.5–8 g, tilt 20–120°) |

MCU → Linux notifications, handled by `python/main.py`:

| Method | Payload |
| --- | --- |
| `steady_telemetry` | 10 Hz sample: `{"t","ax","ay","az","gx","gy","gz","r","p","tl","sv","st","n"}` |
| `steady_fall` | confirmed fall: `{"ev","seq","t","dur","pk","mn","tb","ta","dl","cf","fl","n","hz"}` |

Both are kept under 250 bytes so they fit the 256-byte Bridge limit; anything
longer is dropped and counted in `steady_status.drop`.

`provide_safe()` is used for all five RPC functions: they run in `loop()`
context, so they can take the event mutex without ever preempting the detector
mid-update.

## Configuration

`sketch/config.h`:

| Macro | Default | Effect |
| --- | --- | --- |
| `STEADY_SAMPLE_HZ` | 200 | sampler rate (also sets the MPU6050 divider) |
| `STEADY_ACCEL_FSR_G` | 8 | ±8 g gives ~4 LSB/mg and headroom above 2 g impacts |
| `STEADY_GYRO_FSR_DPS` | 2000 | ±2000 °/s |
| `STEADY_DLPF_CFG` | 3 | 44 Hz analogue bandwidth, below the 100 Hz Nyquist limit |
| `STEADY_WINDOW_PRE_MS` / `POST_MS` | 2000 / 1000 | waveform uploaded per fall |
| `STEADY_CHUNK_SAMPLES` | 18 | must stay ≤ 21 to fit the Bridge message cap |

Detector thresholds live in `FallConfig` (`fall_detector.h`) and are included in
every event, so a change on the device is always comparable with older records.

## Calibrating

The MPU6050 has a gyro bias of a few °/s, which matters for yaw and for large
pitch excursions. To measure it: place the device still, run the app, watch
`gx/gy/gz` in the telemetry stream (dashboard or serial) for 10 s, then subtract
the mean values from `ImuSample` in `Mpu6050::read()`. The accel is factory
calibrated well enough for tilt.

A quick sanity check of orientation: lay the board flat and upright → tilt ≈ 0°;
stand it on its edge → ≈ 90°.

## Fall tuning workflow

1. Record real activities (sit, lie down, bed exit, stumble) with the dashboard
   open and the CSV export available.
2. Any candidate the device raised is in the events table with its waveform and
   the server's independent analysis.
3. If you see false alarms from a specific activity, raise
   `cfg.tilt_change_deg` or `cfg.impact_g` (via `steady_set_thresholds`, or in
   `FallConfig` and reflash).
4. If real falls are missed, lower `impact_g` towards 2.0 g and/or reduce
   `tilt_change_deg` to 35°.

## Host tests (no board)

```bash
# Windows (MSVC)
cmd //c tools\build_host_test.bat

# Linux/macOS
tools/run_host_test.sh
```

This compiles `fall_detector.cpp`, `orientation.cpp` and `window_buffer.h`
against `tools/host_test.cpp` and runs seven synthetic scenarios plus packing
checks. Expected output ends with `ALL CHECKS PASSED`.

## First-hardware checklist

1. `steady_status` shows `"sensor":1` and `"who":104` (`0x68`). If it shows 0,
   the wiring is wrong or the module lacks power.
2. Sample rate: `steady_status.up` should advance ~1000 ms while `samples`
   advances ~200 per second.
3. Lay the board flat → tilt ~0°; stand it up → ~90° in the dashboard.
4. Shake it firmly: `state` should stay 0/1 and no `steady_fall` should appear.
5. Simulate a fall: hold the board up, drop it onto a soft surface from ~1 m
   while turning it 90°. Expect one event, and the dashboard detail to show
   free-fall, impact, posture Δ and the waveform.
6. Pull the Wi-Fi (`nmcli radio wifi off`), trigger another fall, then restore
   Wi-Fi: the event must appear after the spool replays.
