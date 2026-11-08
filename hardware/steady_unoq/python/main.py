"""Steady — Arduino UNO Q app, Linux side.

The sketch on the STM32 (`sketch/sketch.ino`) reads the Modulino Movement over
Qwiic 50 times a second and hands events to this script over the Bridge:

    "12345,0.02,-0.01,1.00,12.4,-3.1,0.8"    motion:  ms, ax, ay, az, gx, gy, gz
    "12980,3.42,180"                         fall:    ms, peak_g, free_fall_ms
    "13110,1"                                I'm OK:  ms, presses
    "14002,3"                                survey:  ms, presses (three taps)
    "14400,04:A2:33:9C:1B:80"                NFC tap: ms, tag uid

This script serves those to the dashboard over a WebSocket, and (when
`backend_url` is set) posts surveys, location matches, acknowledgements and falls
to the Steady backend.

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
import wifi_scan  # noqa: E402  (path set up above)
from steady_net import WebSocketServer  # noqa: E402

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CONFIG = {
    # Shown on the Settings page when a browser connects
    "device_id": "ST-UNOQ1",
    "firmware": "1.1.0",
    # 0.0.0.0 so the dashboard can reach the board over the care network
    "ws_host": "0.0.0.0",
    "ws_port": 8765,
    # Steady backend (the Worker in web/). Leave empty to run without one.
    #   "backend_url": "http://192.168.1.20:8787"
    "backend_url": "",
    "backend_token": "",
    # Survey mode: how many scans make up one room fingerprint
    "survey_scans": 5,
    "survey_interval_s": 1.5,
    # Scan and match every N seconds (0 = only when a survey is taken)
    "locate_every_s": 0,
}

# ---------------------------------------------------------------------------
# Bridge handlers (called by the sketch — keep them trivial)
# ---------------------------------------------------------------------------

_samples: deque[str] = deque(maxlen=400)
_falls: deque[str] = deque(maxlen=32)
_oks: deque[str] = deque(maxlen=32)
_surveys: deque[str] = deque(maxlen=8)
_taps: deque[str] = deque(maxlen=32)

_identify = threading.Event()


def _on_motion(line: str) -> None:
    _samples.append(line)


def _on_fall(line: str) -> None:
    _falls.append(line)


def _on_ok(line: str) -> None:
    _oks.append(line)


def _on_survey(line: str) -> None:
    _surveys.append(line)


def _on_nfc(line: str) -> None:
    _taps.append(line)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _numbers(line: str, expected: int) -> list[float] | None:
    parts = line.split(",")
    if len(parts) != expected:
        return None
    try:
        return [float(part) for part in parts]
    except ValueError:
        return None


def _parse_motion(line: str) -> dict | None:
    values = _numbers(line, 7)
    if not values:
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
    values = _numbers(line, 3)
    if not values:
        return None
    return {"type": "fall", "t": int(values[0]), "peak": round(values[1], 2), "freefall_ms": int(values[2])}


def _parse_ok(line: str) -> dict | None:
    values = _numbers(line, 2)
    if not values:
        return None
    return {"type": "ok", "t": int(values[0])}


def _parse_tap(line: str) -> dict | None:
    parts = line.split(",")
    if len(parts) != 2:
        return None
    try:
        at = int(float(parts[0]))
    except ValueError:
        return None
    tag = parts[1].strip().replace(":", "").upper()[:32]
    return {"type": "tap", "t": at, "tag": tag} if tag else None


# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------

_backend_failed = False


def _post(path: str, payload: dict, timeout: float = 6.0) -> dict | None:
    global _backend_failed
    base = CONFIG.get("backend_url", "").strip().rstrip("/")
    if not base:
        return None

    request = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {CONFIG.get('backend_token', '')}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            _backend_failed = False
            return json.loads(response.read() or b"{}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        # One line per outage, not one per event
        if not _backend_failed:
            print(f"[steady] backend {path} failed: {exc}")
            _backend_failed = True
        return None


# ---------------------------------------------------------------------------
# Survey mode
# ---------------------------------------------------------------------------

_server: WebSocketServer | None = None
_survey_running = False
_survey_lock = threading.Lock()
_last_location: dict = {}


def _broadcast(event: dict) -> None:
    if _server is not None:
        _server.broadcast(json.dumps(event, separators=(",", ":")))


def _start_survey() -> None:
    global _survey_running
    with _survey_lock:
        if _survey_running:
            print("[steady] survey already running")
            return
        _survey_running = True

    def work() -> None:
        global _survey_running
        try:
            print("[steady] survey: scanning the room…")
            result = wifi_scan.run_survey(CONFIG["survey_scans"], CONFIG["survey_interval_s"])
            if not result["scan_count"]:
                print("[steady] survey: no Wi-Fi scans came back (nmcli/iw/iwlist?)")
                _broadcast({"type": "survey", "scans": 0, "accessPoints": 0, "error": "no-scans"})
                return

            summary = {
                "type": "survey",
                "scans": result["scan_count"],
                "accessPoints": result["access_points"],
                "takenAt": result["taken_at"],
            }
            stored = _post(
                "/api/v1/surveys",
                {
                    "device": CONFIG["device_id"],
                    "taken_at": result["taken_at"],
                    "scans": result["scans"],
                },
            )
            if stored and stored.get("id"):
                summary["id"] = stored["id"]
            _broadcast(summary)
            print(f"[steady] survey stored: {result['scan_count']} scans, {result['access_points']} APs")
        finally:
            _survey_running = False

    threading.Thread(target=work, name="steady-survey", daemon=True).start()


def _locate_now() -> None:
    scan = wifi_scan.scan_access_points()
    if not scan:
        return
    match = _post("/api/v1/locate", {"device": CONFIG["device_id"], "scan": scan})
    if not match or not match.get("room"):
        return
    _last_location.update(match)
    _broadcast(
        {
            "type": "location",
            "room": match["room"],
            "floor": match.get("floor") or "",
            "confidence": match.get("confidence"),
        }
    )


_locate_running = False


def _maybe_locate() -> None:
    global _locate_running
    every = float(CONFIG.get("locate_every_s") or 0)
    if every <= 0 or _locate_running:
        return
    _locate_running = True

    def work() -> None:
        global _locate_running
        try:
            _locate_now()
        finally:
            _locate_running = False

    threading.Thread(target=work, name="steady-locate", daemon=True).start()


# ---------------------------------------------------------------------------
# WebSocket plumbing
# ---------------------------------------------------------------------------


def _hello(send) -> None:
    send(
        json.dumps(
            {
                "type": "hello",
                "device": CONFIG["device_id"],
                "firmware": CONFIG["firmware"],
                "rate": 50,
            }
        )
    )


def _client_message(text: str) -> None:
    try:
        message = json.loads(text)
    except ValueError:
        return
    if not isinstance(message, dict):
        return
    if message.get("type") == "identify":
        _identify.set()
    elif message.get("type") == "survey":
        _surveys.append(f"{int(time.time() * 1000)},3")


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

_checked_sketch = False
_next_locate = 0.0


def loop() -> None:
    global _checked_sketch, _next_locate

    if not _checked_sketch:
        try:
            info = Bridge.call("steady_info", timeout=2)
            if isinstance(info, str) and info:
                print(f"[steady] sketch reports {info}")
        except Exception as exc:  # the sketch may still be booting
            print(f"[steady] sketch info unavailable: {exc}")
        _checked_sketch = True

    while _samples:
        sample = _parse_motion(_samples.popleft())
        if sample is not None:
            _broadcast(sample)

    while _falls:
        fall = _parse_fall(_falls.popleft())
        if fall is not None:
            _broadcast(fall)
            _post(
                "/api/v1/ingest",
                {
                    "device": CONFIG["device_id"],
                    "firmware": CONFIG["firmware"],
                    "events": [
                        {
                            "uid": f"{CONFIG['device_id']}-{fall['t']}",
                            "ts": int(time.time() * 1000),
                            "device_ts": fall["t"],
                            "peak_g": fall["peak"],
                            "confidence": 90,
                        }
                    ],
                },
            )
            print(f"[steady] fall detected, peak {fall['peak']} g")

    while _oks:
        ok = _parse_ok(_oks.popleft())
        if ok is not None:
            _broadcast(ok)
            _post(
                "/api/v1/acks",
                {"device": CONFIG["device_id"], "kind": "ok", "ts": int(time.time() * 1000)},
            )

    while _taps:
        tap = _parse_tap(_taps.popleft())
        if tap is not None:
            _broadcast(tap)
            _post(
                "/api/v1/acks",
                {
                    "device": CONFIG["device_id"],
                    "kind": "nfc",
                    "tag": tap["tag"],
                    "ts": int(time.time() * 1000),
                },
            )
            print(f"[steady] responder tap {tap['tag']}")

    while _surveys:
        _surveys.popleft()
        _start_survey()

    now = time.time()
    if CONFIG.get("locate_every_s") and now >= _next_locate:
        _next_locate = now + float(CONFIG["locate_every_s"])
        _maybe_locate()

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
    Bridge.provide("steady_ok", _on_ok)
    Bridge.provide("steady_survey", _on_survey)
    Bridge.provide("steady_nfc", _on_nfc)

    _server = WebSocketServer(
        CONFIG["ws_host"],
        CONFIG["ws_port"],
        on_message=_client_message,
        on_connect=_hello,
        on_disconnect=None,
    ).start()
    print(f"[steady] {CONFIG['device_id']} serving ws://{CONFIG['ws_host']}:{CONFIG['ws_port']}")
    if CONFIG.get("backend_url"):
        print(f"[steady] posting surveys and acks to {CONFIG['backend_url']}")

    App.run(user_loop=loop)


if __name__ == "__main__":
    main()
