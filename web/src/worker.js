/**
 * Steady ingest + dashboard API.
 *
 *   POST /api/v1/ingest                  device -> site (bearer token)
 *   GET  /api/v1/health                  liveness (no auth)
 *   GET  /api/v1/devices                 device list + 24 h counters
 *   GET  /api/v1/summary?device=&hours=  window aggregates + latest sample
 *   GET  /api/v1/series?device=&minutes=&bucket=
 *   GET  /api/v1/events?device=&limit=   fall candidates (no waveforms)
 *   GET  /api/v1/events/:id              one event with waveform + analysis
 *   POST /api/v1/events/:id/review       human label (real fall / false alarm)
 *   GET  /api/v1/export?device=&hours=   CSV of raw samples
 *
 *   POST /api/v1/surveys                 survey mode: a triple-press capture (device)
 *   GET  /api/v1/surveys?device=         captures, labelled or not
 *   POST /api/v1/surveys/:id/label       name a capture's room and floor
 *   POST /api/v1/locate                  match a scan against the fingerprints (device)
 *   GET  /api/v1/location?device=        where that device was last placed
 *   POST /api/v1/acks                    "I'm OK" press (device)
 *   GET  /api/v1/acks?device=&limit=     acknowledgement feed
 *
 * Read endpoints require the dashboard key (x-view-key header or ?key=); the
 * device endpoints require the ingest token. Every response is private.
 */
import { analyseEvent } from "./analysis.js";
import { centroids, locate, normaliseScan, summariseScans } from "./locate.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT,
  firmware TEXT,
  last_seen INTEGER,
  meta TEXT
);
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ax REAL, ay REAL, az REAL,
  gx REAL, gy REAL, gz REAL,
  roll REAL, pitch REAL, tilt REAL, svm REAL,
  state INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_samples_device_ts ON samples(device, ts);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  device TEXT NOT NULL,
  ts INTEGER NOT NULL,
  device_ts INTEGER,
  duration_ms INTEGER,
  peak_g REAL,
  min_g REAL,
  tilt_before REAL,
  tilt_after REAL,
  tilt_delta REAL,
  confidence INTEGER,
  flags INTEGER,
  rate_hz INTEGER,
  waveform TEXT,
  analysis TEXT,
  verdict TEXT,
  severity TEXT,
  server_score INTEGER,
  agreement TEXT,
  reviewed_label TEXT,
  reviewed_note TEXT,
  reviewed_at INTEGER,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_device_ts ON events(device, ts DESC);
CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  device TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  scan_count INTEGER NOT NULL,
  access_points INTEGER NOT NULL,
  room TEXT,
  floor TEXT,
  labelled_at INTEGER,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_surveys_device ON surveys(device, taken_at DESC);
CREATE TABLE IF NOT EXISTS fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL,
  device TEXT NOT NULL,
  room TEXT,
  floor TEXT,
  bssid TEXT NOT NULL,
  rssi INTEGER NOT NULL,
  ssid TEXT,
  channel INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fingerprints_survey ON fingerprints(survey_id);
CREATE INDEX IF NOT EXISTS idx_fingerprints_room ON fingerprints(room, bssid);
CREATE TABLE IF NOT EXISTS acks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  device TEXT NOT NULL,
  kind TEXT NOT NULL,
  tag TEXT,
  ts INTEGER NOT NULL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_acks_ts ON acks(ts DESC);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT NOT NULL,
  room TEXT,
  floor TEXT,
  confidence INTEGER,
  distance REAL,
  matched INTEGER,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_locations_device ON locations(device, ts DESC);
`;

const MAX_SAMPLES_PER_REQUEST = 500;
const MAX_BYTES = 4 * 1024 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

let schemaPromise = null;
let lastPrune = 0;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "OPTIONS") return preflight(request);

    try {
      await ensureSchema(env);
      return withCors(await route(request, env, url), request);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.error("steady: unhandled", path, message);
      return withCors(json({ error: "server_error", detail: message }, 500), request);
    }
  },
};

async function ensureSchema(env) {
  if (!env.DB) throw new Error("D1 binding DB is missing");
  if (!schemaPromise) {
    // D1's exec() treats its input line by line, so multi-line CREATE TABLE
    // statements have to be run one prepared statement at a time.
    schemaPromise = (async () => {
      const statements = SCHEMA.split(";")
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) {
        await env.DB.prepare(statement).run();
      }
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  await schemaPromise;
}

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/v1/health") {
    return json({ ok: true, time: Date.now() });
  }
  if (path === "/api/v1/ingest") {
    if (method !== "POST") return json({ error: "method_not_allowed" }, 405);
    return ingest(request, env);
  }
  if (path === "/api/v1/surveys" && method === "POST") return createSurvey(request, env);
  if (path === "/api/v1/locate" && method === "POST") return locateDevice(request, env);
  if (path === "/api/v1/acks" && method === "POST") return createAck(request, env);

  if (!(await isViewer(request, env, url))) {
    return json({ error: "unauthorized", hint: "send x-view-key or ?key=" }, 401);
  }

  if (path === "/api/v1/devices") return listDevices(env);
  if (path === "/api/v1/summary") return summary(env, url);
  if (path === "/api/v1/series") return series(env, url);
  if (path === "/api/v1/events") return listEvents(env, url);
  if (path === "/api/v1/export") return exportCsv(env, url);
  if (path === "/api/v1/surveys") return listSurveys(env, url);
  if (path === "/api/v1/location") return locationFor(env, url);
  if (path === "/api/v1/acks") return listAcks(env, url);

  const label = path.match(/^\/api\/v1\/surveys\/(\d+)\/label$/);
  if (label) {
    if (method !== "POST") return json({ error: "method_not_allowed" }, 405);
    return labelSurvey(request, env, Number(label[1]));
  }

  const match = path.match(/^\/api\/v1\/events\/(\d+)(\/review)?$/);
  if (match) {
    if (match[2]) {
      if (method !== "POST") return json({ error: "method_not_allowed" }, 405);
      return reviewEvent(request, env, Number(match[1]));
    }
    if (method !== "GET") return json({ error: "method_not_allowed" }, 405);
    return getEvent(env, Number(match[1]));
  }

  return json({ error: "not_found", path }, 404);
}

// ------------------------------------------------------------------- ingest
async function ingest(request, env) {
  if (!(await isDevice(request, env))) {
    return json({ error: "unauthorized" }, 401);
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BYTES) return json({ error: "payload_too_large" }, 413);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const device = String(body.device || request.headers.get("x-device-id") || "");
  if (!DEVICE_ID_RE.test(device)) {
    return json({ error: "invalid_device_id", hint: "A-Z a-z 0-9 . _ - up to 64 chars" }, 400);
  }

  const now = Date.now();
  const firmware = body.firmware ? String(body.firmware).slice(0, 40) : null;
  const statements = [];

  statements.push(
    env.DB.prepare(
      `INSERT INTO devices (id, name, firmware, last_seen, meta)
       VALUES (?1, ?1, ?2, ?3, NULL)
       ON CONFLICT(id) DO UPDATE SET
         last_seen = excluded.last_seen,
         firmware = COALESCE(excluded.firmware, devices.firmware)`,
    ).bind(device, firmware, now),
  );

  const samples = Array.isArray(body.samples) ? body.samples.slice(0, MAX_SAMPLES_PER_REQUEST) : [];
  const sampleStmt = env.DB.prepare(
    `INSERT OR IGNORE INTO samples
       (device, ts, ax, ay, az, gx, gy, gz, roll, pitch, tilt, svm, state)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  );
  let accepted = 0;
  for (const s of samples) {
    const ts = Math.round(num(s.ts, 0));
    if (!ts) continue;
    const ax = num(s.ax);
    const ay = num(s.ay);
    const az = num(s.az);
    const svm = Number.isFinite(Number(s.svm)) ? Number(s.svm) : Math.hypot(ax, ay, az);
    statements.push(
      sampleStmt.bind(
        device, ts, ax, ay, az,
        num(s.gx), num(s.gy), num(s.gz),
        num(s.roll), num(s.pitch), num(s.tilt),
        svm, Math.round(num(s.state, 0)),
      ),
    );
    accepted += 1;
  }

  const events = Array.isArray(body.events) ? body.events.slice(0, 10) : [];
  const storedEvents = [];
  for (const event of events) {
    const ts = Math.round(num(event.ts, now));
    const uid = String(event.uid || `${device}-${ts}`).slice(0, 96);
    const analysis = analyseEvent({
      waveform: event.waveform || null,
      confidence: num(event.confidence, 0),
    });
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO events
           (uid, device, ts, device_ts, duration_ms, peak_g, min_g, tilt_before,
            tilt_after, tilt_delta, confidence, flags, rate_hz, waveform, analysis,
            verdict, severity, server_score, agreement, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                 ?16, ?17, ?18, ?19, ?20)`,
      ).bind(
        uid,
        device,
        ts,
        Math.round(num(event.device_ts, 0)),
        Math.round(num(event.duration_ms, 0)),
        num(event.peak_g),
        num(event.min_g),
        num(event.tilt_before),
        num(event.tilt_after),
        num(event.tilt_delta),
        Math.round(num(event.confidence, 0)),
        Math.round(num(event.flags, 0)),
        Math.round(num(event.rate_hz, 200)),
        event.waveform ? JSON.stringify(event.waveform) : null,
        JSON.stringify(analysis),
        analysis.verdict,
        analysis.severity,
        analysis.serverScore,
        analysis.agreement,
        now,
      ),
    );
    storedEvents.push({ uid, verdict: analysis.verdict, agreement: analysis.agreement });
  }

  if (body.heartbeat && typeof body.heartbeat === "object") {
    statements.push(
      env.DB.prepare(`UPDATE devices SET meta = ?2, last_seen = ?3 WHERE id = ?1`).bind(
        device,
        JSON.stringify(body.heartbeat).slice(0, 4000),
        now,
      ),
    );
  }

  // D1 batches are happiest at a few hundred statements.
  for (let i = 0; i < statements.length; i += 150) {
    await env.DB.batch(statements.slice(i, i + 150));
  }

  if (now - lastPrune > 10 * 60 * 1000) {
    lastPrune = now;
    await env.DB.prepare(`DELETE FROM samples WHERE ts < ?1`).bind(now - RETENTION_MS).run();
  }

  return json({ ok: true, device, samples: accepted, events: storedEvents.length, stored: storedEvents });
}

// ------------------------------------------------------------------ queries
async function listDevices(env) {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.name, d.firmware, d.last_seen,
            (SELECT COUNT(*) FROM events e WHERE e.device = d.id AND e.ts >= ?1) AS falls_24h,
            (SELECT COUNT(*) FROM samples s WHERE s.device = d.id AND s.ts >= ?1) AS samples_24h
       FROM devices d
      ORDER BY d.last_seen DESC
      LIMIT 50`,
  )
    .bind(dayAgo)
    .all();
  return json({ devices: results || [] });
}

async function summary(env, url) {
  const device = url.searchParams.get("device");
  if (!device) return json({ error: "missing_device" }, 400);
  const hours = clampInt(url.searchParams.get("hours"), 1, 168, 24);
  const from = Date.now() - hours * 3600 * 1000;

  const aggregates = await env.DB.prepare(
    `SELECT COUNT(*) AS samples, AVG(svm) AS avg_svm, MAX(svm) AS max_svm,
            AVG(tilt) AS avg_tilt, MIN(ts) AS first_ts, MAX(ts) AS last_ts
       FROM samples WHERE device = ?1 AND ts >= ?2`,
  )
    .bind(device, from)
    .first();

  const latest = await env.DB.prepare(
    `SELECT ts, ax, ay, az, roll, pitch, tilt, svm, state
       FROM samples WHERE device = ?1 ORDER BY ts DESC LIMIT 1`,
  )
    .bind(device)
    .first();

  const deviceRow = await env.DB.prepare(
    `SELECT id, name, firmware, last_seen, meta FROM devices WHERE id = ?1`,
  )
    .bind(device)
    .first();

  const events = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN confidence >= 70 THEN 1 ELSE 0 END) AS confirmed,
            SUM(CASE WHEN reviewed_label = 'false-alarm' THEN 1 ELSE 0 END) AS false_alarms
       FROM events WHERE device = ?1 AND ts >= ?2`,
  )
    .bind(device, from)
    .first();

  // Activity index: how much the gravity magnitude moved over the window.
  const spread = await env.DB.prepare(
    `SELECT AVG((svm - 1.0) * (svm - 1.0)) AS variance FROM samples
      WHERE device = ?1 AND ts >= ?2`,
  )
    .bind(device, from)
    .first();

  return json({
    device,
    window_hours: hours,
    device_row: deviceRow || null,
    latest: latest || null,
    aggregates: aggregates || null,
    events: events || null,
    activity_index: spread && spread.variance ? Math.sqrt(spread.variance) : 0,
  });
}

async function series(env, url) {
  const device = url.searchParams.get("device");
  if (!device) return json({ error: "missing_device" }, 400);
  const minutes = clampInt(url.searchParams.get("minutes"), 1, 1440, 15);
  const bucket = clampInt(url.searchParams.get("bucket"), 100, 60000, 1000);
  const from = Date.now() - minutes * 60 * 1000;

  const { results } = await env.DB.prepare(
    `SELECT CAST(ts / ?1 AS INTEGER) * ?1 AS bucket,
            AVG(svm) AS svm, MAX(svm) AS peak, AVG(tilt) AS tilt,
            AVG(ax) AS ax, AVG(ay) AS ay, AVG(az) AS az
       FROM samples
      WHERE device = ?2 AND ts >= ?3
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT 5000`,
  )
    .bind(bucket, device, from)
    .all();

  return json({ device, minutes, bucket_ms: bucket, points: results || [] });
}

async function listEvents(env, url) {
  const device = url.searchParams.get("device");
  if (!device) return json({ error: "missing_device" }, 400);
  const limit = clampInt(url.searchParams.get("limit"), 1, 200, 50);

  const { results } = await env.DB.prepare(
    `SELECT id, uid, ts, duration_ms, peak_g, min_g, tilt_delta, confidence,
            flags, verdict, severity, server_score, agreement,
            reviewed_label, reviewed_note, reviewed_at
       FROM events
      WHERE device = ?1
      ORDER BY ts DESC
      LIMIT ?2`,
  )
    .bind(device, limit)
    .all();

  return json({ device, events: results || [] });
}

async function getEvent(env, id) {
  const row = await env.DB.prepare(`SELECT * FROM events WHERE id = ?1`).bind(id).first();
  if (!row) return json({ error: "not_found" }, 404);

  const parsed = {
    ...row,
    waveform: row.waveform ? safeJson(row.waveform) : null,
    analysis: row.analysis ? safeJson(row.analysis) : null,
  };
  return json({ event: parsed });
}

async function reviewEvent(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const allowed = new Set(["fall", "false-alarm", "near-fall", "pending"]);
  const label = String(body.label || "");
  if (!allowed.has(label)) {
    return json({ error: "invalid_label", allowed: [...allowed] }, 400);
  }
  const note = body.note ? String(body.note).slice(0, 500) : null;

  const result = await env.DB.prepare(
    `UPDATE events SET reviewed_label = ?2, reviewed_note = ?3, reviewed_at = ?4 WHERE id = ?1`,
  )
    .bind(id, label, note, Date.now())
    .run();

  if (!result.meta || result.meta.changes === 0) return json({ error: "not_found" }, 404);
  return json({ ok: true, id, label });
}

async function exportCsv(env, url) {
  const device = url.searchParams.get("device");
  if (!device) return json({ error: "missing_device" }, 400);
  const hours = clampInt(url.searchParams.get("hours"), 1, 720, 24);
  const from = Date.now() - hours * 3600 * 1000;

  const { results } = await env.DB.prepare(
    `SELECT ts, ax, ay, az, gx, gy, gz, roll, pitch, tilt, svm, state
       FROM samples WHERE device = ?1 AND ts >= ?2
      ORDER BY ts ASC LIMIT 100000`,
  )
    .bind(device, from)
    .all();

  const header = "ts,iso_time,ax_g,ay_g,az_g,gx_dps,gy_dps,gz_dps,roll_deg,pitch_deg,tilt_deg,svm_g,state";
  const lines = [header];
  for (const row of results || []) {
    lines.push(
      [
        row.ts,
        new Date(row.ts).toISOString(),
        row.ax, row.ay, row.az,
        row.gx, row.gy, row.gz,
        row.roll, row.pitch, row.tilt, row.svm, row.state,
      ].join(","),
    );
  }

  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="steady-${device}-${hours}h.csv"`,
      "cache-control": "no-store",
    },
  });
}

// ------------------------------------------------------- survey + location

async function createSurvey(request, env) {
  if (!(await isDevice(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const device = cleanDevice(body.device);
  if (!device) return json({ error: "invalid_device_id" }, 400);

  const summary = summariseScans(body.scans);
  if (!summary.scanCount) {
    return json({ error: "empty_survey", hint: "send scans: [[{bssid, rssi}, …], …]" }, 400);
  }

  const takenAt = Math.round(num(body.taken_at, Date.now()));
  const uid = String(body.uid || `${device}-survey-${takenAt}`).slice(0, 96);

  const existing = await env.DB.prepare(`SELECT id FROM surveys WHERE uid = ?1`).bind(uid).first();
  if (existing) return json({ ok: true, id: existing.id, uid, duplicate: true });

  const inserted = await env.DB.prepare(
    `INSERT INTO surveys (uid, device, taken_at, scan_count, access_points, room, floor, labelled_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)`,
  )
    .bind(uid, device, takenAt, summary.scanCount, summary.accessPoints, body.room || null, body.floor || null, Date.now())
    .run();

  const surveyId = inserted.meta && inserted.meta.last_row_id;
  const statements = [];
  for (const scan of summary.scans) {
    for (const ap of scan) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO fingerprints (survey_id, device, room, floor, bssid, rssi, ssid, channel)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        ).bind(surveyId, device, body.room || null, body.floor || null, ap.bssid, ap.rssi, ap.ssid, ap.channel),
      );
    }
  }
  for (let i = 0; i < statements.length; i += 100) {
    await env.DB.batch(statements.slice(i, i + 100));
  }

  return json({
    ok: true,
    id: surveyId,
    uid,
    scans: summary.scanCount,
    accessPoints: summary.accessPoints,
  });
}

async function listSurveys(env, url) {
  const device = url.searchParams.get("device");
  const limit = clampInt(url.searchParams.get("limit"), 1, 200, 40);
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.uid, s.device, s.taken_at, s.scan_count, s.access_points,
            s.room, s.floor, s.labelled_at,
            (SELECT COUNT(*) FROM fingerprints f WHERE f.survey_id = s.id) AS samples
       FROM surveys s
      WHERE (?1 IS NULL OR s.device = ?1)
      ORDER BY s.taken_at DESC
      LIMIT ?2`,
  )
    .bind(device || null, limit)
    .all();
  return json({ device: device || null, surveys: results || [] });
}

async function labelSurvey(request, env, id) {
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const room = String(body.room || "").trim().slice(0, 40);
  const floor = String(body.floor || "").trim().slice(0, 20);
  if (!room) return json({ error: "missing_room" }, 400);

  const updated = await env.DB.prepare(
    `UPDATE surveys SET room = ?2, floor = ?3, labelled_at = ?4 WHERE id = ?1`,
  )
    .bind(id, room, floor || null, Date.now())
    .run();
  if (!updated.meta || updated.meta.changes === 0) return json({ error: "not_found" }, 404);

  await env.DB.prepare(`UPDATE fingerprints SET room = ?2, floor = ?3 WHERE survey_id = ?1`)
    .bind(id, room, floor || null)
    .run();

  return json({ ok: true, id, room, floor: floor || null });
}

async function locateDevice(request, env) {
  if (!(await isDevice(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const device = cleanDevice(body.device);
  if (!device) return json({ error: "invalid_device_id" }, 400);

  const scan = normaliseScan(body.scan);
  if (!scan.length) return json({ error: "empty_scan" }, 400);

  const { results } = await env.DB.prepare(
    `SELECT room, floor, bssid, AVG(rssi) AS rssi
       FROM fingerprints
      WHERE room IS NOT NULL
      GROUP BY room, floor, bssid`,
  ).all();

  const match = locate(scan, centroids(results || []));
  if (!match.room) {
    return json({ room: null, reason: match.reason, compared: match.compared || 0 });
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO locations (device, room, floor, confidence, distance, matched, ts)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(device, match.room, match.floor || null, match.confidence, match.distance, match.shared, now)
    .run();

  return json({ ...match, device, ts: now });
}

async function locationFor(env, url) {
  const device = url.searchParams.get("device");
  if (!device) return json({ error: "missing_device" }, 400);

  const location = await env.DB.prepare(
    `SELECT device, room, floor, confidence, distance, matched, ts
       FROM locations WHERE device = ?1 ORDER BY ts DESC LIMIT 1`,
  )
    .bind(device)
    .first();

  return json({ device, location: location || null });
}

async function createAck(request, env) {
  if (!(await isDevice(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const device = cleanDevice(body.device);
  if (!device) return json({ error: "invalid_device_id" }, 400);

  const kind = String(body.kind || "").toLowerCase();
  if (kind !== "ok") return json({ error: "invalid_kind", allowed: ["ok"] }, 400);

  const ts = Math.round(num(body.ts, Date.now()));
  const uid = String(body.uid || `${device}-${kind}-${ts}`).slice(0, 96);

  await env.DB.prepare(
    `INSERT OR IGNORE INTO acks (uid, device, kind, ts, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(uid, device, kind, ts, Date.now())
    .run();

  return json({ ok: true, uid, kind });
}

async function listAcks(env, url) {
  const device = url.searchParams.get("device");
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 20);

  const { results } = await env.DB.prepare(
    `SELECT id, device, kind, ts FROM acks
      WHERE (?1 IS NULL OR device = ?1)
      ORDER BY ts DESC LIMIT ?2`,
  )
    .bind(device || null, limit)
    .all();

  return json({ device: device || null, acks: results || [] });
}

// ------------------------------------------------------------------- helpers
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function corsHeaders(request) {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-view-key",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

/** Lets the dashboard on the Vite dev server call the API from another origin. */
function preflight(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

function withCors(response, request) {
  const headers = corsHeaders(request);
  if (!Object.keys(headers).length) return response;
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
  return copy;
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

function cleanDevice(value) {
  const device = String(value || "");
  return DEVICE_ID_RE.test(device) ? device : "";
}

async function isDevice(request, env) {
  const provided = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return Boolean(env.DEVICE_TOKEN) && equals(provided, env.DEVICE_TOKEN);
}

async function isViewer(request, env, url) {
  const provided = request.headers.get("x-view-key") || url.searchParams.get("key") || "";
  if (!env.VIEW_KEY || !provided) return false;
  return equals(provided, env.VIEW_KEY);
}

async function equals(a, b) {
  const encoder = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(a))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(b))),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i += 1) diff |= va[i] ^ vb[i];
  return diff === 0;
}
