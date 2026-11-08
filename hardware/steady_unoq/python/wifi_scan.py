"""Wi-Fi scans for survey mode, using whatever the board has installed.

The UNO Q's Wi-Fi radio lives on the Linux side, so the sketch cannot scan: it
presses a button and this module does the work. Three tools are supported, best
first:

* ``iw``      — real dBm per access point (preferred)
* ``nmcli``   — NetworkManager; signal is a 0-100 quality, converted to dBm
* ``iwlist``  — older wireless-tools fallback

Everything here is parsing plus ``subprocess``; no third-party packages, because
the board's Python environment is not guaranteed to have any.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import time

# nmcli reports quality (0-100), not dBm. NetworkManager's own mapping is
# quality = 2 * (dBm + 100), so invert it and clamp into a sane RSSI range.
_QUALITY_TO_DBM = lambda quality: max(-100, min(-20, int(quality / 2) - 100))  # noqa: E731

_BSSID_RE = re.compile(r"^[0-9a-f]{2}(:[0-9a-f]{2}){5}$", re.IGNORECASE)


def _run(command: str, args: list[str], timeout: float = 25.0) -> str:
    executable = shutil.which(command)
    if not executable:
        return ""
    try:
        result = subprocess.run(
            [executable, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout if result.returncode == 0 else ""


def _clean(ap: dict) -> dict | None:
    bssid = str(ap.get("bssid", "")).strip().upper()
    try:
        rssi = int(round(float(ap.get("rssi"))))
    except (TypeError, ValueError):
        return None
    if not _BSSID_RE.match(bssid) or not (-100 <= rssi <= 0):
        return None
    return {
        "bssid": bssid,
        "rssi": rssi,
        "ssid": str(ap.get("ssid") or "")[:64] or None,
        "channel": ap.get("channel"),
    }


def _dedupe(access_points: list[dict]) -> list[dict]:
    """A survey scan can list the same BSSID twice; keep the strongest."""
    best: dict[str, dict] = {}
    for ap in access_points:
        cleaned = _clean(ap)
        if not cleaned:
            continue
        current = best.get(cleaned["bssid"])
        if current is None or cleaned["rssi"] > current["rssi"]:
            best[cleaned["bssid"]] = cleaned
    return sorted(best.values(), key=lambda ap: ap["rssi"], reverse=True)


def _split_nmcli(line: str) -> list[str]:
    """nmcli -t escapes the ':' inside values (an SSID can contain one)."""
    fields: list[str] = []
    current = ""
    escaped = False
    for char in line:
        if escaped:
            current += char
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == ":":
            fields.append(current)
            current = ""
        else:
            current += char
    fields.append(current)
    return fields


def parse_nmcli(text: str) -> list[dict]:
    """`nmcli -t -f BSSID,SIGNAL,SSID,CHANNEL device wifi list`"""
    out: list[dict] = []
    for line in text.splitlines():
        fields = _split_nmcli(line.strip())
        if len(fields) < 4:
            continue
        bssid, signal, ssid, channel = fields[0], fields[1], fields[2], fields[3]
        try:
            quality = int(signal)
        except ValueError:
            continue
        out.append(
            {
                "bssid": bssid,
                "rssi": _QUALITY_TO_DBM(quality),
                "ssid": ssid.replace("\\", "") if ssid else None,
                "channel": int(channel) if channel.isdigit() else None,
            }
        )
    return _dedupe(out)


def parse_iw(text: str) -> list[dict]:
    """`iw dev <iface> scan` — BSS lines with signal/SSID/DS channel."""
    out: list[dict] = []
    current: dict | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("BSS "):
            if current:
                out.append(current)
            bssid = line[4:].split("(")[0].strip()
            current = {"bssid": bssid, "rssi": None, "ssid": None, "channel": None}
        elif current is None:
            continue
        elif line.startswith("signal:"):
            match = re.search(r"(-?\d+(?:\.\d+)?)", line)
            if match:
                current["rssi"] = float(match.group(1))
        elif line.startswith("SSID:"):
            current["ssid"] = line.split(":", 1)[1].strip()
        elif line.startswith("DS Parameter set: channel"):
            digits = re.search(r"(\d+)", line)
            if digits:
                current["channel"] = int(digits.group(1))
    if current:
        out.append(current)
    return _dedupe(out)


def parse_iwlist(text: str) -> list[dict]:
    """`iwlist <iface> scan` — Cell blocks with Address/Signal level/ESSID."""
    out: list[dict] = []
    current: dict | None = None
    for raw in text.splitlines():
        line = raw.strip()
        match = re.match(r"Cell \d+ - Address: ([0-9A-Fa-f:]{17})", line)
        if match:
            if current:
                out.append(current)
            current = {"bssid": match.group(1), "rssi": None, "ssid": None, "channel": None}
            continue
        if current is None:
            continue
        if "Signal level" in line or "Quality" in line:
            signal = re.search(r"Signal level[=:](-?\d+)", line)
            if signal:
                current["rssi"] = float(signal.group(1))
        elif "ESSID:" in line:
            current["ssid"] = line.split("ESSID:", 1)[1].strip().strip('"')
        elif "Channel:" in line:
            digits = re.search(r"Channel:(\d+)", line)
            if digits:
                current["channel"] = int(digits.group(1))
    if current:
        out.append(current)
    return _dedupe(out)


def scan_access_points() -> list[dict]:
    """One scan, in whatever form the board can produce. Empty list on failure."""
    nmcli = _run("nmcli", ["-t", "-f", "BSSID,SIGNAL,SSID,CHANNEL", "device", "wifi", "list", "--rescan", "yes"])
    if nmcli.strip():
        parsed = parse_nmcli(nmcli)
        if parsed:
            return parsed

    iface = _wifi_interface()
    if iface:
        iw = _run("iw", ["dev", iface, "scan"])
        if iw.strip():
            parsed = parse_iw(iw)
            if parsed:
                return parsed

        iwlist = _run("iwlist", [iface, "scan"])
        if iwlist.strip():
            parsed = parse_iwlist(iwlist)
            if parsed:
                return parsed

    return []


def _wifi_interface() -> str:
    """First wireless interface name, e.g. wlan0."""
    try:
        names = sorted(name for name in __import__("os").listdir("/sys/class/net"))
    except OSError:
        return ""
    for name in names:
        if name.startswith(("wlan", "wlp", "wlx")):
            return name
    return ""


def run_survey(scans: int = 5, interval_s: float = 1.5, scanner=scan_access_points) -> dict:
    """Several scans in a row, which is what one room's fingerprint is built from."""
    taken_at = int(time.time() * 1000)
    captured: list[list[dict]] = []
    for index in range(max(1, int(scans))):
        if index:
            time.sleep(max(0.2, float(interval_s)))
        captured.append(scanner())

    distinct: set[str] = set()
    for scan in captured:
        for ap in scan:
            distinct.add(ap["bssid"])

    return {
        "taken_at": taken_at,
        "scans": captured,
        "scan_count": len([scan for scan in captured if scan]),
        "access_points": len(distinct),
    }
