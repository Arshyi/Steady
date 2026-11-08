# Steady — 4-minute hackathon pitch

Steady is a fall-detection wearable and a night-shift dashboard for a care home. A
real Arduino UNO Q with an MPU6050 detects falls on the device; one dashboard ranks
every fall by urgency and refuses to let a button press erase the need for a visit.

Claims marked **verified** were exercised on real hardware or a running server. The
Databricks path and the board-side Wi-Fi scan are implemented but not proven here;
those limits are stated explicitly rather than papered over.

**The one idea this pitch hangs on:** falls are common and often survivable. What
kills people is the wait after the fall — and the tools meant to shorten it depend on
a person pressing something, or on alarms staff have learned to distrust.

_Last revised 8 November 2026._

## Run of show (4:00)

| Time | On screen | Beat | Why it is here |
| --- | --- | --- | --- |
| 0:00–0:20 | Slide 1 | Hook: the 3 a.m. problem | One number, no preamble |
| 0:20–0:42 | Slide 2 | The wait is what kills | Establishes stakes with long-lie data |
| 0:42–1:10 | Slide 3 | What exists, measured | Quantifies why rivals fail, not opinions |
| 1:10–2:05 | **Live demo** | Three tiers; press does not close | The memorable proof |
| 2:05–2:40 | Slide 4 | What is unique | Four claims, each measurable |
| 2:40–3:20 | Slide 5 | How it runs: board → Databricks, NFC, location | Shows depth beyond the demo |
| 3:20–3:45 | Slide 6 | Real / simulated / next | Credibility through honesty |
| 3:45–4:00 | Slide 7 | Close | One line to remember |

## Slide copy

### 1 — Title

**STEADY · CARE-HOME FALL TRIAGE**

*81% of care-home falls are unwitnessed.*

Steady shortens the wait between a fall and a person at the bedside.

Mayes et al., JAMDA 2026 · 212 falls

### 2 — Problem

**The fall is survivable. The wait is what kills.**

- ½ of people who lay on the floor over an hour died within 6 months (1981 cohort, 20 long lies)
- 30% of fallers over 90 lay there an hour or more
- 80% could not get up unaided
- The call alarms existed; they were not used

Wild et al. 1981 · Fleming & Brayne 2008

### 3 — What exists today, measured

| Approach | What the data says | Gap it leaves |
| --- | --- | --- |
| Pendant / PERS button | 24% never wear it; only 14% wear it 24 h a day; 83% of lone fallers who lay >5 min never pressed it | Needs a conscious press |
| Bed-exit / pressure alarms | >80% of bed-exit alerts are false; one sensor trial: 31% false positives, PPV 68% | Noise, not priority |
| Nurse-call & clinical alarms | 72–99% false; 74–99% non-actionable | Staff delay or disable them |
| Consumer watch | Real-world accuracy below lab accuracy; nightly charging and wear adherence | Must be worn every night |
| Camera / radar | Works, but bedroom surveillance and no staff workflow | Privacy and consent |
| Wi-Fi RTLS | 98% room accuracy achievable — with calibration and infrastructure | Calibration cost |

*Every one of these solves detection. None of them solves response.*

(If the slide is crowded, keep the first three rows: they are the direct competitors.)

### 4 — What is unique

| Today | Steady |
| --- | --- |
| 83% of lone fallers never pressed the alarm | **No press:** falls detected on-device; **45 s of stillness** raises the top tier by itself |
| 72–99% of alarms false, so staff delay or disable them | **One ranked queue**, not another siren: three tiers for eight residents at 3 a.m. |
| An acknowledgement is treated as "handled" | **A press cannot close a fall:** `acknowledged_at` and `handled_at` are separate columns; only staff "Mark checked" closes it |
| Paper round sheets, no proof of a visit | **NFC tap at the bedside** stamps tag ID and time into the same record as the fall |
### 5 — How it runs

- **IMU** — $3 accelerometer, sampled at **200 Hz**
- **MCU** — fall detected on the device; detection keeps working if Wi-Fi drops
- **Relay** — the Linux side streams WebSocket telemetry, posts **1 s summaries**, falls, acks and tag taps
- **Server** — urgency computed in SQL; one dashboard serves the whole wing
- **Databricks** — `workspace.steady`: `residents`, `devices`, `pairings`, `readings`, `alerts`, `app_settings`; every reading and alert is a Delta row; urgency comes from window functions over recent movement
- **Location** — three presses → 5 Wi-Fi scans → fingerprint matched to a room (room-level, existing APs, no anchors, no cameras)
- **NFC** — `T,<tag>` from the relay → `POST /api/acks {kind:'nfc', tag}` → recorded as `NFC tag 1B80` with a timestamp

### 6 — Viability

**Real today (verified):** the board, fall detection, the Wi-Fi path, the button, the
three tiers, the local store, the NFC path, the schema.

**Simulated, and labelled:** heart rate, battery, and the other seven residents.

**Not done yet:** clinical validation; the Databricks path against a live warehouse;
the board-side Wi-Fi scan inside the App Lab container.

### 7 — Close

*Steady does not stop falls. It makes sure a fall is never waiting for a button press
— and that someone can prove they arrived.*

## Spoken script (~490 words)

**[0:00]** "At 3 a.m. in a care home, a 91-year-old falls in her room. **81% of
care-home falls are unwitnessed**, and 83% happen in the resident's own room. She is
not found in a minute. She is found when someone does rounds."

**[0:20]** "The fall is often survivable. The wait is what kills. In the classic
long-lie cohort, **half the people who lay on the floor over an hour died within six
months**. Among people over 90, **30% of fallers lay there an hour or more**, and
**80% could not get up unaided**. They had call alarms. The alarms were not used."

**[0:42]** "So we measured what exists. Pendant alarms: **24% of users never wear the
button**, and **83% of lone fallers never pressed it**. Bed-exit alarms: **more than
80% of alerts are false**. Clinical alarms across the board: **72 to 99% false**, so
staff learn to delay or disable them. Watches must be worn and charged. Cameras work,
but nobody wants one in a bedroom. Every one of these solves detection. None of them
solves response."

**[1:10 — demo]** "This is a real UNO Q and a $3 accelerometer, and the fall
detection runs on the board. Evelyn fell two minutes ago and has not moved since —
top tier, computed from the sensor stream, not a script. [press] Now she presses I'm
OK. Watch: the fall moves *down* the list, but it does not disappear. A person who
just hit their head can press a button. Pressing changes priority, not the need for a
visit. [click] Staff pressing Mark checked is the only thing that closes it. Three
tiers: fell and stopped moving is highest, fell with no response next, fell and
pressed lowest."

**[2:05]** "Four things follow from that. One: no press is needed — stillness
escalates by itself after 45 seconds. Two: staff get a ranked queue instead of another
siren, which is what makes eight residents triageable at 3 a.m. Three: acknowledgement
and resolution are different columns, so a press cannot erase a visit. Four: a staff
NFC tap stamps the bedside — tag ID and time, in the same record as the fall."

**[2:40]** "Under the hood: 200 Hz on the board, a Wi-Fi relay posting one-second
summaries, and every reading and alert written to **Databricks** — residents, devices,
pairings, readings, alerts. Urgency is a SQL window function over recent movement, so
the rule that decides who is critical is auditable, and the monthly quality report
becomes a query instead of a paper trail. Press three times anywhere, and the wearable
scans Wi-Fi and matches the fingerprint to a room — room-level, using the building's
existing access points, no anchors, no cameras."

**[3:20]** "What is real: the board, detection, the Wi-Fi path, the button, the tiers,
the NFC path, the schema. What is simulated is labelled: heart rate, battery, the
other residents. What is next: label real falls, measure false positives, and run the
Databricks path against a live warehouse."

**[3:45]** "Steady does not stop falls. It makes sure a fall is never waiting for a
button press — and that someone can prove they arrived."

## Demo choreography

The 45-second stillness rule makes a real-time demo awkward, so stage the state
before you walk on.

### Before the slot

1. Pair the board to a resident and confirm the dashboard shows live accelerometer values.
2. Drop the device deliberately **2–3 minutes before you present**. The fall raises as
   `urgent`, then flips to `critical` on its own after 45 s with no movement.
3. Leave the Alerts page open, zoomed so the badge is readable from the back of the room.
4. Have a second resident's demo stream running so the wing looks alive.
5. Silence notifications; close unrelated tabs; check the laptop is on the same Wi-Fi as the board.

### On stage

1. Show the critical row: badge reads *No movement since the fall*. Say it is computed
   from the sensor stream, not scripted.
2. Press the physical button. The row drops to the lowest tier and **stays** in "Needs a
   response". Deliver the head-injury line, then pause.
3. Click **Mark checked**. The row moves to "Handled tonight".
4. If there is time, point at the check/battery alert rows: they are simulated and
   labelled as such.

### If the board fails

Run `npm run sim:device -- --fall-every 45` against the local server, say plainly "this
is the simulator, same server code", and keep the same three beats. A pre-recorded
40-second screen capture is the last resort.

### Pre-flight

- Board powered and paired; relay answering on `:8765`
- Backend on `:8787` running the current commit
- Browser zoom at 125–150%; alerts visible without scrolling
- One fall pre-staged at least 60 s before the demo block
## Comparison evidence (the facts behind slide 3)

| Approach | Measured failure | Source |
| --- | --- | --- |
| PERS pendant | 24% never wear the button; only 14% wear it 24 h a day; after a fall, 83% of subscribers who fell alone and lay >5 min never activated it (n=52) | Heinbüchner et al. 2010 |
| Bed-exit alarms | More than 80% of bed-exit alerts were false in a large hospital study; a separate 31-patient trial reported 31% false positives with 100% sensitivity and PPV 68% | Wen et al. 2024; Chen et al. 2017 |
| Clinical alarms | 72–99% of alarms false; 74–99% non-actionable; documented desensitisation, delay and disabling | Sendelbach & Funk 2013; review 2014 |
| Consumer watch | Real-world accuracy is lower than lab accuracy; body-worn adherence is an acknowledged barrier | Chaudhuri et al. 2015 |
| Camera / radar | Detects falls but puts a camera in a bedroom; consent and staffing workflow unsolved | — |
| Commercial RTLS | Best-in-class Wi-Fi fingerprinting reached 1.21 m point / 98% room accuracy — but needs calibration and infrastructure; proximity solutions are cheaper and need none | van Haute et al. 2016 |
| Long lies generally | 82% of falls happened while alone; 80% of fallers could not get up; 30% lay ≥1 h; call alarms "were not used in most cases" | Fleming & Brayne 2008 |

## Databricks workflow

1. **Store selection.** With `DATABRICKS_HOST` and `DATABRICKS_WAREHOUSE_ID` set, the
   server uses the Databricks store; unset, it uses a local JSON store behind the same
   interface. Same routes, same dashboard.
2. **Auth without a committed secret.** The server asks the Databricks CLI for a token
   (`databricks auth token --host ...`). Credentials stay in the CLI profile; nothing is
   committed to the repo.
3. **Schema on boot.** `CREATE SCHEMA IF NOT EXISTS workspace.steady`, then six tables:
   `residents`, `devices`, `pairings`, `readings`, `alerts`, `app_settings`. Existing
   tables get `ALTER TABLE ... ADD COLUMNS` for `handled_by` and
   `acknowledged_at/acknowledged_by`, so upgrades need no migration script.
4. **Idempotent seed.** Only when `residents` is empty: insert the eight residents and
   their simulated devices. Re-running never duplicates.
5. **Writes.** One-second summaries into `readings` (movement 0–100, gyro °/s, accel g,
   heart rate, battery, RSSI); falls into `alerts` with `uuid()` generated in a `SELECT`
   because Databricks will not allow it inside `VALUES`; device firmware and the
   simulated/device mode via `MERGE`.
6. **Reads.** The wing view takes the latest reading per resident and the newest pairing
   with `QUALIFY row_number() OVER (PARTITION BY ...)`, then computes movement since the
   fall — that is where the top tier comes from.
7. **Staff actions are `UPDATE`s** on `alerts`: `acknowledged_at/by` for a press or tag
   tap, `handled_at/by` for Mark checked. The two never touch the same column.

**Honest limit:** the Databricks path compiles and is wired, but with no warehouse
available here every demo run used the local store.

## NFC and location: what to claim

### NFC

**Safe to claim:** the protocol carries tag taps (`T,<tag>`); the relay forwards them;
the API accepts `kind:'nfc'` with a tag; the alert history records `NFC tag 1B80` with
a timestamp; a PN532 on the same I2C bus is supported by the relay.

**Do not overclaim:** no reader is fitted, so taps in the demo are generated
(`dummy_nfc_every_s`), and a tag tap currently follows the same acknowledgement path as
"I'm OK". The next step is separating *staff visit* from *wearer ack*, so a carer's tap
proves presence instead of lowering urgency.

### Location

**Safe to claim:** three presses trigger survey mode; five scans at 1.5 s build a
fingerprint; the Worker stores it in D1 and matches with mean absolute RSSI distance
over shared access points, requiring at least two in common; it returns room, floor and
confidence; the device receives a line such as `L,103,1,82` and the dashboard shows the
placement. The matcher has tests.

**Do not overclaim:** it is room-level, not a position. The App Lab container currently
cannot run `nmcli`/`iw`, so the board-side scan fails there while the matcher itself is
exercised in the Worker. If asked for a live scan, show the recorded fingerprint path
rather than pretending.

**Comparison to quote:** Wi-Fi fingerprinting reached 98% room accuracy in a hospital
evaluation — with calibration. Steady's claim is the cheaper version: existing access
points, no anchors, plus NFC where you need proof of a person rather than a position.
## Where this lives in the repo

| Piece | File |
| --- | --- |
| Three-tier urgency, fall/ack handling | `server/local.ts` (`urgencyOf`, `acknowledgeDevice`), `server/state.ts` |
| Databricks schema and SQL | `server/schema.ts`, `server/databricks.ts`, `server/state.ts` |
| Fall detection thresholds | `server/local.ts`, `src/data/alerts.ts` |
| NFC tap handling | `hardware/steady_unoq/python/main.py`, `server/index.ts`, `src/pages/Settings.tsx` |
| Wi-Fi survey and room matching | `web/` (Worker + D1), the relay's `wifi_scan` module |
| Device protocol | `src/hardware/protocol.ts`, `README.md` |
| Fall detection on the MCU | `hardware/steady_unoq/sketch/sketch.ino` |

## Thresholds to quote

| Setting | Value | Meaning |
| --- | --- | --- |
| `MOVING` | 15 / 100 | A reading at or above this counts as movement |
| `FALL_STILL_SEC` | 45 s | Stillness after a fall before the top tier |
| `REALERT_AFTER_MIN` | 10 min | Re-alert interval |
| Sample rate | 200 Hz | On the MCU |
| Summary cadence | 1 s | Relay → server |
| Survey | 5 scans × 1.5 s | One room fingerprint |
| Room match | ≥2 shared APs | Minimum for a placement |

## Sources

1. WHO. *Falls.* Fact sheet, 21 October 2026. https://www.who.int/news-room/fact-sheets/detail/falls
2. CDC. *Nonfatal and Fatal Falls Among Adults Aged ≥65 Years — United States, 2020–2021.* MMWR 2023;72(35):938–943. https://www.cdc.gov/mmwr/volumes/72/wr/mm7235a1.htm
3. CDC. *Facts About Older Adult Falls.* 2026. https://www.cdc.gov/falls/data-research/facts-stats/index.html
4. Mayes KD et al. *Evaluating Emergency Department Transfers for Falls in Skilled Nursing Facilities.* JAMDA 2026;27(3):106072. https://pubmed.ncbi.nlm.nih.gov/41494640
5. Wild D, Nayak US, Isaacs B. *How dangerous are falls in old people at home?* BMJ 1981;282:266–268. https://pubmed.ncbi.nlm.nih.gov/6779979
6. Fleming J, Brayne C. *Inability to get up after falling, subsequent time on floor, and summoning help.* BMJ 2008;337:a2227. https://pubmed.ncbi.nlm.nih.gov/19015185
7. Guerbaai RA et al. *Identifying Appropriate Nursing Home Resources to Reduce Fall-Related Emergency Department Transfers.* JAMDA 2022. https://www.jamda.com/article/S1525-8610(22)00103-7/fulltext
8. Heinbüchner B et al. *Satisfaction and use of personal emergency response systems.* Z Gerontol Geriatr 2010;43(4):219–223. https://pubmed.ncbi.nlm.nih.gov/20814795
9. Wen et al. *Large Quasi-Experimental Study on Fall Prevention.* JMIR 2024. https://www.jmir.org/2024/1/e58380/
10. Chen et al. *The Effectiveness of a Wireless Modular Bed Absence Sensor Device for Fall Prevention among Older Inpatients.* Front Public Health 2017. https://pmc.ncbi.nlm.nih.gov/articles/PMC5220104
11. Sendelbach S, Funk M. *Alarm fatigue: a patient safety concern.* AACN Adv Crit Care 2013;24(4):378–386. https://pubmed.ncbi.nlm.nih.gov/24153215
12. *Systematic review of physiologic monitor alarm characteristics and pragmatic interventions to reduce alarm frequency.* 2014. https://pmc.ncbi.nlm.nih.gov/articles/PMC4778561
13. van Haute T et al. *Performance analysis of multiple Indoor Positioning Systems in a healthcare environment.* Int J Health Geogr 2016;15:7. https://pmc.ncbi.nlm.nih.gov/articles/PMC4740986
14. Chaudhuri S et al. *Real-World Accuracy and Use of a Wearable Fall Detection Device by Older Adults.* J Am Geriatr Soc 2015. https://pmc.ncbi.nlm.nih.gov/articles/PMC4662041

## Accuracy guardrails

- The 24% / 83% figures come from a **52-person study of community-dwelling pendant
  users**, not care-home residents. Say "pendant users".
- "More than 80% of bed-exit alerts false" is one 2024 study's figure; do not present it
  as a universal constant.
- Wild 1981 is small: **125 fallers, 20 long lies**. Say "in that cohort, half".
- Fleming 2008 studied **people over 90**, in homes and care homes — not a care-home sample.
- Do not claim fall-detection accuracy, lives saved, or a deployed pilot. There is no
  clinical validation and no measured false-positive rate yet.
- Do not say the NFC tap closes or resolves a fall; it does not yet.
- Do not say location works on the board; it does not inside the App Lab container.
- Databricks: "implemented and typechecked, not yet run against a warehouse" is the accurate phrase.
