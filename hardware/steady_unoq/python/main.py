"""Steady — Arduino UNO Q app, Linux side.

The sketch on the STM32 (`sketch/sketch.ino`) reads the MPU6050 over I2C 50 times
a second and hands events to this script over the Bridge:

    "12345,0.02,-0.01,1.00,12.4,-3.1,0.8"    motion:  ms, ax, ay, az, gx, gy, gz
    "12980,3.42,180"                         fall:    ms, peak_g, free_fall_ms
    "13110,1"                                I'm OK:  ms, presses
    "14002,3"                                survey:  ms, presses (three taps)
    "14400,04:A2:33:9C:1B:80"                NFC tap: ms, tag uid

This script is the board's relay. It serves the dashboard over a WebSocket using
the same text lines as USB serial (see `src/hardware/protocol.ts`):

    I,<deviceId>,<firmware>       answer to "I?"
    M,ax,ay,az,gx,gy,gz           every sample
    F                             a fall
    O                             "I'm OK" pressed
    T,<tag>                       a responder tapped an NFC tag
    S,<scans>,<accessPoints>      a survey capture was stored
    L,<room>,<floor>,<confidence> the survey store matched a room

and it posts to two places:

  * the Databricks backend in `server/` — a one-second summary to /api/readings
    and /api/falls the moment a fall fires, exactly like `server/mock-relay.ts`
  * the survey store in `web/` — Wi-Fi fingerprints, location matches and the
    acknowledgement log that survey mode needs

The Bridge handlers below only append to a deque: a Python function provided
with `Bridge.provide` runs on a dedicated thread and must not call back into the
Bridge, and anything slow there stalls the MCU's link.
"""

from __future__ import annotations

import json
import math
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
    "firmware": "1.2.1",
    # 0.0.0.0 so the dashboard can reach the board over the care network
    "ws_host": "0.0.0.0",
    "ws_port": 8765,
    # The Databricks backend (server/). Leave empty to send readings nowhere.
    #   "server_url": "http://192.168.1.20:8787"
    "server_url": "http://10.200.3.118:8787",
    # The survey store (web/). Needs the view key from web/.dev.vars.
    "survey_url": "",
    "survey_key": "dev-view-key",
    # Survey mode: how many scans make up one room fingerprint
    "survey_scans": 5,
    "survey_interval_s": 1.5,
    # Scan and match every N seconds (0 = only when a survey is taken)
    "locate_every_s": 0,
    # NFC is not fitted yet: >0 makes the relay emit a dummy responder tap this
    # often, so the dashboard and backend can be exercised with fake tag data.
    "dummy_nfc_every_s": 0,
    "dummy_nfc_tag": "04A2339C1B80",
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
        "t": int(values[0]),
        "ax": values[1],
        "ay": values[2],
        "az": values[3],
        "gx": values[4],
        "gy": values[5],
        "gz": values[6],
    }


def _parse_fall(line: str) -> dict | None:
    values = _numbers(line, 3)
    if not values:
        return None
    return {"t": int(values[0]), "peak": values[1], "freefall_ms": int(values[2])}


def _parse_ok(line: str) -> dict | None:
    values = _numbers(line, 2)
    if not values:
        return None
    return {"t": int(values[0])}


def _parse_tap(line: str) -> dict | None:
    parts = line.split(",")
    if len(parts) != 2:
        return None
    try:
        at = int(float(parts[0]))
    except ValueError:
        return None
    tag = parts[1].strip().replace(":", "").upper()[:32]
    return {"t": at, "tag": tag} if tag else None


# ---------------------------------------------------------------------------
# Posting
# ---------------------------------------------------------------------------

_failed: set[str] = set()


def _post(base: str, path: str, payload: dict, key: str = "", timeout: float = 6.0) -> dict | None:
    """POST JSON to one of the two backends. Logs one line per outage, not per call."""
    base = (base or "").strip().rstrip("/")
    if not base:
        return None

    headers = {"content-type": "application/json"}
    if key:
        headers["x-view-key"] = key
    request = urllib.request.Request(
        f"{base}{path}", data=json.dumps(payload).encode(), method="POST", headers=headers
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            _failed.discard(path)
            body = response.read()
            return json.loads(body or b"{}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        if path not in _failed:
            print(f"[steady] {base}{path} failed: {exc}")
            _failed.add(path)
        return None


def _to_server(path: str, payload: dict) -> dict | None:
    return _post(CONFIG.get("server_url", ""), path, payload)


def _to_survey_store(path: str, payload: dict) -> dict | None:
    return _post(CONFIG.get("survey_url", ""), path, payload, key=CONFIG.get("survey_key", ""))


# ---------------------------------------------------------------------------
# Readings: one summary per second, like server/mock-relay.ts
# ---------------------------------------------------------------------------

_window: list[dict] = []
_window_lock = threading.Lock()
_last_summary = 0.0


def _summarize(now: float) -> None:
    global _last_summary
    if now - _last_summary < 1.0:
        return
    _last_summary = now

    with _window_lock:
        batch = _window[:]
        _window.clear()
    if not batch:
        return

    gyro = [math.sqrt(s["gx"] ** 2 + s["gy"] ** 2 + s["gz"] ** 2) for s in batch]
    accel = [math.sqrt(s["ax"] ** 2 + s["ay"] ** 2 + s["az"] ** 2) for s in batch]
    gyro_dps = sum(gyro) / len(gyro)
    accel_g = sum(accel) / len(accel)

    stored = _to_server(
        "/api/readings",
        {
            "deviceId": CONFIG["device_id"],
            "movement": min(100.0, gyro_dps / 2),
            "gyroDps": round(gyro_dps, 2),
            "accelG": round(accel_g, 3),
        },
    )
    if stored is not None and not stored.get("accepted"):
        print(f"[steady] server ignored the reading: pair {CONFIG['device_id']} to a resident")


# ---------------------------------------------------------------------------
# Survey mode
# ---------------------------------------------------------------------------

_server: WebSocketServer | None = None
_survey_running = False
_survey_lock = threading.Lock()
_last_location: dict = {}


def _broadcast(line: str) -> None:
    if _server is not None:
        _server.broadcast(line + "\n")


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
                return

            stored = _to_survey_store(
                "/api/v1/surveys",
                {
                    "device": CONFIG["device_id"],
                    "taken_at": result["taken_at"],
                    "scans": result["scans"],
                },
            )
            _broadcast(f"S,{result['scan_count']},{result['access_points']}")
            print(
                f"[steady] survey stored: {result['scan_count']} scans, "
                f"{result['access_points']} APs{' (not stored)' if stored is None else ''}"
            )
        finally:
            _survey_running = False

    threading.Thread(target=work, name="steady-survey", daemon=True).start()


def _locate_now() -> None:
    scan = wifi_scan.scan_access_points()
    if not scan:
        return
    match = _to_survey_store("/api/v1/locate", {"device": CONFIG["device_id"], "scan": scan})
    if not match or not match.get("room"):
        return
    _last_location.update(match)
    floor = match.get("floor") or ""
    _broadcast(f"L,{match['room']},{floor},{match.get('confidence') or ''}")


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
# Acknowledgements ("I'm OK", NFC taps)
# ---------------------------------------------------------------------------


def _ack(kind: str, tag: str | None = None) -> None:
    """Clear the resident's alert on the server and log the response for the dashboard."""
    payload = {"deviceId": CONFIG["device_id"], "kind": kind}
    if tag:
        payload["tag"] = tag
    cleared = _to_server("/api/acks", payload)
    if cleared is None:
        print("[steady] ack not delivered (is the server running and the device paired?)")

    log = {"device": CONFIG["device_id"], "kind": kind, "ts": int(time.time() * 1000)}
    if tag:
        log["tag"] = tag
    _to_survey_store("/api/v1/acks", log)


# ---------------------------------------------------------------------------
# WebSocket plumbing
# ---------------------------------------------------------------------------


def _hello(send) -> None:
    # No B (battery) line: the UNO Q cannot measure it, so the app shows "–"
    send(f"I,{CONFIG['device_id']},{CONFIG['firmware']}\n")


def _client_message(text: str) -> None:
    command = text.strip()
    if command == "I":
        _identify.set()
    elif command == "S":
        _surveys.append(f"{int(time.time() * 1000)},3")


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

_checked_sketch = False
_next_locate = 0.0
_next_dummy_tap = 0.0


def loop() -> None:
    global _checked_sketch, _next_locate, _next_dummy_tap

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
        if sample is None:
            continue
        _broadcast(
            "M,{:.3f},{:.3f},{:.3f},{:.1f},{:.1f},{:.1f}".format(
                sample["ax"], sample["ay"], sample["az"], sample["gx"], sample["gy"], sample["gz"]
            )
        )
        with _window_lock:
            _window.append(sample)

    while _falls:
        fall = _parse_fall(_falls.popleft())
        if fall is None:
            continue
        _broadcast("F")
        # Fast path: straight to the server, like the mock relay
        _to_server("/api/falls", {"deviceId": CONFIG["device_id"]})
        print(f"[steady] fall detected, peak {fall['peak']:.2f} g")

    while _oks:
        ok = _parse_ok(_oks.popleft())
        if ok is None:
            continue
        _broadcast("O")
        _ack("ok")

    while _taps:
        tap = _parse_tap(_taps.popleft())
        if tap is None:
            continue
        _broadcast(f"T,{tap['tag']}")
        _ack("nfc", tap["tag"])
        print(f"[steady] responder tap {tap['tag']}")

    while _surveys:
        _surveys.popleft()
        _start_survey()

    now = time.time()
    _summarize(now)

    if CONFIG.get("locate_every_s") and now >= _next_locate:
        _next_locate = now + float(CONFIG["locate_every_s"])
        _maybe_locate()

    # Dummy NFC: no reader is fitted yet, so taps can be faked for demos
    dummy_every = float(CONFIG.get("dummy_nfc_every_s") or 0)
    if dummy_every > 0 and now >= _next_dummy_tap:
        _next_dummy_tap = now + dummy_every
        _taps.append(f"{int(now * 1000)},{CONFIG['dummy_nfc_tag']}")

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
        on_command=_command,
    ).start()
    print(f"[steady] {CONFIG['device_id']} serving ws://{CONFIG['ws_host']}:{CONFIG['ws_port']}")
    if CONFIG.get("server_url"):
        print(f"[steady] readings and falls to {CONFIG['server_url']}")
    if CONFIG.get("survey_url"):
        print(f"[steady] surveys, location and acks to {CONFIG['survey_url']}")

    App.run(user_loop=loop)


def _command(send, text: str) -> None:
    """Answers "I?" without going through loop(), so the app sees info at once."""
    if text.strip() == "I?":
        _hello(send)


if __name__ == "__main__":
    main()
