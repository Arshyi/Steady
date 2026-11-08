/**
 * Room-level location from Wi-Fi fingerprints — pure functions, no I/O.
 *
 * Survey mode walks a room, presses the wearable's button three times, and the
 * board uploads several scans of what it can hear. Those scans are labelled with
 * a room and become the fingerprint database. A later scan is then matched
 * against the per-room average RSSI of every access point: the room whose
 * fingerprint is closest wins.
 *
 * RSSI is noisy and bodies absorb 2.4 GHz, so this is "which room is most
 * likely", never a precise position. Cheap APs also power-save and disappear
 * from scans, which is why matching is per-AP and tolerant of missing ones.
 */

const clamp = (value, low, high) => (value < low ? low : value > high ? high : value);
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

const BSSID_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

/** One scan is [{ bssid, rssi, ssid?, channel? }]; duplicates keep the strongest. */
export function normaliseScan(scan) {
  const byBssid = new Map();
  for (const ap of Array.isArray(scan) ? scan : []) {
    if (!ap) continue;
    const bssid = String(ap.bssid || "").trim().toUpperCase();
    const rssi = Number(ap.rssi);
    if (!BSSID_RE.test(bssid)) continue;
    if (!Number.isFinite(rssi) || rssi > 0 || rssi < -100) continue;

    const previous = byBssid.get(bssid);
    if (previous && previous.rssi >= rssi) continue;
    byBssid.set(bssid, {
      bssid,
      rssi: Math.round(rssi),
      ssid: typeof ap.ssid === "string" ? ap.ssid.slice(0, 64) : null,
      channel: Number.isFinite(Number(ap.channel)) ? Number(ap.channel) : null,
    });
  }
  return [...byBssid.values()].sort((a, b) => b.rssi - a.rssi);
}

/**
 * Reduces a survey (several scans taken in one room) to counts plus the scans
 * themselves. Home Wi-Fi repeats the same APs, so the distinct count is what
 * tells staff whether a survey is worth labelling.
 */
export function summariseScans(scans) {
  const cleaned = (Array.isArray(scans) ? scans : []).map(normaliseScan).filter((scan) => scan.length);
  const bssids = new Set();
  for (const scan of cleaned) for (const ap of scan) bssids.add(ap.bssid);
  return { scanCount: cleaned.length, accessPoints: bssids.size, scans: cleaned };
}

/**
 * Collapses labelled fingerprints into one average RSSI per AP per room.
 * Accepts raw fingerprint rows (bssid/rssi/room/floor) or already-averaged ones.
 */
export function centroids(fingerprints) {
  const rooms = new Map();

  for (const row of Array.isArray(fingerprints) ? fingerprints : []) {
    if (!row) continue;
    const room = String(row.room || "").trim();
    const bssid = String(row.bssid || "").trim().toUpperCase();
    const rssi = Number(row.rssi);
    if (!room || !BSSID_RE.test(bssid) || !Number.isFinite(rssi)) continue;

    const floor = String(row.floor || "").trim();
    const key = `${room}\u0000${floor}`;
    if (!rooms.has(key)) rooms.set(key, { room, floor, sum: new Map(), count: new Map() });
    const entry = rooms.get(key);
    entry.sum.set(bssid, (entry.sum.get(bssid) || 0) + rssi);
    entry.count.set(bssid, (entry.count.get(bssid) || 0) + 1);
  }

  return [...rooms.values()].map((entry) => {
    const rssiByBssid = {};
    for (const [bssid, sum] of entry.sum) rssiByBssid[bssid] = sum / entry.count.get(bssid);
    return { room: entry.room, floor: entry.floor, rssiByBssid, apCount: entry.sum.size };
  });
}

/**
 * Picks the room whose fingerprint is closest to `scan`.
 *
 * Distance is the mean absolute RSSI difference over access points seen by both
 * sides, so a room does not suffer for the APs it cannot hear. Rooms sharing too
 * few APs are not considered at all — two points in common is not a fingerprint.
 */
export function locate(scan, roomCentroids, { minShared = 2 } = {}) {
  const points = normaliseScan(scan);
  if (!points.length) return { room: null, reason: "empty-scan" };

  const scored = [];
  for (const centroid of Array.isArray(roomCentroids) ? roomCentroids : []) {
    let shared = 0;
    let total = 0;
    for (const ap of points) {
      const expected = centroid.rssiByBssid ? centroid.rssiByBssid[ap.bssid] : undefined;
      if (expected === undefined) continue;
      shared += 1;
      total += Math.abs(expected - ap.rssi);
    }
    if (shared < minShared) continue;
    scored.push({
      room: centroid.room,
      floor: centroid.floor || "",
      distance: total / shared,
      shared,
    });
  }

  if (!scored.length) return { room: null, reason: "no-match", compared: 0 };

  scored.sort((a, b) => a.distance - b.distance || b.shared - a.shared);
  const best = scored[0];
  const runnerUp = scored[1];
  const margin = runnerUp ? runnerUp.distance - best.distance : 10;

  // Closer and better-covered rooms are more trustworthy; a room that only wins
  // by a hair should not look as confident as one that clearly matches.
  const confidence = Math.round(
    clamp(
      100 - best.distance * 5 - Math.max(0, 3 - best.shared) * 8 + Math.min(margin, 6) * 2,
      5,
      99,
    ),
  );

  return {
    room: best.room,
    floor: best.floor,
    distance: round(best.distance),
    shared: best.shared,
    margin: round(margin),
    confidence,
    compared: scored.length,
    candidates: scored.slice(0, 5).map((c) => ({
      room: c.room,
      floor: c.floor,
      distance: round(c.distance),
      shared: c.shared,
    })),
  };
}
