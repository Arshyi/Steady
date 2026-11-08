"""Runs the UNO Q app's WebSocket protocol on a laptop, without the board.

Use it to work on the Settings page when no UNO Q is at hand:

    python hardware/steady_unoq/tools/simulator.py --port 8765

It serves what `python/main.py` serves — hello, 50 Hz motion, falls — plus the
survey-mode and NFC traffic (an "I'm OK" press, a responder tap, a labelled-able
survey and a location match) so every dashboard state can be exercised. Stop it
with Ctrl+C.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

from steady_net import WebSocketServer  # noqa: E402

DEVICE_ID = "ST-SIM1"
FIRMWARE = "1.1.0"
RATE_HZ = 50


def noise(scale: float) -> float:
    return (random.random() - 0.5) * scale


def main() -> None:
    parser = argparse.ArgumentParser(description="Simulated Steady UNO Q device")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--fall-every", type=float, default=12.0, help="seconds between simulated falls")
    parser.add_argument("--ack-every", type=float, default=0.0, help="seconds between OK/tap events (0 = once, at 20 s)")
    args = parser.parse_args()

    def hello(send) -> None:
        print("[sim] browser connected")
        send(json.dumps({"type": "hello", "device": DEVICE_ID, "firmware": FIRMWARE, "rate": RATE_HZ}))

    def bye() -> None:
        print("[sim] browser disconnected")

    def message(text: str) -> None:
        try:
            payload = json.loads(text)
        except ValueError:
            return
        if isinstance(payload, dict) and payload.get("type") == "identify":
            print("[sim] identify: LED blink requested")
        elif isinstance(payload, dict) and payload.get("type") == "survey":
            print("[sim] survey requested from the dashboard")

    server = WebSocketServer(
        args.host, args.port, on_message=message, on_connect=hello, on_disconnect=bye
    ).start()
    print(f"[sim] {DEVICE_ID} serving ws://{args.host}:{args.port} — Ctrl+C to stop")

    started = time.time()
    next_sample = started
    next_fall = started + args.fall_every
    next_ack = started + 20.0
    ack_gap = args.ack_every or 18.0
    ack_index = 0
    next_survey = started + 35.0
    next_location = started + 12.0
    rooms = [("103", "1"), ("101", "1"), ("205", "2")]
    room_index = 0

    try:
        while True:
            now = time.time()
            if now >= next_sample:
                next_sample += 1 / RATE_HZ
                elapsed = now - started
                turn = max(0.0, math.sin(elapsed * 0.9)) ** 3

                server.broadcast(
                    json.dumps(
                        {
                            "type": "motion",
                            "t": int(elapsed * 1000),
                            "ax": round(0.02 + noise(0.02), 3),
                            "ay": round(-0.01 + noise(0.02), 3),
                            "az": round(1 + noise(0.02), 3),
                            "gx": round(25 * math.sin(elapsed * 1.7) + 140 * turn * math.sin(elapsed * 5) + noise(12), 1),
                            "gy": round(15 * math.cos(elapsed * 1.3) + 90 * turn * math.cos(elapsed * 4) + noise(12), 1),
                            "gz": round(10 * math.sin(elapsed * 0.7) + noise(12), 1),
                        },
                        separators=(",", ":"),
                    )
                )
            if now >= next_fall:
                next_fall = now + args.fall_every
                server.broadcast(json.dumps({"type": "fall", "t": int((now - started) * 1000), "peak": 3.4}))
                print("[sim] fall")
            if now >= next_ack:
                next_ack = now + ack_gap
                if ack_index % 2 == 0:
                    server.broadcast(json.dumps({"type": "ok", "t": int((now - started) * 1000)}))
                    print("[sim] I'm OK")
                else:
                    tag = f"04A2339C{ack_index:02X}80"
                    server.broadcast(
                        json.dumps({"type": "tap", "t": int((now - started) * 1000), "tag": tag})
                    )
                    print(f"[sim] responder tap {tag}")
                ack_index += 1
            if now >= next_survey:
                next_survey = now + 60.0
                label = rooms[room_index % len(rooms)]
                server.broadcast(
                    json.dumps(
                        {
                            "type": "survey",
                            "scans": 5,
                            "accessPoints": 7 + room_index,
                            "takenAt": int(now * 1000),
                        }
                    )
                )
                room_index += 1
                print(f"[sim] survey captured near room {label[0]}")
            if now >= next_location:
                next_location = now + 25.0
                room, floor = rooms[room_index % len(rooms)]
                server.broadcast(
                    json.dumps({"type": "location", "room": room, "floor": floor, "confidence": 82})
                )
            time.sleep(0.005)
    except KeyboardInterrupt:
        print("\n[sim] stopping")
    finally:
        server.close()


if __name__ == "__main__":
    main()
