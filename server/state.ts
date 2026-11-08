// Reads Databricks every few seconds, works out each resident's status, raises alerts,
// and keeps the result in memory so the web app can poll it cheaply.

import { sql, lit, SCHEMA, type Row } from './databricks.ts'
import { loadMode, saveMode, insertAlerts, type Mode } from './schema.ts'
import { startSimulator, stopSimulator, setFallen, backfillIfNeeded } from './simulator.ts'
import { createBatchWriter } from './batch-writer.ts'

const REFRESH_MS = 4000
const WINDOW_HOURS = 4

// Thresholds that turn readings into a status. Tune these with real data.
const MOVING = 15 // movement score that counts as "moving"
const UP_WITHIN_MIN = 5 // moved in the last 5 min -> "up"
const RESTLESS_AVG = 40 // average movement over 20 min above this -> "needs a check"
const OFFLINE_AFTER_SEC = 120 // no reading for 2 min -> "no data"
const LOW_BATTERY = 20
const WEAK_RSSI = -80

export type Status = 'fall' | 'check' | 'up' | 'asleep' | 'offline'
export type AlertKind = 'fall' | 'check' | 'battery' | 'signal'

export interface ResidentView {
  id: string
  name: string
  room: string
  status: Status
  note: string | null
  lastMovementMin: number | null
  heartRate: number | null
  heartRateRange: [number, number] | null
  device: {
    id: string
    firmware: string | null
    battery: number | null
    signal: 'good' | 'fair' | 'weak' | null
    rssi: number | null
    lastSyncSec: number | null
    wornSince: string | null
  } | null
  movement: (number | null)[]
}

export interface AlertView {
  id: string
  residentId: string
  kind: AlertKind
  raisedAt: string
  detail: string
  handledAt: string | null
  /** Set when the wearable cleared it: "I'm OK button", "NFC tag 1B80" */
  handledBy: string | null
}

export interface State {
  mode: Mode
  updatedAt: string | null
  slots: string[]
  residents: ResidentView[]
  alerts: AlertView[]
  error: string | null
}

let state: State = { mode: 'simulated', updatedAt: null, slots: [], residents: [], alerts: [], error: null }
export const getState = () => state

const num = (v: Row[string]) => (v === null || v === undefined ? null : Number(v))
const str = (v: Row[string]) => (v === null || v === undefined ? null : String(v))
const minutesSince = (iso: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / 60_000 : null)

function signalOf(rssi: number | null) {
  if (rssi === null) return null
  return rssi < WEAK_RSSI ? 'weak' : rssi < -70 ? 'fair' : 'good'
}

/** Half-hour slots covering the window, oldest first */
function makeSlots(): string[] {
  const step = 30 * 60_000
  const last = Math.floor(Date.now() / step) * step
  return Array.from({ length: WINDOW_HOURS * 2 + 1 }, (_, i) => new Date(last - (WINDOW_HOURS * 2 - i) * step).toISOString())
}

async function refresh() {
  const source = state.mode

  const [residents, movement, alerts] = await Promise.all([
    sql(
      `WITH win AS (
         SELECT * FROM ${SCHEMA}.readings WHERE source = :source AND ts > current_timestamp() - INTERVAL ${WINDOW_HOURS} HOURS),
       latest AS (
         SELECT * FROM win QUALIFY row_number() OVER (PARTITION BY resident_id ORDER BY ts DESC) = 1),
       stats AS (
         SELECT resident_id,
                max(CASE WHEN movement >= ${MOVING} THEN ts END) AS last_moved,
                min(ts) AS first_seen,
                min(heart_rate) AS hr_min, max(heart_rate) AS hr_max,
                avg(CASE WHEN ts > current_timestamp() - INTERVAL 20 MINUTES THEN movement END) AS avg20,
                count(CASE WHEN ts > current_timestamp() - INTERVAL 20 MINUTES THEN 1 END) AS n20
         FROM win GROUP BY resident_id),
       paired AS (
         SELECT * FROM ${SCHEMA}.pairings QUALIFY row_number() OVER (PARTITION BY resident_id ORDER BY paired_at DESC) = 1)
       SELECT r.resident_id, r.name, r.room,
              CASE WHEN :source = 'simulated' THEN r.sim_device_id ELSE p.device_id END AS device_id,
              l.ts AS last_ts, l.heart_rate, l.battery, l.rssi,
              s.last_moved, s.first_seen, s.hr_min, s.hr_max, s.avg20, s.n20, d.firmware
       FROM ${SCHEMA}.residents r
       LEFT JOIN latest l ON l.resident_id = r.resident_id
       LEFT JOIN stats s ON s.resident_id = r.resident_id
       LEFT JOIN paired p ON p.resident_id = r.resident_id
       LEFT JOIN ${SCHEMA}.devices d
         ON d.device_id = CASE WHEN :source = 'simulated' THEN r.sim_device_id ELSE p.device_id END
       ORDER BY r.room`,
      { source },
    ),
    sql(
      `SELECT resident_id,
              timestamp_seconds(floor(unix_timestamp(ts) / 1800) * 1800) AS slot,
              round(avg(movement), 1) AS movement
       FROM ${SCHEMA}.readings
       WHERE source = :source AND ts > current_timestamp() - INTERVAL ${WINDOW_HOURS} HOURS
       GROUP BY ALL`,
      { source },
    ),
    sql(
      `SELECT alert_id, resident_id, kind, raised_at, detail, handled_at, handled_by FROM ${SCHEMA}.alerts
       WHERE source = :source AND (handled_at IS NULL OR raised_at > current_timestamp() - INTERVAL 12 HOURS)
       ORDER BY raised_at DESC`,
      { source },
    ),
  ])

  const alertViews: AlertView[] = alerts.map((a) => ({
    id: String(a.alert_id),
    residentId: String(a.resident_id),
    kind: a.kind as AlertKind,
    raisedAt: new Date(String(a.raised_at)).toISOString(),
    detail: String(a.detail ?? ''),
    handledAt: a.handled_at ? new Date(String(a.handled_at)).toISOString() : null,
    handledBy: str(a.handled_by),
  }))
  const open = alertViews.filter((a) => !a.handledAt)
  const openFalls = new Set(open.filter((a) => a.kind === 'fall').map((a) => a.residentId))
  setFallen(openFalls)

  const slots = makeSlots()
  const slotIndex = new Map(slots.map((s, i) => [s, i]))
  const movementBy = new Map<string, (number | null)[]>()
  for (const m of movement) {
    const id = String(m.resident_id)
    const i = slotIndex.get(new Date(String(m.slot)).toISOString())
    if (i === undefined) continue
    if (!movementBy.has(id)) movementBy.set(id, slots.map(() => null))
    movementBy.get(id)![i] = num(m.movement)
  }

  const views: ResidentView[] = residents.map((r) => {
    const id = String(r.resident_id)
    const lastTs = str(r.last_ts)
    const lastSyncSec = lastTs ? Math.max(0, Math.round((Date.now() - new Date(lastTs).getTime()) / 1000)) : null
    const sinceMoved = minutesSince(str(r.last_moved))
    const avg20 = num(r.avg20)
    const deviceId = str(r.device_id)

    let status: Status
    let note: string | null = null
    if (openFalls.has(id)) status = 'fall'
    else if (lastSyncSec === null || lastSyncSec > OFFLINE_AFTER_SEC) status = 'offline'
    else if (avg20 !== null && avg20 > RESTLESS_AVG && (num(r.n20) ?? 0) >= 3) {
      status = 'check'
      note = 'Restless for the last 20 min'
    } else if (sinceMoved !== null && sinceMoved < UP_WITHIN_MIN) status = 'up'
    else status = 'asleep'

    const rssi = num(r.rssi)
    return {
      id,
      name: String(r.name),
      room: String(r.room),
      status,
      note,
      lastMovementMin: sinceMoved === null ? null : Math.floor(sinceMoved),
      heartRate: num(r.heart_rate),
      heartRateRange: r.hr_min !== null && r.hr_max !== null ? [Number(r.hr_min), Number(r.hr_max)] : null,
      device: deviceId
        ? {
            id: deviceId,
            firmware: str(r.firmware),
            battery: num(r.battery),
            signal: signalOf(rssi),
            rssi,
            lastSyncSec,
            wornSince: str(r.first_seen),
          }
        : null,
      movement: movementBy.get(id) ?? slots.map(() => null),
    }
  })

  // Raise alerts for new problems (one open alert per resident and kind)
  const hasOpen = (rid: string, kind: AlertKind) => open.some((a) => a.residentId === rid && a.kind === kind)
  const newAlerts: string[] = []
  const raise = (rid: string, kind: AlertKind, detail: string) => {
    if (!hasOpen(rid, kind))
      newAlerts.push(`(${lit(rid)}, ${lit(kind)}, current_timestamp(), ${lit(detail)}, NULL, ${lit(source)}, NULL)`)
  }
  for (const v of views) {
    if (v.status === 'check') raise(v.id, 'check', v.note ?? 'Unusual movement')
    if (v.device?.battery !== null && v.device?.battery !== undefined && v.device.battery < LOW_BATTERY)
      raise(v.id, 'battery', `Device at ${v.device.battery}%`)
    if (v.device?.rssi !== null && v.device?.rssi !== undefined && v.device.rssi < WEAK_RSSI)
      raise(v.id, 'signal', `Signal ${v.device.rssi} dBm`)
    if (source === 'device' && v.device && v.status === 'offline' && v.device.lastSyncSec !== null)
      raise(v.id, 'signal', `No data for ${Math.round(v.device.lastSyncSec / 60)} min`)
  }
  await insertAlerts(newAlerts)

  // Ignore results if the mode changed while we were reading
  if (source !== state.mode) return
  state = { ...state, updatedAt: new Date().toISOString(), slots, residents: views, alerts: alertViews, error: null }
  if (newAlerts.length) refreshSoon()
}

let refreshTimer: NodeJS.Timeout | undefined
let running = false

async function loop() {
  if (running) return
  running = true
  clearTimeout(refreshTimer)
  try {
    await refresh()
  } catch (e) {
    state = { ...state, error: (e as Error).message }
    console.error('[refresh]', (e as Error).message)
  }
  running = false
  refreshTimer = setTimeout(loop, REFRESH_MS)
}

/** Refresh straight away instead of waiting for the next tick */
export function refreshSoon() {
  setTimeout(loop, 50)
}

export async function start() {
  state.mode = await loadMode()
  if (state.mode === 'simulated') {
    if (await backfillIfNeeded()) console.log('[simulator] wrote tonight’s history')
    startSimulator()
  }
  await loop()
}

export async function setMode(mode: Mode) {
  if (mode === state.mode) return
  await saveMode(mode)
  state = { ...state, mode, residents: [], alerts: [], slots: [], updatedAt: null }
  if (mode === 'simulated') {
    await backfillIfNeeded()
    startSimulator()
  } else stopSimulator()
  refreshSoon()
}

// ---------- Actions from the web app and devices ----------

export async function handleAlert(id: string, handled: boolean, by: string | null = null) {
  await sql(
    `UPDATE ${SCHEMA}.alerts SET handled_at = ${handled ? 'current_timestamp()' : 'NULL'},
       handled_by = ${handled ? ':by' : 'NULL'} WHERE alert_id = :id`,
    { id, by },
  )
  refreshSoon()
}

export async function pairDevice(residentId: string, deviceId: string, firmware: string | null) {
  pairingCache.clear()
  // A device can only be on one resident
  await sql(`DELETE FROM ${SCHEMA}.pairings WHERE device_id = :device OR resident_id = :resident`, {
    device: deviceId,
    resident: residentId,
  })
  await sql(`INSERT INTO ${SCHEMA}.pairings VALUES (:resident, :device, current_timestamp())`, {
    resident: residentId,
    device: deviceId,
  })
  await sql(
    `MERGE INTO ${SCHEMA}.devices t USING (SELECT :device AS device_id, :firmware AS firmware) s ON t.device_id = s.device_id
     WHEN MATCHED THEN UPDATE SET firmware = coalesce(s.firmware, t.firmware)
     WHEN NOT MATCHED THEN INSERT (device_id, firmware, kind, registered_at) VALUES (s.device_id, s.firmware, 'device', current_timestamp())`,
    { device: deviceId, firmware },
  )
  refreshSoon()
}

async function residentForDevice(deviceId: string): Promise<string | null> {
  const rows = await sql(
    `SELECT resident_id FROM ${SCHEMA}.pairings WHERE device_id = :device ORDER BY paired_at DESC LIMIT 1`,
    { device: deviceId },
  )
  return rows[0] ? String(rows[0].resident_id) : null
}

export interface DeviceReading {
  deviceId: string
  ts?: string
  movement: number
  gyroDps?: number
  accelG?: number
  heartRate?: number | null
  battery?: number | null
  rssi?: number | null
}

// Batch across requests, but only acknowledge a reading after Databricks stores it.
const writeReading = createBatchWriter<string>(async (rows) => {
  await sql(`INSERT INTO ${SCHEMA}.readings (ts, resident_id, device_id, source, movement, gyro_dps, accel_g, heart_rate, battery, rssi)
    VALUES ${rows.join(', ')}`)
})
const pairingCache = new Map<string, { residentId: string | null; at: number }>()

async function cachedResident(deviceId: string) {
  const hit = pairingCache.get(deviceId)
  if (hit && Date.now() - hit.at < 10_000) return hit.residentId
  const residentId = await residentForDevice(deviceId)
  pairingCache.set(deviceId, { residentId, at: Date.now() })
  return residentId
}

export async function ingestReadings(readings: DeviceReading[]) {
  const rows: string[] = []
  for (const r of readings) {
    const residentId = await cachedResident(r.deviceId)
    if (!residentId) continue // not paired yet
    rows.push(
      `(${lit(r.ts ?? new Date().toISOString())}, ${lit(residentId)}, ${lit(r.deviceId)}, 'device', ${lit(r.movement)}, ${lit(r.gyroDps ?? null)}, ${lit(r.accelG ?? null)}, ${lit(r.heartRate ?? null)}, ${lit(r.battery ?? null)}, ${lit(r.rssi ?? null)})`,
    )
  }
  await Promise.all(rows.map(writeReading))
  return rows.length
}

/** Who cleared an alert, in words the dashboard shows next to it */
function ackLabel(kind: 'ok' | 'nfc', tag: string | null) {
  if (kind === 'ok') return "I'm OK button"
  return tag ? `NFC tag ${tag.slice(-4)}` : 'NFC tag'
}

/**
 * The wearer pressed "I'm OK", or a staff member tapped an NFC tag on the device.
 * Clears that resident's newest open alert and records who did it, so the
 * dashboard can say "handled via I'm OK button".
 */
export async function acknowledgeDevice(deviceId: string, kind: 'ok' | 'nfc', tag: string | null) {
  pairingCache.delete(deviceId)
  const residentId = await cachedResident(deviceId)
  if (!residentId) return null

  const by = ackLabel(kind, tag)
  const rows = await sql(
    `SELECT alert_id FROM ${SCHEMA}.alerts
     WHERE resident_id = :resident AND source = 'device' AND handled_at IS NULL
     ORDER BY raised_at DESC LIMIT 1`,
    { resident: residentId },
  )
  const alertId = rows[0] ? String(rows[0].alert_id) : null
  if (alertId) await handleAlert(alertId, true, by)
  return { residentId, alertId, handledBy: by }
}

/** Fast path: a device reported a fall. Raise the alert straight away. */
export async function reportFall(deviceId: string) {
  pairingCache.delete(deviceId)
  const residentId = await cachedResident(deviceId)
  if (!residentId) return false
  await insertAlerts([`(${lit(residentId)}, 'fall', current_timestamp(), 'Fall detected by the device', NULL, 'device', NULL)`])
  refreshSoon()
  return true
}

