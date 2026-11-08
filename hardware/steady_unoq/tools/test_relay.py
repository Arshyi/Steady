"""Host regression tests; fake only the unavailable Arduino App Lab runtime."""

import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

PYTHON_DIR = Path(__file__).resolve().parents[1] / "python"
sys.path.insert(0, str(PYTHON_DIR))
runtime = types.ModuleType("arduino.app_utils")
runtime.App = Mock()
runtime.Bridge = Mock()
spec = importlib.util.spec_from_file_location("steady_relay", PYTHON_DIR / "main.py")
relay = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"arduino": types.ModuleType("arduino"), "arduino.app_utils": runtime}):
    spec.loader.exec_module(relay)


class RelayTests(unittest.TestCase):
    def setUp(self):
        relay._checked_sketch = False
        relay._next_info = 0.0
        relay._survey_running = False
        relay._last_summary = 0.0
        relay._window.clear()
        relay._reading_sender = None
        relay.CONFIG.update(device_id="FALLBACK", firmware="0.0.0")
        relay.Bridge.reset_mock(side_effect=True, return_value=True)

    def test_nonfinite_samples_and_events_are_rejected(self):
        for value in ("nan", "inf", "-inf", "1e999"):
            self.assertIsNone(relay._parse_motion(f"{value},0,0,1,0,0,0"))
            self.assertIsNone(relay._parse_motion(f"1,0,0,1,{value},0,0"))
            self.assertIsNone(relay._parse_fall(f"1,{value},200"))
            self.assertIsNone(relay._parse_ok(f"{value},1"))
            self.assertIsNone(relay._parse_tap(f"{value},ABCD"))
        self.assertIsNone(relay._parse_motion("-1,0,0,1,0,0,0"))
        self.assertEqual(relay._parse_motion("100,0,0,1,0,0,0")["az"], 1)

    def test_no_pairable_fallback_identity_before_mcu_is_ready(self):
        send = Mock()
        relay._hello(send)
        send.assert_not_called()

    def test_mcu_identity_updates_both_browser_and_backend_identity(self):
        relay.Bridge.call.return_value = "ST-0420;1.2.7"
        with patch.object(relay, "_broadcast") as broadcast:
            self.assertTrue(relay._sync_identity(10))
            broadcast.assert_called_once_with("I,ST-0420,1.2.7")
        self.assertEqual(relay.CONFIG["device_id"], "ST-0420")
        send = Mock()
        relay._hello(send)
        send.assert_called_once_with("I,ST-0420,1.2.7\n")
        # A paired device's identity stays stable during this relay run.
        self.assertTrue(relay._sync_identity(20))
        relay.Bridge.call.assert_called_once()

    def test_boot_failure_retries_and_invalid_identity_is_not_advertised(self):
        relay.Bridge.call.side_effect = [TimeoutError("booting"), "bad,id;1.0", "ST-2;1.0"]
        self.assertFalse(relay._sync_identity(10))
        self.assertFalse(relay._sync_identity(11))
        self.assertEqual(relay.Bridge.call.call_count, 1)
        self.assertFalse(relay._sync_identity(15))
        self.assertTrue(relay._sync_identity(20))
        self.assertEqual(relay.CONFIG["device_id"], "ST-2")

    def test_failed_survey_does_not_claim_capture_was_stored(self):
        class InlineThread:
            def __init__(self, target, **_):
                self.target = target

            def start(self):
                self.target()

        scan = {"scan_count": 5, "access_points": 3, "taken_at": 1, "scans": []}
        with patch.object(relay.threading, "Thread", InlineThread), \
             patch.object(relay.wifi_scan, "run_survey", return_value=scan), \
             patch.object(relay, "_to_survey_store", return_value=None) as post, \
             patch.object(relay, "_broadcast") as broadcast:
            relay._start_survey()
            broadcast.assert_not_called()
            self.assertFalse(relay._survey_running)
            post.return_value = {"ok": True}
            relay._start_survey()
            broadcast.assert_called_once_with("S,5,3")

    def test_survey_writes_use_device_bearer_token_not_view_key(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'{"ok":true}'
        with patch.dict(relay.CONFIG, {"device_token": "test-only-device-token"}), \
             patch.object(relay.urllib.request, "urlopen", return_value=response) as send:
            self.assertEqual(relay._to_survey_store("/api/v1/surveys", {"device": "ST-2"}), {"ok": True})
            request = send.call_args.args[0]
            self.assertEqual(request.get_header("Authorization"), "Bearer test-only-device-token")
            self.assertIsNone(request.get_header("X-view-key"))

    def test_summary_handoff_does_not_do_http_on_sensor_loop(self):
        relay._reading_sender = Mock()
        relay._window.append({"ax": 0, "ay": 0, "az": 1, "gx": 60, "gy": 0, "gz": 0})
        with patch.object(relay, "_post") as post:
            relay._summarize(10)
            post.assert_not_called()
        row = relay._reading_sender.submit.call_args.args[0]
        self.assertEqual(row["movement"], 30)
        self.assertEqual(row["accelG"], 1)

    def test_sender_requires_commit_confirmation_for_every_reading(self):
        batch = [{"deviceId": "ST-1", "movement": 1}]
        with patch.object(relay, "_post", side_effect=[None, {"accepted": 0}, {"accepted": 1}]) as post:
            self.assertFalse(relay._send_readings(batch))
            self.assertFalse(relay._send_readings(batch))
            self.assertTrue(relay._send_readings(batch))
            self.assertEqual(post.call_args.kwargs["timeout"], 45)


if __name__ == "__main__":
    unittest.main()
