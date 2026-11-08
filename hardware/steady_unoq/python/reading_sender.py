"""Bounded, non-durable background delivery of one-second motion summaries.

The callback sends a list of readings and returns True only when all are accepted.
It must have a finite network timeout. Failures retry the same timestamps; a lost
response after a successful commit can therefore produce duplicate database rows.
No worker starts on import or construction. This RAM queue is lost on power-off.
"""

from __future__ import annotations

from collections import deque
from copy import deepcopy
from datetime import datetime, timezone
import threading
from typing import Callable


class ReadingSender:
    def __init__(
        self,
        send: Callable[[list[dict]], bool],
        *,
        max_pending: int = 300,
        batch_size: int = 60,
        retry_delay: float = 5.0,
        warn: Callable[[str], None] = print,
    ) -> None:
        if max_pending < 1 or batch_size < 1 or retry_delay <= 0:
            raise ValueError("queue/batch capacities and retry delay must be positive")
        self._send = send
        self._max_pending = max_pending
        self._batch_size = batch_size
        self._retry_delay = retry_delay
        self._warn = warn
        self._pending: deque[dict] = deque()
        self._condition = threading.Condition()
        self._thread: threading.Thread | None = None
        self._closed = False
        self._dropped = 0

    @property
    def pending(self) -> int:
        """Unconfirmed rows, including the batch currently in flight."""
        with self._condition:
            return len(self._pending)

    @property
    def dropped(self) -> int:
        """Submissions refused because the queue was full or already closed."""
        with self._condition:
            return self._dropped

    def submit(self, payload: dict) -> bool:
        """Queue a snapshot without waiting for HTTP. False means this row was dropped."""
        row = deepcopy(payload)
        row.setdefault("ts", datetime.now(timezone.utc).isoformat(timespec="milliseconds"))
        with self._condition:
            if self._closed or len(self._pending) >= self._max_pending:
                self._dropped += 1
                reason = "closed" if self._closed else "full"
                dropped = self._dropped
            else:
                self._pending.append(row)
                self._condition.notify()
                return True
        self._warn(f"[steady] reading queue {reason}: dropped newest summary (total dropped: {dropped})")
        return False

    def start(self) -> ReadingSender:
        with self._condition:
            if self._closed:
                raise RuntimeError("cannot restart a closed reading sender")
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name="steady-readings", daemon=True)
                self._thread.start()
        return self

    def close(self, timeout: float = 2.0) -> bool:
        """Stop new sends; wait at most timeout for an in-flight HTTP call. Does not drain."""
        with self._condition:
            self._closed = True
            self._condition.notify_all()
            worker = self._thread
        if worker is not None:
            worker.join(timeout)
        remaining = self.pending
        if remaining:
            self._warn(
                f"[steady] stopping with {remaining} unconfirmed summaries in RAM; "
                "they are not durably stored and may be lost"
            )
        return worker is None or not worker.is_alive()

    def _run(self) -> None:
        failing = False
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._closed or bool(self._pending))
                if self._closed:
                    return
                # Keep in-flight rows in the queue so capacity covers all unconfirmed data.
                batch = list(self._pending)[: self._batch_size]
            error = "server did not accept the complete batch"
            try:
                accepted = self._send(deepcopy(batch)) is True
            except Exception as exc:
                accepted = False
                error = str(exc)
            if accepted:
                with self._condition:
                    for _ in batch:
                        self._pending.popleft()
                failing = False
            else:
                if not failing:
                    self._warn(f"[steady] readings not confirmed; retaining bounded RAM queue and retrying: {error}")
                failing = True
                with self._condition:
                    self._condition.wait_for(lambda: self._closed, timeout=self._retry_delay)
