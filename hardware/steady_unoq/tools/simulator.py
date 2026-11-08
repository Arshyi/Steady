"""Runs the UNO Q app's WebSocket protocol on a laptop, without the board.

Use it to work on the Settings page when no UNO Q is at hand:

    python hardware/steady_unoq/tools/simulator.py --port 8765

It serves what `python/main.py` serves — the info line, 50 Hz `M` samples and
`F` on a fall — plus the survey-mode traffic (an "I'm OK" press, a worker's NFC
visit check, a survey capture and a room match) so every dashboard state can be
exercised. Stop it with Ctrl+C.
"""

from __future__ import annotations

import argparse
import math
import os
import random
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

from steady_net import WebSocketServer  # noqa: E402

DEVICE_ID = "ST-SIM1"
FIRMWARE = "1.2.0"
RATE_HZ = 50


def noise(scale: float) -> float:
    return (random.random() - 0.5) * scale


def main() -> None:
    parser = argparse.ArgumentParser(description="Simulated Steady UNO Q device")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--fall-every", type=float, default=12.0, help="seconds between simulated falls")
    parser.add_argument("--ack-every", type=float, default=0.0, help="seconds between OK/tap events (0 = 18 s)")
    args = parser.parse_args()

    info = f"I,{DEVICE_ID},{FIRMWARE}\n"

    def hello(send) -> None:
        print("[sim] browser connected")
        send(info)

    def bye() -> None:
        print("[sim] browser disconnected")

    def command(send, text: str) -> None:
        if text.strip() == "I?":
            send(info)

    def message(text: str) -> None:
        command_ = text.strip()
        if command_ == "I":
            print("[sim] identify: LED blink requested")
        elif command_ == "S":
            print("[sim] survey requested from the dashboard")

    server = WebSocketServer(
        args.host,
        args.port,
        on_message=message,
        on_connect=hello,
        on_disconnect=bye,
        on_command=command,
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
                    "M,{:.3f},{:.3f},{:.3f},{:.1f},{:.1f},{:.1f}\n".format(
                        0.02 + noise(0.02),
                        -0.01 + noise(0.02),
                        1 + noise(0.02),
                        25 * math.sin(elapsed * 1.7) + 140 * turn * math.sin(elapsed * 5) + noise(12),
                        15 * math.cos(elapsed * 1.3) + 90 * turn * math.cos(elapsed * 4) + noise(12),
                        10 * math.sin(elapsed * 0.7) + noise(12),
                    )
                )
            if now >= next_fall:
                next_fall = now + args.fall_every
                server.broadcast("F\n")
                print("[sim] fall")
            if now >= next_ack:
                next_ack = now + ack_gap
                if ack_index % 2 == 0:
                    server.broadcast("O\n")
                    print("[sim] I'm OK")
                else:
                    tag = f"04A2339C{ack_index:02X}80"
                    server.broadcast(f"T,{tag}\n")
                    print(f"[sim] visit verified with tag {tag}")
                ack_index += 1
            if now >= next_survey:
                next_survey = now + 60.0
                server.broadcast("S,5,{}\n".format(7 + room_index))
                print(f"[sim] survey captured near room {rooms[room_index % len(rooms)][0]}")
                room_index += 1
            if now >= next_location:
                next_location = now + 25.0
                room, floor = rooms[room_index % len(rooms)]
                server.broadcast(f"L,{room},{floor},82\n")
            time.sleep(0.005)
    except KeyboardInterrupt:
        print("\n[sim] stopping")
    finally:
        server.close()


if __name__ == "__main__":
    main()
