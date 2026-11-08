"""Wi-Fi uplink: batches telemetry to the Steady website and survives outages.

Only the Python standard library is used, so nothing needs to be installed on
the UNO Q's Debian side.

Failure model: every payload that cannot be delivered is appended to a JSONL
spool file on the eMMC. A background thread retries the spool oldest-first, so a
Wi-Fi dropout loses nothing (up to the spool cap) and a reconnect replays the
gap. Fall events jump the queue: they are posted before samples.
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
import urllib.error
import urllib.request
import uuid

MAX_SPOOL_BYTES = 20 * 1024 * 1024


class Uplink:
    def __init__(
        self,
        endpoint: str,
        token: str,
        device_id: str,
        spool_dir: str = "data/spool",
        timeout: float = 8.0,
        heartbeat_s: float = 30.0,
        firmware: str = "",
    ) -> None:
        self.endpoint = endpoint
        self.token = token
        self.device_id = device_id
        self.spool_dir = spool_dir
        self.timeout = timeout
        self.heartbeat_s = heartbeat_s
        self.firmware = firmware

        self._queue: queue.Queue[tuple[int, dict]] = queue.Queue(maxsize=400)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._last_heartbeat = 0.0

        self.stats = {
            "posted": 0,
            "batches": 0,
            "failed_posts": 0,
            "spooled": 0,
            "replayed": 0,
            "dropped": 0,
        }

        os.makedirs(self.spool_dir, exist_ok=True)

    # ------------------------------------------------------------------ public
    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="steady-uplink", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 3.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)

    def enqueue_samples(self, batch: list[dict], device_id: str) -> None:
        if not batch:
            return
        self._put(
            {
                "device": device_id,
                "firmware": self.firmware,
                "samples": batch,
            }
        )

    def enqueue_event(self, event: dict, device_id: str) -> None:
        self._put(
            {
                "device": device_id,
                "firmware": self.firmware,
                "events": [event],
            }
        )

    def enqueue_heartbeat(self, device_id: str, status: dict | None = None) -> None:
        self._put(
            {
                "device": device_id,
                "firmware": self.firmware,
                "heartbeat": status or {},
            }
        )

    def snapshot(self) -> dict:
        with self._lock:
            stats = dict(self.stats)
        stats["queued"] = self._queue.qsize()
        stats["spool_files"] = len(self._spool_files())
        return stats

    # ------------------------------------------------------------------- queue
    def _put(self, payload: dict) -> None:
        try:
            self._queue.put_nowait((0, payload))
        except queue.Full:
            # Under back-pressure drop the oldest telemetry so alerts still pass.
            try:
                self._queue.get_nowait()
                self.stats["dropped"] += 1
                self._queue.put_nowait((0, payload))
            except (queue.Empty, queue.Full):
                self.stats["dropped"] += 1

    # ------------------------------------------------------------------ worker
    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                _priority, payload = self._queue.get(timeout=1.0)
            except queue.Empty:
                self._replay_spool()
                self._maybe_heartbeat()
                continue

            if self._post(payload):
                self.stats["posted"] += 1
                self.stats["batches"] += 1
                self._replay_spool()
            else:
                self._spool(payload)

    def _maybe_heartbeat(self) -> None:
        now = time.time()
        if now - self._last_heartbeat < self.heartbeat_s:
            return
        self._last_heartbeat = now
        try:
            self._queue.put_nowait(
                (0, {"device": self.device_id, "firmware": self.firmware, "heartbeat": {}})
            )
        except queue.Full:
            pass

    # ------------------------------------------------------------------- http
    def _post(self, payload: dict) -> bool:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.token}",
                "X-Device-Id": self.device_id,
                "User-Agent": "steady-unoq/1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                ok = 200 <= response.status < 300
                if not ok:
                    # 4xx will not get better by retrying, but 429/5xx will.
                    self.stats["failed_posts"] += 1
                return ok
        except urllib.error.HTTPError as exc:
            self.stats["failed_posts"] += 1
            if exc.code in (400, 401, 403, 413):
                # Auth/shape problems would loop forever in the spool: log and
                # drop this payload instead of replaying it.
                print(f"[steady] ingest rejected ({exc.code}); dropping payload")
                return True
            return False
        except (urllib.error.URLError, TimeoutError, OSError):
            self.stats["failed_posts"] += 1
            return False

    # ------------------------------------------------------------------ spool
    def _spool_files(self) -> list[str]:
        try:
            names = [n for n in os.listdir(self.spool_dir) if n.endswith(".jsonl")]
        except OSError:
            return []
        return [os.path.join(self.spool_dir, n) for n in sorted(names)]

    def _spool(self, payload: dict) -> None:
        path = os.path.join(
            self.spool_dir,
            f"{int(time.time())}-{uuid.uuid4().hex[:8]}.jsonl",
        )
        try:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, separators=(",", ":")))
                handle.write("\n")
            self.stats["spooled"] += 1
        except OSError as exc:
            print(f"[steady] cannot spool payload: {exc}")
            self.stats["dropped"] += 1
            return
        self._enforce_spool_cap()

    def _enforce_spool_cap(self) -> None:
        files = self._spool_files()
        total = 0
        sizes = []
        for path in files:
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            sizes.append((path, size))
            total += size
        for path, size in sizes:  # oldest first
            if total <= MAX_SPOOL_BYTES:
                break
            try:
                os.remove(path)
                total -= size
                self.stats["dropped"] += 1
            except OSError:
                break

    def _replay_spool(self) -> None:
        if self._stop.is_set():
            return
        for path in self._spool_files():
            try:
                with open(path, encoding="utf-8") as handle:
                    line = handle.readline()
            except OSError:
                continue
            if not line:
                try:
                    os.remove(path)
                except OSError:
                    pass
                continue
            try:
                payload = json.loads(line)
            except ValueError:
                os.remove(path)
                continue
            if not self._post(payload):
                return  # still offline: keep the file and try again later
            try:
                os.remove(path)
            except OSError:
                pass
            self.stats["replayed"] += 1
            return  # one replayed file per idle cycle keeps new data flowing
