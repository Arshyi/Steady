"""Steady — Arduino UNO Q app, Linux side.

The sketch on the STM32 (`sketch/sketch.ino`) reads the Modulino Movement over
Qwiic 50 times a second and hands every sample to this script over the Bridge:

    "12345,0.02,-0.01,1.00,12.4,-3.1,0.8"    ms, ax, ay, az, gx, gy, gz
    "12980,3.42,180"                         ms, peak_g, free_fall_ms

This script serves those samples to the dashboard over a WebSocket on the
board's Wi-Fi/LAN address, so the Settings page can show live readings without
the board being plugged into the computer running the browser.

The Bridge handlers below only append to a deque: a Python function provided
with `Bridge.provide` runs on a dedicated thread and must not call back into the
Bridge, and anything slow there stalls the MCU's link.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque

from arduino.app_utils import App, Bridge

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from steady_net import WebSocketServer  # noqa: E402  (path set up above)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CONFIG = {
    # Shown on the Settings page when a browser connects
    "device_id": "ST-UNOQ1",
    "firmware": "1.0.0",
    # 0.0.0.0 so the dashboard can reach the board over the care network
    "ws_host": "0.0.0.0",
    "ws_port": 8765,
    # Optional backend: falls are POSTed here the moment they happen.
    # Leave empty during setup; Databricks/analytics comes later.
    #   "forward_url": "http://192.168.1.20:8787/api/v1/ingest"
    "forward_url": "",
    "forward_token": "",
    # Keep False until the backend can handle 50 Hz per resident; falls always go.
    "forward_samples": False,
}

# ---------------------------------------------------------------------------
# Bridge handlers (called by the sketch — keep them trivial)
# ---------------------------------------------------------------------------

_samples: deque[str] = deque(maxlen=400)
_falls: deque[str] = deque(maxlen=32)
_identify = threading.Event()


def _on_motion(line: str) -> None:
    _samples.append(line)


def _on_fall(line: str) -> None:
    _falls.append(line)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _parse_sample(line: str) -> dict | None:
    parts = line.split(",")
    if len(parts) != 7:
        return None
    try:
        values = [float(part) for part in parts]
    except ValueError:
        return None
    return {
        "type": "motion",
        "t": int(values[0]),
        "ax": round(values[1], 3),
        "ay": round(values[2], 3),
        "az": round(values[3], 3),
        "gx": round(values[4], 1),
        "gy": round(values[5], 1),
        "gz": round(values[6], 1),
    }


def _parse_fall(line: str) -> dict | None:
    parts = line.split(",")
    if len(parts) < 3:
        return None
    try:
        return {"type": "fall", "t": int(parts[0]), "peak": round(float(parts[1]), 2)}
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Backend forwarding (optional, off by default)
# ---------------------------------------------------------------------------

_forward_failed = False


def _forward(event: dict) -> None:
    global _forward_failed
    url = CONFIG.get("forward_url", "").strip()
    if not url:
        return
    body = json.dumps({"device": CONFIG["device_id"], **event}).encode()
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {CONFIG.get('forward_token', '')}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            response.read()
        _forward_failed = False
    except (urllib.error.URLError, OSError) as exc:
        # One line per outage, not one per fall: the night staff shouldn't see spam
        if not _forward_failed:
            print(f"[steady] forward to {url} failed: {exc}")
            _forward_failed = True


# ---------------------------------------------------------------------------
# WebSocket plumbing
# ---------------------------------------------------------------------------

_server: WebSocketServer | None = None
_seen_identify = 0
_checked_sketch = False


def _hello(send) -> None:
    send(json.dumps({"type": "hello", "device": CONFIG["device_id"], "firmware": CONFIG["firmware"], "rate": 50}))


def _client_message(text: str) -> None:
    try:
        message = json.loads(text)
    except ValueError:
        return
    if isinstance(message, dict) and message.get("type") == "identify":
        _identify.set()


def _frame(event: dict) -> str:
    return json.dumps(event, separators=(",", ":"))


# ---------------------------------------------------------------------------
# Main loop, driven by the App framework
# ---------------------------------------------------------------------------


def loop() -> None:
    global _checked_sketch

    if not _checked_sketch:
        # Ask the sketch which firmware it is running, once the Bridge is up.
        try:
            info = Bridge.call("steady_info", timeout=2)
            if isinstance(info, str) and info:
                print(f"[steady] sketch reports {info}")
        except Exception as exc:  # the sketch may still be booting
            print(f"[steady] sketch info unavailable: {exc}")
        _checked_sketch = True

    while _samples:
        sample = _parse_sample(_samples.popleft())
        if sample is not None:
            _server.broadcast(_frame(sample))
            if CONFIG.get("forward_samples"):
                _forward(sample)

    while _falls:
        fall = _parse_fall(_falls.popleft())
        if fall is not None:
            _server.broadcast(_frame(fall))
            _forward(fall)  # falls go out immediately, always
            print(f"[steady] fall detected, peak {fall['peak']} g")

    if _identify.is_set():
        _identify.clear()
        try:
            Bridge.call("steady_identify")
        except Exception as exc:
            print(f"[steady] identify failed: {exc}")

    time.sleep(0.01)


def main() -> None:
    global _server

    Bridge.provide("steady_motion", _on_motion)
    Bridge.provide("steady_fall", _on_fall)

    _server = WebSocketServer(
        CONFIG["ws_host"],
        CONFIG["ws_port"],
        on_message=_client_message,
        on_connect=_hello,
    ).start()
    print(f"[steady] {CONFIG['device_id']} serving ws://{CONFIG['ws_host']}:{CONFIG['ws_port']}")

    App.run(user_loop=loop)


if __name__ == "__main__":
    main()
