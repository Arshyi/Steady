# Steady server

A small Node backend between the web app and Databricks. It:

- creates the Steady tables in Databricks on first start (`workspace.steady` by default)
- runs the simulator when the data source is **Simulated**
- reads Databricks every 4 seconds, works out each resident's status, and raises alerts
- accepts readings and falls from real devices when the data source is **Live devices**

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
| `POST /api/readings` `[{ deviceId, movement, gyroDps, accelG, battery, rssi, heartRate }]` | Devices, the UNO Q relay, or Settings with a device connected |
| `POST /api/falls` `{ deviceId }` | Fast path for a fall |
| `POST /api/simulate/fall` `{ residentId }` | Settings → Demo a fall |

## Testing without the UNO Q

`npm run relay:mock` runs a stand-in for the board's relay on your laptop. In Settings, switch to
Live devices, connect over Wi-Fi to `localhost`, and pair `UNOQ-SIM` to a resident. Type `f` and
press Enter in the relay's terminal to send a fall. `server/mock-relay.ts` is also the reference
for what the real relay on the UNO Q has to do.

`movement` is 0–100: the mean gyroscope magnitude in °/s divided by 2, capped at 100.
Status thresholds are at the top of `state.ts`.

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

### Demo fill (Arduino accelerometer branch)

In the local store, device mode fills in dummy data for everything that is not
real: residents with no live device get a `DEMO-<room>` stream, and a real device
gets dummy heart rate, battery and signal so its row is not half empty. This is
what makes the UNO + accelerometer demo look like a working wing. Turn it off
with `DEMO_FILL=0` to see only what the hardware actually sends.

See `arduino/README.md` for MPU6050 wiring and upload steps.
