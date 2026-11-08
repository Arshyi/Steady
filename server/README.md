# Steady server

A small Node backend between the web app and Databricks. It:

- creates the Steady tables in Databricks on first start (`workspace.steady` by default)
- runs the simulator when the data source is **Simulated**
- reads Databricks every 4 seconds, works out each resident's status, and raises alerts
- accepts paired device readings and falls independently of the selected dashboard view

## Run it

```
databricks auth login --host <your workspace URL>   # once per machine
cp server/.env.example server/.env                  # then fill in host + SQL warehouse ID
npm run dev                                         # web app + server together
```

The server uses your Databricks CLI login, so there are no tokens in the project.

## Tables (`workspace.steady`)

| Table | What's in it |
| --- | --- |
| `residents` | Name, room, and the simulated device each resident wears |
| `devices` | Every device seen, with firmware |
| `pairings` | Which real device each resident wears |
| `readings` | One row per device every few seconds: movement score, gyroscope, accelerometer, heart rate, battery, signal. `source` is `simulated` or `device` |
| `alerts` | Falls, checks, low battery, weak signal, with when they were handled |
| `app_settings` | The current data source |

## API

| Endpoint | Used by |
| --- | --- |
| `GET /api/state` | Every screen (polled every 3 s) |
| `POST /api/mode` `{ mode }` | Settings → Data source |
| `POST /api/alerts/:id/handle` and `/undo` | Acknowledge, Done, Undo |
| `POST /api/pairings` `{ residentId, deviceId, firmware }` | Settings → Pair |
| `POST /api/readings` `[{ deviceId, movement, gyroDps, accelG, battery, rssi, heartRate }]` | Devices and the UNO Q relay |
| `POST /api/falls` `{ deviceId }` | Fast path for a fall |
| `POST /api/acks` `{ deviceId, kind, tag? }` | Device button/NFC acknowledgment of the newest open live-device alert |
| `POST /api/simulate/fall` `{ residentId }` | Settings → Demo a fall |

## Testing without the UNO Q

`npm test` runs local regression tests without Databricks credentials. They cover database
write acknowledgment/failure, simulator cancellation, and diagnostic connection cleanup.
`npm run build` type-checks the application and backend and builds the dashboard.

Settings → **Try a demo device** is a sensor preview only. It cannot be paired or send synthetic
falls/readings into Live devices. Use the **Simulated** data source to exercise dashboard alerts.

`npm run relay:mock` runs a stand-in for the board's relay on your laptop. In Settings, switch to
Live devices, connect over Wi-Fi to `localhost`, and pair `UNOQ-SIM` to a resident. Type `f` and
press Enter in the relay's terminal to send a fall. `server/mock-relay.ts` is also the reference
for what the real relay on the UNO Q has to do.

`movement` is 0–100: the mean gyroscope magnitude in °/s divided by 2, capped at 100.
Status thresholds are at the top of `state.ts`.

## Delivery and deployment limits

`/api/readings` returns `accepted` only after its Databricks insert succeeds. Requests share
batches with a 3-second collection delay; callers must allow additional time for the SQL
warehouse to execute. Database failures return an error so the sender can retain and retry
the data. The integrated UNO Q relay does not yet provide a durable offline retry queue;
these server changes alone do not make offline collection reliable. A response lost after a
commit can also result in duplicate readings if retried, until event IDs/deduplication exist.

Unresolved alerts stay visible regardless of age; the 12-hour history window applies only
to handled alerts. A device acknowledgment only clears a live-device alert, never a simulated one.

The development API listens on all interfaces and has no authentication, apart from the optional
`DEVICE_TOKEN` on `/api/v1/ingest`. Use it
only on a trusted development network with synthetic data until access control and transport
security are added for deployment.

## Running without Databricks

If DATABRICKS_HOST and DATABRICKS_WAREHOUSE_ID are not set the server uses a
local store instead: readings and alerts live in memory, and the data mode,
pairings and firmware versions are kept in server/.data/local.json (ignored by
git). Everything the dashboard shows, the ingest endpoint and the simulator work
the same way, so the whole path can be run on one machine.

## Wearable ingest

The UNO Q posts the same batched JSON as web/src/worker.js to
POST /api/v1/ingest (set "endpoint" in the device config):

```jsonc
{
  "device": "ST-UNOQ1",
  "firmware": "1.2.0",
  "battery": 84,
  "rssi": -61,
  "samples": [{ "ts": 1730000000000, "ax": 0.02, "ay": 0.01, "az": 1.0, "gx": 1.2, "gy": 0.4, "gz": 0.1, "svm": 1.0004, "state": 1 }],
  "events": [{ "peak_g": 6.0, "tilt_delta": 82, "confidence": 88 }]
}
```

Samples at 10-200 Hz are folded into one reading per second; each event raises a
fall alert with the peak g and posture change in its detail. If DEVICE_TOKEN is
set, the device must send "Authorization: Bearer <token>". GET /api/v1/health
reports which store is in use, and GET /api/devices lists every wearable the
server has heard from so it can be paired in Settings.

To simulate a wearable end to end:

```sh
npm run dev                 # dashboard + server
npm run sim:device          # posts 10 Hz batches as ST-UNOQ1
npm run sim:device -- --fall-every 90 --minutes 5
```
