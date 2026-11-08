import test from "node:test";
import assert from "node:assert/strict";

import { centroids, locate, normaliseScan, summariseScans } from "../src/locate.js";

// Three access points that a survey of room 101 would hear.
const ROOM_101 = [
  { bssid: "AA:BB:CC:00:00:01", rssi: -48 },
  { bssid: "AA:BB:CC:00:00:02", rssi: -61 },
  { bssid: "AA:BB:CC:00:00:03", rssi: -74 },
];

const ROOM_205 = [
  { bssid: "AA:BB:CC:00:00:02", rssi: -45 },
  { bssid: "AA:BB:CC:00:00:04", rssi: -52 },
  { bssid: "AA:BB:CC:00:00:05", rssi: -70 },
];

/** Fakes the rows the Worker would have stored for a labelled survey. */
function fingerprintsFor(room, floor, scans) {
  const rows = [];
  for (const scan of scans) {
    for (const ap of scan) rows.push({ room, floor, bssid: ap.bssid, rssi: ap.rssi });
  }
  return rows;
}

const jitter = (scan, delta) =>
  scan.map((ap, index) => ({ ...ap, rssi: ap.rssi + ((index % 2 ? 1 : -1) * delta) }));

test("normaliseScan keeps valid APs, dedupes by BSSID and sorts by strength", () => {
  const scan = normaliseScan([
    { bssid: "aa:bb:cc:00:00:01", rssi: -70 },
    { bssid: "AA:BB:CC:00:00:01", rssi: -55 },
    { bssid: "not-a-mac", rssi: -40 },
    { bssid: "AA:BB:CC:00:00:02", rssi: -90 },
    { bssid: "AA:BB:CC:00:00:03", rssi: 12 },
  ]);

  assert.equal(scan.length, 2);
  assert.equal(scan[0].bssid, "AA:BB:CC:00:00:01");
  assert.equal(scan[0].rssi, -55, "stronger duplicate wins");
  assert.equal(scan[1].bssid, "AA:BB:CC:00:00:02");
});

test("summariseScans counts distinct access points across a survey", () => {
  const summary = summariseScans([ROOM_101, jitter(ROOM_101, 2), []]);
  assert.equal(summary.scanCount, 2, "an empty scan is dropped");
  assert.equal(summary.accessPoints, 3);
});

test("centroids average repeated scans per room and access point", () => {
  const rows = [
    ...fingerprintsFor("101", "1", [ROOM_101]),
    ...fingerprintsFor("101", "1", [jitter(ROOM_101, 4)]),
    ...fingerprintsFor("205", "2", [ROOM_205]),
  ];
  const result = centroids(rows).sort((a, b) => a.room.localeCompare(b.room));

  assert.equal(result.length, 2);
  assert.equal(result[0].room, "101");
  assert.equal(result[0].floor, "1");
  assert.equal(result[0].apCount, 3);
  // first scan -48, jittered scan -52 → mean -50
  assert.equal(result[0].rssiByBssid["AA:BB:CC:00:00:01"], -50);
});

test("a room is identified from a noisy scan", () => {
  const database = centroids([
    ...fingerprintsFor("101", "1", [ROOM_101, jitter(ROOM_101, 3)]),
    ...fingerprintsFor("205", "2", [ROOM_205, jitter(ROOM_205, 3)]),
  ]);

  const match = locate(jitter(ROOM_101, 4), database);
  assert.equal(match.room, "101");
  assert.equal(match.floor, "1");
  assert.ok(match.confidence > 50, `confidence ${match.confidence}`);
  assert.ok(match.distance < 8, `distance ${match.distance} dB`);
  assert.ok(match.candidates.length >= 1);
});

test("a scan that matches nothing returns no room instead of guessing", () => {
  const database = centroids(fingerprintsFor("101", "1", [ROOM_101]));
  const stranger = [
    { bssid: "DE:AD:BE:EF:00:01", rssi: -50 },
    { bssid: "DE:AD:BE:EF:00:02", rssi: -60 },
  ];

  const match = locate(stranger, database);
  assert.equal(match.room, null);
  assert.equal(match.reason, "no-match");
});

test("one shared access point is not enough to place someone", () => {
  const database = centroids(fingerprintsFor("101", "1", [ROOM_101]));
  const thin = [{ bssid: "AA:BB:CC:00:00:01", rssi: -50 }];

  assert.equal(locate(thin, database).room, null);
  assert.equal(locate(thin, database, { minShared: 1 }).room, "101");
});

test("an empty scan is reported as such", () => {
  const database = centroids(fingerprintsFor("101", "1", [ROOM_101]));
  assert.equal(locate([], database).reason, "empty-scan");
});
