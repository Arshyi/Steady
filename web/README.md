# Steady website — Cloudflare Worker + D1

Ingest API, server-side fall analysis, and the survey store the wearable posts
Wi-Fi fingerprints to. The Databricks backend the dashboard reads is in `server/`;
this Worker listens on 8788 so the two can run side by side.

## Local development

```bash
npm install
npm run dev                  # http://127.0.0.1:8788
npm run simulate -- --url http://127.0.0.1:8788 --token dev-token \
  --device steady-001 --minutes 30 --fall
```

`wrangler dev` creates the local D1 database on first run; the Worker applies
`schema.sql` itself (`CREATE TABLE IF NOT EXISTS …`) so there is no migration
step. `.dev.vars` supplies the two local secrets:

```
DEVICE_TOKEN="dev-token"     # device → site bearer token
VIEW_KEY="dev-view-key"      # dashboard read key
```

Open the root URL and unlock with `dev-view-key`.

## Tests

```bash
npm test                     # node --test: analysis engine + location matcher
```

The analysis engine in `src/analysis.js` is pure and shared with the Worker:
`decodeWaveform` → `summarizeWindow` → `classify` → `analyseEvent`. Device
waveforms are packed as little-endian `int16` sextuplets in milli-g and
0.1 dps, exactly as the firmware stores them.

`src/locate.js` is the same kind of module for room-level location: it
normalises scans, averages labelled fingerprints into one centroid per room and
matches a live scan by mean absolute RSSI difference over the access points
the scan and the room share (at least two). `locate.test.js` covers a noisy
scan, an unknown room and the shared-AP floor.

## API

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/v1/ingest` | `Authorization: Bearer DEVICE_TOKEN` | `{device, firmware, samples[], events[], heartbeat}`; 500 samples / 10 events per call |
| GET | `/api/v1/health` | none | `{ok, time}` |
| GET | `/api/v1/devices` | view key | devices + 24 h counters |
| GET | `/api/v1/summary?device=&hours=` | view key | aggregates + latest sample + event counts |
| GET | `/api/v1/series?device=&minutes=&bucket=` | view key | bucketed time series for the charts |
| GET | `/api/v1/events?device=&limit=` | view key | fall candidates without waveforms |
| GET | `/api/v1/events/:id` | view key | waveform + server analysis + review state |
| POST | `/api/v1/events/:id/review` | view key | `{label: "fall" \| "false-alarm" \| "near-fall" \| "pending", note}` |
| GET | `/api/v1/export?device=&hours=` | view key | CSV of raw samples |
| POST | `/api/v1/surveys` | device token | `{device, taken_at, scans: [[{bssid, rssi, ssid?, channel?}], …]}` — a survey-mode capture |
| GET | `/api/v1/surveys?device=&limit=` | view key | captures with room/floor and fingerprint counts |
| POST | `/api/v1/surveys/:id/label` | view key | `{room, floor}` — names a capture and its fingerprints |
| POST | `/api/v1/locate` | device token | `{device, scan: [{bssid, rssi}]}` → best room, distance, confidence |
| GET | `/api/v1/location?device=` | view key | the last match stored for that device |
| POST | `/api/v1/acks` | device token | `{device, kind: "ok" \| "nfc", tag?, ts?}` |
| GET | `/api/v1/acks?device=&limit=` | view key | recent "I'm OK" presses and NFC taps |

The view key is sent as `x-view-key` (the dashboard stores it in
`localStorage`) or `?key=` (used by the CSV export link).

Ingest writes are idempotent per `(device, ts)` and per event `uid`, so a device
replaying its offline spool does not duplicate rows.

## Survey mode and location

The wearable can say "I'm OK" (one button press) and staff can tap an NFC tag on
it; both arrive as an ack. Room location uses Wi-Fi fingerprints:

1. Staff walks into a room and presses the button three times.
2. The UNO Q's Linux side scans Wi-Fi five times and posts the BSSID/RSSI lists.
   They land in `surveys` and `fingerprints`, unlabelled.
3. Settings shows the capture with its scan and access-point counts; staff types
   the room and floor and the rows are labelled.
4. Later scans are matched against the per-room average RSSI, and the winning
   room is stored in `locations`. `GET /api/v1/location` is what a fall alert
   reads for "room 103, floor 1".

Matching is mean absolute RSSI distance over shared access points, with two in
common required. Confidence drops with distance and when only a couple of APs
overlap, so a bad match looks bad rather than certain. It is room-level, not a
position — a room with one access point is not a fingerprint.

## Deploy

```bash
npx wrangler d1 create steady          # put the returned id in wrangler.jsonc
npx wrangler secret put DEVICE_TOKEN
npx wrangler secret put VIEW_KEY
npx wrangler deploy
```

Then point `firmware/steady/python/config.json` at
`https://<worker>.<subdomain>.workers.dev/api/v1/ingest` and restart the app.

Without Cloudflare credentials you can still run the whole stack locally: the
UNO Q only needs to reach the `wrangler dev` port over your LAN.

## Analysis the site adds on top of the device

* Independent re-derivation of free-fall duration, impact peak, posture change
  and post-impact stillness from the uploaded waveform.
* Agreement state: `agree`, `device-only` (likely false alarm), `server-only`
  (device thresholds may be too strict) or `no-waveform`.
* Severity (low/medium/high) and human-readable notes per event.
* Human review labels, plus the CSV export for threshold tuning elsewhere.

## Security notes

* Ingest and read paths use separate secrets, compared in constant time over
  SHA-256 digests.
* All responses are `cache-control: no-store`.
* `/api/*` answers CORS preflights and echoes any `Origin`, so the Vite dev
  server can call `wrangler dev` from `localhost:5173`. Restrict that to a known
  dashboard origin before deploying.
* `DEVICE_TOKEN` is shared by all devices in this prototype; per-device tokens
  are the obvious next step (add a `devices.token_hash` column).
* Sample retention is 30 days (pruned on ingest); fall events are kept until
  deleted.
