// The Databricks-free store. Picked automatically when DATABRICKS_HOST and
// DATABRICKS_WAREHOUSE_ID are not set, so the dashboard, the ingest endpoint and
// the device simulator all run on one machine with nothing else installed.
//
// Readings and alerts live in memory; the parts worth keeping between runs
// (data mode, pairings, firmware versions) are written to server/.data/local.json.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { listSeen, touchDevice } from './devices.ts'
import { residentSeeds } from './residents.ts'
import type {
  AckResult, AlertKind, AlertView, DeviceInfo, DeviceReading, Mode, ResidentView, State, Status, Urgency,
} from './types.ts'

const DATA_DIR = new URL('./.data/', import.meta.url)
const DATA_FILE = new URL('./.data/local.json', import.meta.url)

const REFRESH_MS = 4000
const WINDOW_HOURS = 4
const KEEP_HOURS = 6
const HISTORY_MIN = WINDOW_HOURS * 60

// Thresholds that turn readings into a status. Kept in step with state.ts.
const MOVING = 15
const UP_WITHIN_MIN = 5
const RESTLESS_AVG = 40
const OFFLINE_AFTER_SEC = 120
const LOW_BATTERY = 20
const WEAK_RSSI = -80
const REALERT_AFTER_MIN = 10 // after an alert is handled, wait this long before raising the same one again
const FALL_STILL_SEC = 45 // a fall with no movement at all for this long is the top tier

const SIM_EVERY_MS = 5000
const DEMO_EVERY_MS = 3000

// Demo mode for the Arduino accelerometer branch: one real sensor, everything
// else made up. Off by default, because live mode only shows residents with a real
// paired wearable; DEMO_FILL=1 turns it back on.
const DEMO_FILL = process.env.DEMO_FILL === '1'
const virtualDevice = (row: { room: string }) => `DEMO-${row.room}`

type Source = 'device' | 'simulated'

interface Reading {
  ts: string
  residentId: string
  deviceId: string
  source: Source
  movement: number
  gyroDps: number | null
  accelG: number | null
  heartRate: number | null
  battery: number | null
  rssi: number | null
  /** True for the demo fill stream, which must not count as the resident moving */
  demo?: boolean
}

interface Profile {
  pattern: 'asleep' | 'up' | 'restless'
  hrBase: number
  battery: number
  rssi: number
}

// How each resident behaves tonight, matching the Databricks simulator.
const profiles: Record<string, Profile> = {
  '1': { pattern: 'asleep', hrBase: 60, battery: 78, rssi: -58 },
  '2': { pattern: 'up', hrBase: 62, battery: 66, rssi: -61 },
  '3': { pattern: 'asleep', hrBase: 63, battery: 60, rssi: -63 },
  '4': { pattern: 'asleep', hrBase: 57, battery: 43, rssi: -72 },
  '5': { pattern: 'restless', hrBase: 66, battery: 85, rssi: -57 },
  '6': { pattern: 'asleep', hrBase: 61, battery: 71, rssi: -84 },
  '7': { pattern: 'up', hrBase: 62, battery: 93, rssi: -55 },
  '8': { pattern: 'asleep', hrBase: 58, battery: 11, rssi: -60 },
}

let mode: Mode = 'simulated'
let pairings = new Map<string, { deviceId: string; firmware: string | null }>()
let readings: Reading[] = []
let alerts: LocalAlert[] = []
let fallen = new Set<string>()
let state: State = { mode, updatedAt: null, slots: [], residents: [], alerts: [], error: null }
let refreshTimer: NodeJS.Timeout | undefined
let simTimer: NodeJS.Timeout | undefined
let demoTimer: NodeJS.Timeout | undefined

export const getState = () => state

const rand = (min: number, max: number) => min + Math.random() * (max - min)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const iso = (ms: number) => new Date(ms).toISOString()
const minutesSince = (ts: string | null) => (ts ? (Date.now() - new Date(ts).getTime()) / 60_000 : null)
const currentSource = (): Source => (mode === 'simulated' ? 'simulated' : 'device')

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

// ---------- simulated wearables ----------

function movementAt(p: Profile, minutesBeforeNow: number, isFallen: boolean): number {
  if (isFallen) return rand(0, 3) // lying still after a fall
  const settling = minutesBeforeNow > HISTORY_MIN - 30 ? 25 : 0
  let m = rand(0, 6) + settling
  if (p.pattern === 'up' && minutesBeforeNow < 20) m = rand(15, 40)
  if (p.pattern === 'restless' && minutesBeforeNow < 25) m = rand(40, 85)
  return clamp(m, 0, 100)
}

function simulated(row: { id: string; simDevice: string }, at: number, movement: number, opts: { fallen?: boolean; impact?: boolean } = {}): Reading {
  const p = profiles[row.id]
  const hoursIn = (at - (Date.now() - HISTORY_MIN * 60_000)) / 3600_000
  return {
    ts: iso(at),
    residentId: row.id,
    deviceId: row.simDevice,
    source: 'simulated',
    movement: Math.round(movement * 10) / 10,
    gyroDps: Math.round((movement * 2 + rand(0, 4)) * 10) / 10,
    accelG: Math.round((opts.impact ? rand(2.8, 3.4) : 1 + rand(-0.03, 0.03)) * 1000) / 1000,
    heartRate: Math.round(opts.fallen ? rand(92, 99) : p.hrBase + movement * 0.3 + rand(-3, 3)),
    battery: Math.max(1, Math.round(p.battery - hoursIn * 0.5)),
    rssi: p.rssi + Math.round(rand(-2, 2)),
  }
}

/** Four hours of history plus tonight's story, so a fresh install isn't an empty screen. */
function backfill() {
  const recent = readings.some((r) => r.source === 'simulated' && Date.now() - new Date(r.ts).getTime() < 15 * 60_000)
  if (recent) return false

  const now = Date.now()
  for (const row of residentSeeds) {
    const p = profiles[row.id]
    for (let min = HISTORY_MIN; min >= 1; min--) {
      const isDorothy = row.id === '3'
      const fell = isDorothy && min <= 2
      const impact = isDorothy && min === 3
      readings.push(simulated(row, now - min * 60_000, impact ? 92 : movementAt(p, min, fell), { fallen: fell, impact }))
    }
  }
  seedAlerts()
  return true
}

function seedAlerts() {
  if (alerts.length) return
  const ago = (min: number) => iso(Date.now() - min * 60_000)
  const make = (residentId: string, kind: AlertKind, min: number, detail: string, handledMin?: number, by?: string): LocalAlert => ({
    id: randomUUID(),
    residentId,
    kind,
    raisedAt: ago(min),
    detail,
    handledAt: handledMin === undefined ? null : ago(handledMin),
    handledBy: by ?? null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    source: 'simulated',
  })
  alerts.push(
    make('3', 'fall', 3, 'Sudden drop, no movement since'),
    make('2', 'check', 150, 'Up for 15 min', 143, 'Night staff'),
    make('4', 'signal', 110, 'Device stopped syncing for 4 min', 102, 'Night staff'),
    make('7', 'check', 200, 'Restless for 25 min', 192, 'Night staff'),
  )
}

function simTick() {
  const now = Date.now()
  for (const row of residentSeeds) {
    const p = profiles[row.id]
    const isFallen = fallen.has(row.id)
    readings.push(simulated(row, now, movementAt(p, 0, isFallen), { fallen: isFallen }))
  }
}

function startSimulator() {
  if (simTimer) return
  simTimer = setInterval(() => {
    try {
      simTick()
    } catch (e) {
      console.error('[local sim]', (e as Error).message)
    }
  }, SIM_EVERY_MS)
}

function stopSimulator() {
  if (simTimer) clearInterval(simTimer)
  simTimer = undefined
}

/**
 * Device mode with demo fill: residents not currently sending real readings get
 * a dummy stream, so the wing still looks populated around the real sensor.
 */
function demoTick() {
  if (!DEMO_FILL || mode !== 'device') return
  const now = Date.now()
  for (const row of residentSeeds) {
    const recent = readings.some(
      (r) => r.source === 'device' && r.residentId === row.id && now - new Date(r.ts).getTime() < 5000,
    )
    if (recent) continue
    const deviceId = pairings.get(row.id)?.deviceId ?? virtualDevice(row)
    const reading = simulated({ id: row.id, simDevice: deviceId }, now, movementAt(profiles[row.id], 0, fallen.has(row.id)), {
      fallen: fallen.has(row.id),
    })
    // The fill is not the resident moving: urgency must only trust real readings
    readings.push({ ...reading, source: 'device', demo: true })
  }
}

function startDemo() {
  if (!DEMO_FILL || demoTimer) return
  demoTimer = setInterval(() => {
    try {
      demoTick()
    } catch (e) {
      console.error('[local demo]', (e as Error).message)
    }
  }, DEMO_EVERY_MS)
}

function stopDemo() {
  if (demoTimer) clearInterval(demoTimer)
  demoTimer = undefined
}

// ---------- status ----------

function refresh() {
  const source = currentSource()
  const windowStart = Date.now() - WINDOW_HOURS * 3600_000
  const recent = readings.filter((r) => r.source === source && new Date(r.ts).getTime() >= windowStart)

  const byResident = new Map<string, Reading[]>()
  for (const r of recent) {
    const list = byResident.get(r.residentId)
    if (list) list.push(r)
    else byResident.set(r.residentId, [r])
  }

  const slots = makeSlots()
  const slotIndex = new Map(slots.map((s, i) => [s, i]))
  const movementBy = new Map<string, (number | null)[]>()
  const sums = new Map<string, Map<number, { sum: number; n: number }>>()
  for (const r of recent) {
    const i = slotIndex.get(new Date(Math.floor(new Date(r.ts).getTime() / 1800_000) * 1800_000).toISOString())
    if (i === undefined) continue
    let perSlot = sums.get(r.residentId)
    if (!perSlot) {
      perSlot = new Map()
      sums.set(r.residentId, perSlot)
    }
    const acc = perSlot.get(i) ?? { sum: 0, n: 0 }
    acc.sum += r.movement
    acc.n += 1
    perSlot.set(i, acc)
  }
  for (const [id, perSlot] of sums) {
    const row = slots.map(() => null as number | null)
    for (const [i, acc] of perSlot) row[i] = Math.round((acc.sum / acc.n) * 10) / 10
    movementBy.set(id, row)
  }

  // Simulated and device alerts stay apart, the same way Databricks filters them by source
  const visible = alerts.filter((a) => a.source === source)
  const open = visible.filter((a) => !a.handledAt)
  const openFalls = new Set(open.filter((a) => a.kind === 'fall').map((a) => a.residentId))

  const views: ResidentView[] = residentSeeds.map((row) => {
    const list = byResident.get(row.id) ?? []
    const latest = list.reduce<Reading | null>((best, r) => (!best || r.ts > best.ts ? r : best), null)
    const pairing = mode === 'device' ? pairings.get(row.id) : undefined
    const demoFill = DEMO_FILL && mode === 'device'
    const deviceId = mode === 'simulated' ? row.simDevice : pairing?.deviceId ?? (demoFill ? virtualDevice(row) : null)

    const lastSyncSec = latest ? Math.max(0, Math.round((Date.now() - new Date(latest.ts).getTime()) / 1000)) : null
    const moved = list.filter((r) => r.movement >= MOVING).map((r) => r.ts).sort()
    const sinceMoved = minutesSince(moved.at(-1) ?? null)

    const twenty = list.filter((r) => Date.now() - new Date(r.ts).getTime() <= 20 * 60_000)
    const avg20 = twenty.length ? twenty.reduce((s, r) => s + r.movement, 0) / twenty.length : null

    let status: Status
    let note: string | null = null
    if (openFalls.has(row.id)) status = 'fall'
    else if (!deviceId || lastSyncSec === null || lastSyncSec > OFFLINE_AFTER_SEC) status = 'offline'
    else if (avg20 !== null && avg20 > RESTLESS_AVG && twenty.length >= 3) {
      status = 'check'
      note = 'Restless for the last 20 min'
    } else if (sinceMoved !== null && sinceMoved < UP_WITHIN_MIN) status = 'up'
    else status = 'asleep'

    const rates = list.map((r) => r.heartRate).filter((v): v is number => v !== null)

    // Dummy vitals so a real accelerometer does not leave the rest of the row blank
    const profile = profiles[row.id]
    const heartRate = latest?.heartRate ?? (demoFill ? Math.round(profile.hrBase + rand(-2, 2)) : null)
    const battery = latest?.battery ?? (demoFill ? Math.max(1, profile.battery - 2) : null)
    const rssi = latest?.rssi ?? (demoFill ? profile.rssi : null)

    return {
      id: row.id,
      name: row.name,
      room: row.room,
      status,
      note,
      lastMovementMin: sinceMoved === null ? null : Math.floor(sinceMoved),
      heartRate,
      heartRateRange: rates.length
        ? [Math.min(...rates), Math.max(...rates)]
        : heartRate !== null
          ? [heartRate - 4, heartRate + 7]
          : null,
      device: deviceId
        ? {
            id: deviceId,
            firmware: mode === 'simulated' ? row.simFirmware : pairing?.firmware ?? null,
            battery,
            signal: signalOf(rssi),
            rssi,
            lastSyncSec,
            wornSince: list.length ? list.reduce((a, b) => (a.ts < b.ts ? a : b)).ts : null,
          }
        : null,
      movement: movementBy.get(row.id) ?? slots.map(() => null),
    }
  })

  // One open alert per resident and kind
  const hasOpen = (residentId: string, kind: AlertKind) => open.some((a) => a.residentId === residentId && a.kind === kind)
  const raise = (residentId: string, kind: AlertKind, detail: string) => {
    if (hasOpen(residentId, kind)) return
    const handledRecently = visible.some(
      (a) => a.residentId === residentId && a.kind === kind && a.handledAt && minutesSince(a.handledAt)! < REALERT_AFTER_MIN,
    )
    if (handledRecently) return
    const alert: LocalAlert = {
      id: randomUUID(), residentId, kind, raisedAt: iso(Date.now()), detail,
      handledAt: null, handledBy: null, acknowledgedAt: null, acknowledgedBy: null, source,
    }
    alerts.push(alert)
    open.push(alert)
  }
  for (const v of views) {
    if (v.status === 'check') raise(v.id, 'check', v.note ?? 'Unusual movement')
    if (v.device?.battery != null && v.device.battery < LOW_BATTERY) raise(v.id, 'battery', `Device at ${v.device.battery}%`)
    if (v.device?.rssi != null && v.device.rssi < WEAK_RSSI) raise(v.id, 'signal', `Signal ${v.device.rssi} dBm`)
    if (mode === 'device' && v.device && v.status === 'offline' && v.device.lastSyncSec !== null)
      raise(v.id, 'signal', `No data for ${Math.round(v.device.lastSyncSec / 60)} min`)
  }

  state = {
    mode,
    updatedAt: iso(Date.now()),
    slots,
    residents: views,
    alerts: [...visible].map((a) => alertView(a, Date.now())).sort((a, b) => b.raisedAt.localeCompare(a.raisedAt)),
    error: null,
  }
}

/** Movement after the fall is what separates lying still from getting up again */
function movedSince(a: LocalAlert, since: number): boolean {
  return readings.some(
    (r) =>
      !r.demo && r.residentId === a.residentId && r.source === a.source && new Date(r.ts).getTime() > since && r.movement >= MOVING,
  )
}

/**
 * Falls never close on their own. The tier only says how fast someone should go:
 * nobody moving since the fall outranks "hasn't pressed I'm OK", which outranks
 * "pressed I'm OK". All three still expect a member of staff to check.
 */
function urgencyOf(a: LocalAlert, now: number): Urgency | null {
  if (a.kind !== 'fall' || a.handledAt) return null
  const raised = new Date(a.raisedAt).getTime()
  if (!movedSince(a, raised) && now - raised >= FALL_STILL_SEC * 1000) return 'critical'
  return a.acknowledgedAt ? 'watch' : 'urgent'
}

function alertView(a: LocalAlert, now: number): AlertView {
  const { id, residentId, kind, raisedAt, detail, handledAt, handledBy, acknowledgedAt, acknowledgedBy } = a
  return {
    id, residentId, kind, raisedAt, detail, handledAt, handledBy, acknowledgedAt, acknowledgedBy,
    urgency: urgencyOf(a, now),
  }
}

function prune() {
  const readingCutoff = Date.now() - KEEP_HOURS * 3600_000
  readings = readings.filter((r) => new Date(r.ts).getTime() >= readingCutoff)
  const alertCutoff = Date.now() - 12 * 3600_000
  alerts = alerts.filter((a) => new Date(a.raisedAt).getTime() >= alertCutoff)
}

let running = false
function loop() {
  if (running) return
  running = true
  clearTimeout(refreshTimer)
  try {
    prune()
    refresh()
  } catch (e) {
    state = { ...state, error: (e as Error).message }
    console.error('[local]', (e as Error).message)
  }
  running = false
  refreshTimer = setTimeout(loop, REFRESH_MS)
}

/** Refresh straight away instead of waiting for the next tick */
export function refreshSoon() {
  setTimeout(loop, 50)
}

// ---------- persistence ----------

interface LocalAlert {
  id: string
  residentId: string
  kind: AlertKind
  raisedAt: string
  detail: string
  handledAt: string | null
  handledBy: string | null
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  source: Source
}

interface Stored {
  mode: Mode
  pairings: Record<string, { deviceId: string; firmware: string | null }>
}

async function load() {
  try {
    const raw: Stored = JSON.parse(await readFile(DATA_FILE, 'utf-8'))
    if (raw.mode === 'device' || raw.mode === 'simulated') mode = raw.mode
    for (const [residentId, pairing] of Object.entries(raw.pairings ?? {})) {
      if (pairing?.deviceId) pairings.set(residentId, { deviceId: pairing.deviceId, firmware: pairing.firmware ?? null })
    }
  } catch {
    // First run: start on simulated data with no pairings.
  }
}

async function save() {
  try {
    await mkdir(DATA_DIR, { recursive: true })
    const stored: Stored = { mode, pairings: Object.fromEntries(pairings) }
    await writeFile(DATA_FILE, JSON.stringify(stored, null, 2))
  } catch (e) {
    console.error('[local] cannot save:', (e as Error).message)
  }
}

// ---------- interface ----------

export async function start() {
  await load()
  state = { ...state, mode }
  if (mode === 'simulated') {
    if (backfill()) console.log('[local] wrote tonight’s simulated history')
    startSimulator()
  } else startDemo()
  loop()
  console.log(`[local] data source: ${DATA_FILE.pathname}`)
}

export async function setMode(next: Mode) {
  if (next === mode) return
  mode = next
  await save()
  state = { ...state, mode: next, residents: [], alerts: [], slots: [], updatedAt: null }
  if (next === 'simulated') {
    backfill()
    startSimulator()
    stopDemo()
  } else {
    stopSimulator()
    startDemo()
    fallen = new Set()
  }
  refreshSoon()
}

export async function handleAlert(id: string, handled: boolean, by: string | null = null) {
  const alert = alerts.find((a) => a.id === id)
  if (alert) {
    alert.handledAt = handled ? iso(Date.now()) : null
    alert.handledBy = handled ? by : null
  }
  refreshSoon()
}

export async function pairDevice(residentId: string, deviceId: string, firmware: string | null) {
  if (!residentSeeds.some((r) => r.id === residentId)) throw new Error('Unknown resident')
  for (const [id, pairing] of pairings) if (pairing.deviceId === deviceId && id !== residentId) pairings.delete(id)
  pairings.set(residentId, { deviceId, firmware })
  touchDevice(deviceId, firmware)
  await save()
  refreshSoon()
}

function residentForDevice(deviceId: string): string | null {
  for (const [residentId, pairing] of pairings) if (pairing.deviceId === deviceId) return residentId
  return null
}

export async function ingestReadings(list: DeviceReading[]) {
  let accepted = 0
  for (const r of list) {
    const residentId = residentForDevice(r.deviceId)
    if (!residentId) continue
    touchDevice(r.deviceId, null)
    readings.push({
      ts: r.ts ?? iso(Date.now()),
      residentId,
      deviceId: r.deviceId,
      source: 'device',
      movement: r.movement,
      gyroDps: r.gyroDps ?? null,
      accelG: r.accelG ?? null,
      heartRate: r.heartRate ?? null,
      battery: r.battery ?? null,
      rssi: r.rssi ?? null,
    })
    accepted += 1
  }
  if (accepted) refreshSoon()
  return accepted
}

/** Who responded, in words the dashboard shows next to the alert */
function ackLabel(kind: 'ok' | 'nfc', tag: string | null) {
  if (kind === 'ok') return "I'm OK button"
  return tag ? `NFC tag ${tag.slice(-4)}` : 'NFC tag'
}

export async function acknowledgeDevice(deviceId: string, kind: 'ok' | 'nfc', tag: string | null): Promise<AckResult | null> {
  const residentId = residentForDevice(deviceId)
  if (!residentId) return null
  const by = ackLabel(kind, tag)
  const newest = alerts
    .filter((a) => a.residentId === residentId && a.kind === 'fall' && !a.handledAt && a.source === currentSource())
    .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt))[0]
  // A tag tap is a worker proving they are at the bedside, so it resolves the fall.
  if (kind === 'nfc') {
    if (newest) await handleAlert(newest.id, true, by)
    return { residentId, alertId: newest?.id ?? null, acknowledgedBy: by, handled: Boolean(newest) }
  }

  if (newest) {
    newest.acknowledgedAt = iso(Date.now())
    newest.acknowledgedBy = by
    refreshSoon()
  }
  return { residentId, alertId: newest?.id ?? null, acknowledgedBy: by, handled: false }
}

export async function reportFall(deviceId: string, detail = 'Fall detected by the device') {
  const residentId = residentForDevice(deviceId)
  if (!residentId) return false
  alerts.push({
    id: randomUUID(), residentId, kind: 'fall', raisedAt: iso(Date.now()), detail,
    handledAt: null, handledBy: null, acknowledgedAt: null, acknowledgedBy: null, source: 'device',
  })
  refreshSoon()
  return true
}

export function listDevices(): DeviceInfo[] {
  const paired = new Map<string, DeviceInfo['pairedTo']>()
  for (const [residentId, pairing] of pairings) {
    const row = residentSeeds.find((r) => r.id === residentId)
    if (row) paired.set(pairing.deviceId, { residentId, name: row.name, room: row.room })
  }
  return listSeen().map((d) => ({ ...d, pairedTo: paired.get(d.id) ?? null }))
}

/** Make a resident fall right now (for demos) */
export async function simulateFall(residentId: string) {
  const row = residentSeeds.find((r) => r.id === residentId)
  if (!row) throw new Error('Unknown resident')
  readings.push(simulated(row, Date.now(), 95, { impact: true }))
  alerts.push({
    id: randomUUID(),
    residentId,
    kind: 'fall',
    raisedAt: iso(Date.now()),
    detail: 'Sudden drop, no movement since',
    handledAt: null,
    handledBy: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    source: 'simulated',
  })
  fallen.add(residentId)
  refreshSoon()
}
