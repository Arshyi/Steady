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
