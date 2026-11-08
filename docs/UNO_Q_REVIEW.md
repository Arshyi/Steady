# UNO Q code review — 2026-11-07

Reviewed GitHub `main` at `87c3a47` and fast-forwarded the clean local checkout
from `1af4da0`. Final validation and the PR use an isolated worktree on
`codex/uno-q-review-pr`, keeping subsequent work separate from the active
development checkout. See
[setup and storage recommendations](UNO_Q_SETUP.md) for the 4 GB / 32 GB board.

## Which code belongs together

- **Integrated application:** root React dashboard + `server/` Databricks API +
  `hardware/steady_unoq/` App Lab app. `web/` supplies its optional survey store.
- **Alternative experiment:** `firmware/steady/` 200 Hz detector + its own Python
  pipeline + `web/` waveform ingest/dashboard. Its protocol differs from the
  integrated application. Do not mix their sketch and Python directories.
- `hardware/steady_wearable/` is legacy Nano firmware.

## Findings corrected in this branch

| Finding | Change |
| --- | --- |
| Integrated MPU6050 was configured for ±2 g, below its 2.6 g and 3.5 g impact thresholds | Use ±8 g with matching conversion and register readback. A 3.5 g magnitude was impossible even with all three ±2 g axes saturated. |
| A completed free fall could remain armed until an unrelated later impact | Extract a host-testable detector with a 250 ms impact window, rollover-safe cooldown and sensor-error reset. |
| Wiring docs named A4/A5 while the code uses `Wire` | Correct to dedicated SDA/D20 and SCL/D21. UNO Q Qwiic is `Wire1`; recent cores expose A4/A5 as `Wire2`. |
| Every motion sample waited for an RPC response; optional NFC was automatically enabled when its library was present | Use `Bridge.notify` for motion; require explicit NFC opt-in. Event RPC waits remain a limitation below. |
| Relay ignored the MCU device ID and advertised a separate fallback ID | Obtain and validate the sketch identity before advertising/pairing or posting; retry if the sketch is still booting. |
| Survey/location/ack device writes sent the dashboard view key | Send `Authorization: Bearer DEVICE_TOKEN`, configured outside source through `STEADY_DEVICE_TOKEN`. |
| Non-finite numeric input could crash the relay; failed survey uploads still claimed success | Reject non-finite input and announce a stored survey only after a successful response. |
| Backend returned `accepted` before its memory batch committed, then discarded failures | Wait for serialized database commits before returning success; propagate failures and bound queued writes. |
| Waiting for those commits in the Python sensor loop would stall diagnostics | Batch summaries on a separate worker with a bounded 300-row RAM queue, original timestamps, explicit overflow reporting and retries. This is not durable storage. |
| Unresolved alerts disappeared after 12 hours; device acknowledgments could clear simulated alerts | Retain unresolved alerts regardless of age and restrict device acknowledgments to live-device alerts. |
| Stopped simulation could restart after an in-flight SQL call | Invalidate the old simulation generation before it can schedule another tick. |
| Built-in demo samples/falls could enter live resident data; leaving Settings leaked connections | Keep the built-in demo diagnostic-only and close/invalidate old connection sessions. |
| Alternative firmware used an invalid Zephyr thread type and placed a >7.2 kB object on a 4 kB task stack | Use `k_tid_t` and serialize only event metadata on that stack. Target compilation remains unverified. |
| Alternative firmware's forced Qwiic option selected the header bus | Select `Wire1` for UNO Q/Zephyr, matching the default autodetection path. |

## Remaining findings, in priority order

These are deployment limitations, not claims that the entire product is ready.

1. **P1 — No durable offline delivery in the integrated relay.**
   [`python/main.py`](../hardware/steady_unoq/python/main.py) removes events from
   in-memory event queues before HTTP delivery. Network or power loss can lose
   falls and acknowledgments. Summary retries now use a bounded RAM queue;
   a restart or queue overflow can still lose summaries, and ambiguous HTTP
   responses can duplicate them. Backend commit acknowledgment is only part of the
   fix. Add a Linux SQLite event/outbox store, stable event IDs and idempotent
   backend writes. Preserve occurrence time and the pairing at that time; do
   not blindly replay an old acknowledgment against a resident's newest alert.

2. **P1 — Network clients can read or mutate the development backend without authentication.**
   [`server/index.ts`](../server/index.ts) listens on all interfaces, and exposes
   resident state, pairing, fall and acknowledgment routes without access
   control. The diagnostics WebSocket is also unauthenticated. Before broader
   deployment, add separate device/staff authorization, HTTPS/WSS, request
   limits and appropriate network restrictions. The current development setup
   should use synthetic data on a controlled network.

3. **P1 — The integrated sampling loop is still vulnerable to communication stalls.**
   Event `Bridge.call` invocations in
   [`sketch.ino`](../hardware/steady_unoq/sketch/sketch.ino) wait for Linux;
   HTTP event handling and WebSocket `sendall` in the Python loop can block.
   [`steady_net.py`](../hardware/steady_unoq/python/steady_net.py) has blocking
   sockets, so a stalled client can delay all broadcasts. Move sensor work to
   an independent MCU task and use bounded event handoff, transport deadlines
   and per-client output queues. Motion notifications and default-off NFC
   reduce stalls but do not establish a hard 50 Hz guarantee.

4. **P1 — Alternative waveform firmware can lose/mix events.**
   [`pipeline.py`](../firmware/steady/python/pipeline.py) forms event IDs from
   device ID plus an MCU sequence that restarts on reboot. The Worker's unique
   ID constraint can silently ignore a later reboot's falls. Separately,
   [`sketch.ino`](../firmware/steady/sketch/sketch.ino) replaces the pending
   waveform when a second fall arrives, while
   [`python/main.py`](../firmware/steady/python/main.py) fetches chunks and
   acknowledges without a sequence lease. Add boot-unique/persistent event IDs
   and a stable event snapshot with sequence-checked chunk reads/acknowledgment.

The threshold detector is not a validated fall classifier. Confirmed software
behavior does not establish clinical accuracy, real sensor timing or reliable
overnight monitoring.

## Verification

No live Databricks writes, board flashing or deployment were performed.

| Check | Outcome |
| --- | --- |
| `npm test` | 9 backend and connection-lifecycle tests passed |
| `npm run build` | TypeScript checks and Vite production build passed |
| `node --test web/test/*.test.js` | 15 analysis/location tests passed |
| `python -m unittest discover -s hardware/steady_unoq/tools -p 'test_*.py'` | 13 identity, parser, survey, authentication and background-delivery tests passed |
| `cmd /c hardware\steady_unoq\tools\run_detector_tests.bat` | 7 integrated detector regression scenarios passed with MSVC |
| `cmd /c firmware\steady\tools\build_host_test.bat` | 7 alternative detector scenarios plus waveform packing passed with MSVC |
| `node hardware/steady_unoq/tools/smoke_simulator.mjs` | Real local WebSocket exchange: identity, 50 finite motion samples and a fall in about one second |
| Python `compileall` | Both Python firmware directories and integrated tools compile |
| `storage_budget.py --rows 100000 --budget-gib 8 --temp-dir .` | Two disposable SQLite databases passed integrity checks; measured row/index sizes documented in setup guide |

The WebSocket test starts an isolated loopback simulator on an OS-assigned port
and stops it afterward. It does not connect to a real backend. Host detector
tests exercise portable algorithms, not Arduino/Zephyr build compatibility.
Neither test emulates the UNO Q, Bridge transport, IMU electronics or radio.

Still required: an App Lab target compile, physical board boot/wiring test,
measured sample rate under failures, power-loss/reconnect testing, and controlled
dummy/mat trials. The SQLite tool establishes example storage size only;
SQLite persistence is not yet integrated into the running application.
