"""Telemetry pipeline for the Linux (QRB2210) side of the Steady app.

Kept free of `arduino.app_utils` imports so the same code runs in host tests and
in `tools/replay.py` without a board attached.
"""

from __future__ import annotations

import json
import math
import struct
import time
from collections import deque

SAMPLE_KEYS = ("ax", "ay", "az", "gx", "gy", "gz")


class DeviceClock:
    """Maps MCU uptime (ms) onto UTC epoch seconds.

    The MCU has no RTC, so every Bridge packet is a clock observation. Taking
    the maximum of (utc - uptime) over a short window keeps the estimate at the
    lowest-latency observation, which ignores jitter spikes.
    """

    def __init__(self, window: int = 24) -> None:
        self._observations: deque[tuple[float, float]] = deque(maxlen=window)

    def observe(self, uptime_ms: float, utc_s: float) -> None:
        self._observations.append((uptime_ms / 1000.0, utc_s))

    @property
    def offset(self) -> float | None:
        if not self._observations:
            return None
        return max(utc - uptime for uptime, utc in self._observations)

    def to_utc_ms(self, uptime_ms: float) -> int | None:
        offset = self.offset
        if offset is None:
            return None
        return int(round((uptime_ms / 1000.0 + offset) * 1000.0))


def _finite(value, default=0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


class Pipeline:
    """Turns Bridge payloads into batches the uplink can post."""

    def __init__(self, uplink, device_id: str, max_samples: int = 6000) -> None:
        self.uplink = uplink
        self.device_id = device_id
        self.clock = DeviceClock()
        self.samples: deque[dict] = deque(maxlen=max_samples)
        self.pending_events: deque[dict] = deque()
        self.counters = {
            "telemetry": 0,
            "telemetry_bad": 0,
            "falls": 0,
            "waveforms": 0,
            "waveform_failures": 0,
            "samples_sent": 0,
            "samples_dropped": 0,
        }
        self.last_sample_at: float | None = None
        self.last_status: dict = {}

    # --------------------------------------------------------------- ingest
    def on_telemetry(self, raw: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        try:
            msg = json.loads(raw)
        except (TypeError, ValueError):
            self.counters["telemetry_bad"] += 1
            return
        if not isinstance(msg, dict):
            self.counters["telemetry_bad"] += 1
            return

        uptime_ms = _finite(msg.get("t"))
        self.clock.observe(uptime_ms, now)
        ts = self.clock.to_utc_ms(uptime_ms)
        sample = {
            "ts": ts if ts is not None else int(now * 1000),
            "ax": _finite(msg.get("ax")),
            "ay": _finite(msg.get("ay")),
            "az": _finite(msg.get("az")),
            "gx": _finite(msg.get("gx")),
            "gy": _finite(msg.get("gy")),
            "gz": _finite(msg.get("gz")),
            "roll": _finite(msg.get("r")),
            "pitch": _finite(msg.get("p")),
            "tilt": _finite(msg.get("tl")),
            "svm": _finite(msg.get("sv")),
            "state": int(_finite(msg.get("st"))),
        }
        self.samples.append(sample)
        self.counters["telemetry"] += 1
        self.last_sample_at = now

    def on_fall(self, raw: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        try:
            msg = json.loads(raw)
        except (TypeError, ValueError):
            return
        if not isinstance(msg, dict):
            return

        uptime_ms = _finite(msg.get("t"))
        ts = self.clock.to_utc_ms(uptime_ms)
        event = {
            "uid": f"{self.device_id}-{int(_finite(msg.get('seq')))}",
            "device_ts": int(round(uptime_ms)),
            "ts": ts if ts is not None else int(now * 1000),
            "duration_ms": int(_finite(msg.get("dur"))),
            "peak_g": _finite(msg.get("pk")),
            "min_g": _finite(msg.get("mn")),
            "tilt_before": _finite(msg.get("tb")),
            "tilt_after": _finite(msg.get("ta")),
            "tilt_delta": _finite(msg.get("dl")),
            "confidence": int(_finite(msg.get("cf"))),
            "flags": int(_finite(msg.get("fl"))),
            "sample_count": int(_finite(msg.get("n"))),
            "rate_hz": int(_finite(msg.get("hz"), 200)),
            "waveform": None,
        }
        self.counters["falls"] += 1
        self.pending_events.append(event)

    def on_status(self, raw: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        try:
            status = json.loads(raw)
        except (TypeError, ValueError):
            return
        if not isinstance(status, dict):
            return
        self.last_status = status
        self.clock.observe(_finite(status.get("up")), now)

    # -------------------------------------------------------------- waveforms
    def next_event_without_waveform(self) -> dict | None:
        for event in self.pending_events:
            if event["waveform"] is None:
                return event
        return None

    def attach_waveform(self, event: dict, packed: bytes, rate_hz: int) -> None:
        """Decodes the MCU's packed int16 triples into a flat sample array."""
        usable = len(packed) - (len(packed) % 12)
        if usable <= 0:
            self.counters["waveform_failures"] += 1
            return
        values = struct.unpack("<%dh" % (usable // 2), packed[:usable])
        flat: list[int] = []
        for i in range(0, len(values), 6):
            flat.extend(values[i : i + 6])
        event["waveform"] = {
            "rate_hz": rate_hz,
            "units": {"accel": "mg", "gyro": "0.1 dps"},
            "samples": flat,
        }
        self.counters["waveforms"] += 1
        self.pending_events.remove(event)
        self.uplink.enqueue_event(event, self.device_id)

    def abandon_event(self, event: dict) -> None:
        """Ship the event without a waveform rather than lose the alert."""
        self.counters["waveform_failures"] += 1
        event["waveform"] = None
        self.pending_events.remove(event)
        self.uplink.enqueue_event(event, self.device_id)

    # ----------------------------------------------------------------- output
    def flush(self, batch_size: int = 100) -> int:
        """Hands buffered samples to the uplink. Returns how many were sent."""
        if not self.samples:
            return 0
        batch = []
        while self.samples and len(batch) < batch_size:
            batch.append(self.samples.popleft())
        if not batch:
            return 0
        self.counters["samples_sent"] += len(batch)
        self.uplink.enqueue_samples(batch, self.device_id)
        return len(batch)

    def snapshot(self) -> dict:
        return {
            "device_id": self.device_id,
            "buffered_samples": len(self.samples),
            "pending_events": len(self.pending_events),
            "last_sample_age_s": (
                None
                if self.last_sample_at is None
                else round(time.time() - self.last_sample_at, 2)
            ),
            "last_status": self.last_status,
            "counters": dict(self.counters),
        }
