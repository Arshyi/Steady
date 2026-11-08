// Simulated wearables: writes gyroscope/accelerometer summaries for every resident into Databricks.
// Used when the data source is set to "simulated" in Settings.

import { sql, lit, SCHEMA } from './databricks.ts'
import { residentSeeds, insertAlerts } from './schema.ts'

const HISTORY_HOURS = 4
const LIVE_EVERY_MS = 5000

type Pattern = 'asleep' | 'up' | 'restless'

interface Profile {
  pattern: Pattern
  hrBase: number
  battery: number // percent at the start of the history
  rssi: number
}

// How each resident behaves tonight. Keyed by resident_id.
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

const rand = (min: number, max: number) => min + Math.random() * (max - min)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Movement score 0-100 for a resident at `minutesBeforeNow`, given the whole history window */
function movementAt(p: Profile, minutesBeforeNow: number, fallen: boolean): number {
  if (fallen) return rand(0, 3) // lying still after a fall
  const settling = minutesBeforeNow > HISTORY_HOURS * 60 - 30 ? 25 : 0 // everyone moves more early in the night
  let m = rand(0, 6) + settling
  if (p.pattern === 'up' && minutesBeforeNow < 20) m = rand(15, 40)
  if (p.pattern === 'restless' && minutesBeforeNow < 25) m = rand(40, 85)
  return clamp(m, 0, 100)
}

function row(residentId: string, deviceId: string, at: Date, movement: number, p: Profile, opts: { fallen?: boolean; impact?: boolean } = {}) {
  const hoursIn = (at.getTime() - (Date.now() - HISTORY_HOURS * 3600_000)) / 3600_000
  const battery = Math.max(1, Math.round(p.battery - hoursIn * 0.5))
  const hr = Math.round(opts.fallen ? rand(92, 99) : p.hrBase + movement * 0.3 + rand(-3, 3))
  const accel = opts.impact ? rand(2.8, 3.4) : 1 + rand(-0.03, 0.03)
  return `(${lit(at.toISOString())}, ${lit(residentId)}, ${lit(deviceId)}, 'simulated', ${movement.toFixed(1)}, ${(movement * 2 + rand(0, 4)).toFixed(1)}, ${accel.toFixed(3)}, ${hr}, ${battery}, ${p.rssi + Math.round(rand(-2, 2))})`
}

async function insertRows(rows: string[]) {
  for (let i = 0; i < rows.length; i += 1000) {
    await sql(`INSERT INTO ${SCHEMA}.readings (ts, resident_id, device_id, source, movement, gyro_dps, accel_g, heart_rate, battery, rssi)
      VALUES ${rows.slice(i, i + 1000).join(', ')}`)
  }
}

/**
 * If there's no recent simulated data, write the last few hours of history (one reading a minute)
 * plus a fall for Dorothy and a few alerts staff already handled, so the dashboard has a story.
 */
export async function backfillIfNeeded() {
  const [{ n }] = await sql(
    `SELECT count(*) AS n FROM ${SCHEMA}.readings WHERE source = 'simulated' AND ts > current_timestamp() - INTERVAL 15 MINUTES`,
  )
  if (Number(n) > 0) {
    await seedAlertsIfNeeded()
    return false
  }

  const now = Date.now()
  const rows: string[] = []
  for (const r of residentSeeds) {
    const p = profiles[r.id]
    for (let min = HISTORY_HOURS * 60; min >= 1; min--) {
      const isDorothy = r.id === '3'
      const fallen = isDorothy && min <= 2
      const impact = isDorothy && min === 3
      const m = impact ? 92 : movementAt(p, min, fallen)
      rows.push(row(r.id, r.simDevice, new Date(now - min * 60_000), m, p, { fallen, impact }))
    }
  }
  await insertRows(rows)
  await seedAlertsIfNeeded()
  return true
}

/** A fall for Dorothy plus a few alerts staff already handled earlier tonight */
async function seedAlertsIfNeeded() {
  const [{ n }] = await sql(
    `SELECT count(*) AS n FROM ${SCHEMA}.alerts WHERE source = 'simulated' AND raised_at > current_timestamp() - INTERVAL 12 HOURS`,
  )
  if (Number(n) > 0) return
  const ago = (min: number) => `current_timestamp() - INTERVAL ${min} MINUTES`
  await insertAlerts([
    `('3', 'fall', ${ago(3)}, 'Sudden drop, no movement since', NULL, 'simulated')`,
    `('2', 'check', ${ago(150)}, 'Up for 15 min', ${ago(143)}, 'simulated')`,
    `('4', 'signal', ${ago(110)}, 'Device stopped syncing for 4 min', ${ago(102)}, 'simulated')`,
    `('7', 'check', ${ago(200)}, 'Restless for 25 min', ${ago(192)}, 'simulated')`,
  ])
}

/** Residents with an open simulated fall alert lie still until it's handled */
let fallen = new Set<string>()
export function setFallen(ids: Set<string>) {
  fallen = ids
}

let timer: NodeJS.Timeout | undefined

async function tick() {
  const now = new Date()
  const rows = residentSeeds.map((r) => {
    const p = profiles[r.id]
    // Live data continues the "now" end of the history
    return row(r.id, r.simDevice, now, movementAt(p, 0, fallen.has(r.id)), p, { fallen: fallen.has(r.id) })
  })
  await insertRows(rows)
}

export function startSimulator() {
  if (timer) return
  const loop = async () => {
    try {
      await tick()
    } catch (e) {
      console.error('[simulator]', (e as Error).message)
    }
    timer = setTimeout(loop, LIVE_EVERY_MS)
  }
  timer = setTimeout(loop, 0)
}

export function stopSimulator() {
  if (timer) clearTimeout(timer)
  timer = undefined
}

/** Make a resident fall right now (for demos) */
export async function simulateFall(residentId: string) {
  const r = residentSeeds.find((x) => x.id === residentId)
  if (!r) throw new Error('Unknown resident')
  const p = profiles[r.id]
  await insertRows([row(r.id, r.simDevice, new Date(), 95, p, { impact: true })])
  await insertAlerts([`(${lit(residentId)}, 'fall', current_timestamp(), 'Sudden drop, no movement since', NULL, 'simulated')`])
  fallen.add(residentId)
}
