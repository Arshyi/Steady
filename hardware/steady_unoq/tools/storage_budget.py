"""Measure example SQLite row footprints on this host, not UNO Q performance.

Creates disposable databases in an isolated temporary directory. This is a
capacity experiment, not persistence integrated into the Steady relay.
Run: python hardware/steady_unoq/tools/storage_budget.py --rows 100000 --budget-gib 8
"""

import argparse
import json
import math
from pathlib import Path
import sqlite3
import tempfile


def measure(directory: Path, kind: str, rows: int, budget_bytes: int) -> dict:
    path = directory / f"{kind}.sqlite3"
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    columns = "ax REAL, ay REAL, az REAL, gx REAL, gy REAL, gz REAL" if kind == "raw_50hz" else "movement REAL, gyro_dps REAL, accel_g REAL"
    db.execute(f"CREATE TABLE readings (id INTEGER PRIMARY KEY, device TEXT NOT NULL, ts_ms INTEGER NOT NULL, {columns})")
    db.execute("CREATE INDEX device_time ON readings(device, ts_ms)")
    hz = 50 if kind == "raw_50hz" else 1
    fields = 8 if hz == 50 else 5
    insert = f"INSERT INTO readings (device, ts_ms, {('ax,ay,az,gx,gy,gz' if hz == 50 else 'movement,gyro_dps,accel_g')}) VALUES ({','.join('?' for _ in range(fields))})"
    for start in range(0, rows, 250):
        batch = []
        for i in range(start, min(rows, start + 250)):
            # Non-integer values avoid unrealistically compact all-zero fixtures.
            wave = math.sin(i * 0.017)
            values = (wave * .1, wave * .2, 1 + wave * .03, wave * 80, wave * 40, wave * 20) if hz == 50 else (abs(wave) * 40, abs(wave) * 80, 1 + wave * .03)
            batch.append(("ST-UNOQ1", 1_800_000_000_000 + i * (1000 // hz), *values))
        with db:
            db.executemany(insert, batch)
    count = db.execute("SELECT count(*) FROM readings").fetchone()[0]
    integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    db.close()
    if count != rows or integrity != "ok":
        raise RuntimeError(f"SQLite verification failed: {count=}, {integrity=}")
    size = path.stat().st_size
    per_row = size / rows
    daily = per_row * hz * 86400
    return {
        "schema": kind, "rows": count, "sqlite_bytes_after_checkpoint": size,
        "bytes_per_row_including_index": round(per_row, 2),
        "MB_per_day_per_device": round(daily / 1_000_000, 2),
        "days_in_budget_one_device": round(budget_bytes / daily, 1),
        "integrity_check": integrity,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=100000)
    parser.add_argument("--budget-gib", type=float, default=8)
    parser.add_argument("--temp-dir", type=Path, help="writable parent for disposable benchmark files")
    args = parser.parse_args()
    if not 1000 <= args.rows <= 1_000_000 or not math.isfinite(args.budget_gib) or args.budget_gib <= 0:
        parser.error("rows must be 1000..1000000; budget-gib must be positive and finite")
    with tempfile.TemporaryDirectory(prefix="steady-storage-", dir=args.temp_dir) as temporary:
        result = {
            "kind": "host SQLite capacity estimate; not a UNO Q speed or endurance test",
            "sqlite_version": sqlite3.sqlite_version,
            "budget_GiB": args.budget_gib,
            "assumptions": "One device; numeric rows plus device/time index; checkpointed DB. Excludes OS, containers, transient WAL, backups, events and logs. Multiply daily size by device count.",
            "measurements": [measure(Path(temporary), kind, args.rows, int(args.budget_gib * 1024**3)) for kind in ("raw_50hz", "summary_1hz")],
        }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
