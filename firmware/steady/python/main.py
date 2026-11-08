"""Steady — Linux (QRB2210) side of the Arduino App Lab app.

This half of the app is the Wi-Fi gateway for the fall detector:

  MCU (Zephyr)  --Bridge/RPC-->  this file  --HTTPS-->  Steady website

The MCU samples the MPU6050 at 200 Hz and decides locally whether a fall
happened. Linux never touches the sensor: it receives 10 Hz telemetry, pulls the
3 s waveform behind each confirmed fall over Bridge RPC chunks, stamps
everything with UTC time and posts it to the site, spooling to disk while the
network is down.

Run with the App Lab (press Run) or `arduino-app-cli app start user:steady`.
"""

from __future__ import annotations

import json
import os
import time

from pipeline import Pipeline
from uplink import Uplink

HERE = os.path.dirname(os.path.abspath(__file__))
CHUNK_SAMPLES = 18  # must match STEADY_CHUNK_SAMPLES in the sketch
STATUS_PERIOD_S = 20.0
HEARTBEAT_PERIOD_S = 60.0


def load_config() -> dict:
    config = {
        "endpoint": "http://127.0.0.1:8787/api/v1/ingest",
        "device_id": "steady-001",
        "token": "",
        "spool_dir": os.path.join(HERE, "data", "spool"),
    }
    path = os.path.join(HERE, "config.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            config.update(json.load(handle))

    # Environment wins, so the same App can run against a staging site without
    # editing a file that gets deployed.
    config["endpoint"] = os.environ.get("STEADY_ENDPOINT", config["endpoint"])
    config["token"] = os.environ.get("STEADY_TOKEN", config["token"])
    config["device_id"] = os.environ.get("STEADY_DEVICE_ID", config["device_id"])
    config["spool_dir"] = os.environ.get("STEADY_SPOOL_DIR", config["spool_dir"])
    return config


CONFIG = load_config()
UPLINK = Uplink(
    endpoint=CONFIG["endpoint"],
    token=CONFIG["token"],
    device_id=CONFIG["device_id"],
    spool_dir=CONFIG["spool_dir"],
)
PIPELINE = Pipeline(UPLINK, CONFIG["device_id"])
UPLINK.start()

try:
    from arduino.app_utils import App, Bridge
except Exception as exc:  # running on a laptop without the App Lab runtime
    App = None
    Bridge = None
    print(f"[steady] Arduino Bridge unavailable ({exc})")
    print("[steady] this script is meant to run inside Arduino App Lab on the UNO Q")


# --------------------------------------------------------------------- Bridge
def on_telemetry(payload) -> None:
    """MCU 10 Hz telemetry notification (runs on the Bridge handler thread)."""
    if not isinstance(payload, str):
        payload = json.dumps(payload)
    PIPELINE.on_telemetry(payload)


def on_fall(payload) -> None:
    """MCU confirmed-fall notification (runs on the Bridge handler thread).

    No RPC calls are allowed in here, so the waveform fetch is deferred to
    user_loop().
    """
    print(f"[steady] fall reported by MCU: {payload}")
    if not isinstance(payload, str):
        payload = json.dumps(payload)
    PIPELINE.on_fall(payload)


def fetch_waveform(event: dict) -> None:
    """Pulls the packed waveform for one event, then acknowledges it."""
    meta_raw = Bridge.call("steady_event_meta", timeout=5)
    meta = json.loads(meta_raw) if isinstance(meta_raw, str) else (meta_raw or {})
    total = int(meta.get("n") or event.get("sample_count") or 0)
    rate_hz = int(meta.get("hz") or event.get("rate_hz") or 200)
    if total <= 0:
        print("[steady] no waveform available for this event")
        PIPELINE.abandon_event(event)
        return

    packed = bytearray()
    for start in range(0, total, CHUNK_SAMPLES):
        chunk = Bridge.call("steady_event_chunk", start, CHUNK_SAMPLES, timeout=5)
        if chunk is None:
            break
        if isinstance(chunk, str):
            chunk = chunk.encode("latin-1")
        packed.extend(bytes(chunk))
        if len(chunk) < CHUNK_SAMPLES * 12:
            break

    try:
        Bridge.call("steady_event_ack", timeout=5)
    except Exception as exc:
        print(f"[steady] ack failed: {exc}")

    if len(packed) < 12:
        PIPELINE.abandon_event(event)
        return
    PIPELINE.attach_waveform(event, bytes(packed), rate_hz)
    print(f"[steady] uploaded fall waveform: {len(packed) // 12} samples at {rate_hz} Hz")


def poll_status() -> None:
    try:
        raw = Bridge.call("steady_status", timeout=4)
    except Exception as exc:
        print(f"[steady] status call failed: {exc}")
        return
    if not isinstance(raw, str):
        raw = json.dumps(raw)
    PIPELINE.on_status(raw)
    status = PIPELINE.last_status
    if status.get("sensor") == 0:
        print("[steady] WARNING: MCU cannot see the MPU6050 (check wiring)")


# ---------------------------------------------------------------- main loop
_next_status = 0.0
_next_heartbeat = 0.0


def user_loop() -> None:
    global _next_status, _next_heartbeat
    now = time.time()

    if Bridge is not None and now >= _next_status:
        _next_status = now + STATUS_PERIOD_S
        poll_status()

    event = PIPELINE.next_event_without_waveform()
    if event is not None and Bridge is not None:
        try:
            fetch_waveform(event)
        except Exception as exc:
            print(f"[steady] waveform fetch failed: {exc}")
            PIPELINE.abandon_event(event)

    PIPELINE.flush()

    if now >= _next_heartbeat:
        _next_heartbeat = now + HEARTBEAT_PERIOD_S
        UPLINK.enqueue_heartbeat(
            CONFIG["device_id"],
            {"pipeline": PIPELINE.snapshot(), "uplink": UPLINK.snapshot()},
        )

    time.sleep(0.2)


if Bridge is not None:
    Bridge.provide("steady_telemetry", on_telemetry)
    Bridge.provide("steady_fall", on_fall)
    print(f"[steady] device '{CONFIG['device_id']}' -> {CONFIG['endpoint']}")
    if not CONFIG["token"]:
        print("[steady] WARNING: no ingest token set (config.json or STEADY_TOKEN)")
    try:
        App.run(user_loop=user_loop)
    except KeyboardInterrupt:
        pass
    finally:
        UPLINK.stop()
