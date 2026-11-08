"""No-board tests for nonblocking, bounded summary delivery."""

from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from reading_sender import ReadingSender


def wait_until(predicate, timeout=2):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("worker did not reach expected state")
        time.sleep(0.005)


class ReadingSenderTests(unittest.TestCase):
    def test_construction_does_not_start_threads(self):
        with patch("reading_sender.threading.Thread") as worker:
            sender = ReadingSender(lambda _: True)
            sender.submit({"movement": 1})
            worker.assert_not_called()

    def test_batches_preserve_input_timestamp_and_snapshot(self):
        sent = []
        sender = ReadingSender(lambda batch: sent.append(batch) or True, batch_size=2)
        original = {"deviceId": "ST-1", "movement": 3, "ts": "2026-11-07T20:00:00Z"}
        sender.submit(original)
        original["movement"] = 999
        sender.submit({"movement": 4})
        sender.submit({"movement": 5})
        sender.start()
        try:
            wait_until(lambda: sender.pending == 0)
            self.assertEqual([len(batch) for batch in sent], [2, 1])
            self.assertEqual(sent[0][0]["movement"], 3)
            self.assertEqual(sent[0][0]["ts"], "2026-11-07T20:00:00Z")
            self.assertIn("ts", sent[0][1])
        finally:
            self.assertTrue(sender.close())

    def test_blocked_http_does_not_block_submissions_and_capacity_includes_inflight(self):
        entered, release = threading.Event(), threading.Event()
        warn = Mock()
        sent = []

        def send(batch):
            sent.append(batch)
            entered.set()
            release.wait(2)
            return True

        sender = ReadingSender(send, max_pending=3, batch_size=1, warn=warn)
        sender.submit({"movement": 1})
        sender.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertTrue(sender.submit({"movement": 2}))
            self.assertTrue(sender.submit({"movement": 3}))
            self.assertFalse(sender.submit({"movement": 4}))
            self.assertEqual(sender.pending, 3)
            self.assertEqual(sender.dropped, 1)
            self.assertEqual(len(sent), 1)  # no second parallel HTTP call
            self.assertIn("dropped newest summary", warn.call_args.args[0])
        finally:
            release.set()
            wait_until(lambda: sender.pending == 0)
            self.assertTrue(sender.close())
        self.assertEqual([batch[0]["movement"] for batch in sent], [1, 2, 3])

    def test_failed_send_retries_same_timestamp_and_does_not_ack_on_truthy_response(self):
        sent = []
        warn = Mock()

        def send(batch):
            sent.append(batch)
            if len(sent) == 1:
                batch[0]["movement"] = -1  # callbacks cannot corrupt the retained snapshot
                raise OSError("offline")
            if len(sent) == 2:
                return {"accepted": 0}  # callback must return literal True, not any truthy object
            return True

        sender = ReadingSender(send, retry_delay=0.01, warn=warn)
        sender.submit({"movement": 3})
        sender.start()
        try:
            wait_until(lambda: sender.pending == 0)
            self.assertEqual(len(sent), 3)
            self.assertEqual(len({batch[0]["ts"] for batch in sent}), 1)
            self.assertEqual(sent[-1][0]["movement"], 3)
            self.assertEqual(sender.dropped, 0)
            self.assertEqual(warn.call_count, 1)  # one warning per continuing outage
        finally:
            self.assertTrue(sender.close())

    def test_close_reports_unconfirmed_rows_and_rejects_new_work(self):
        entered, release = threading.Event(), threading.Event()
        warn = Mock()

        def send(_):
            entered.set()
            release.wait(2)
            return False

        sender = ReadingSender(send, warn=warn)
        sender.submit({"movement": 1})
        sender.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertFalse(sender.close(timeout=0))
            self.assertIn("unconfirmed", warn.call_args.args[0])
            self.assertFalse(sender.submit({"movement": 2}))
            self.assertEqual(sender.dropped, 1)
        finally:
            release.set()
            self.assertTrue(sender.close())
        self.assertEqual(sender.pending, 1)


if __name__ == "__main__":
    unittest.main()
