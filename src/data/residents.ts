// Types shared by every screen, plus a small fixed sample used only by the landing page preview.
// Live data comes from Databricks through the backend (see src/live.tsx and server/).

export type ResidentStatus = 'fall' | 'check' | 'up' | 'asleep' | 'offline'
export type Signal = 'good' | 'fair' | 'weak'

export interface Device {
  id: string
  firmware: string | null
  battery: number | null // percent
  signal: Signal | null
  rssi: number | null // dBm
  lastSyncSec: number | null
  wornSince: string | null // ISO time of the first reading tonight
}

export interface Resident {
  id: string
  name: string
  room: string
  /** Added by staff for a real wearable. Only these show in live mode; the demo residents only in simulated. */
  manual?: boolean
  status: ResidentStatus
  lastMovementMin: number | null
  heartRate: number | null
  heartRateRange: [number, number] | null // lowest and highest tonight
  note?: string | null
  device: Device | null
  /** Average movement score (0–100) per half hour, matching the `slots` from the backend */
  movement: (number | null)[]
}

export const shift = {
  wing: 'Wing A',
  name: 'Night shift',
}

export const LOW_BATTERY = 20

const priority: Record<ResidentStatus, number> = { fall: 0, check: 1, up: 2, asleep: 3, offline: 4 }

/** Most urgent first, then by room number */
export function byUrgency(a: Resident, b: Resident) {
  return priority[a.status] - priority[b.status] || a.room.localeCompare(b.room)
}

export function byRoom(a: Resident, b: Resident) {
  return a.room.localeCompare(b.room)
}

export function minutesAgo(min: number | null) {
  if (min === null) return '–'
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h} hr ${m} min ago` : `${h} hr ago`
}

export function secondsAgo(sec: number | null) {
  if (sec === null) return '–'
  return sec < 60 ? `${sec} s ago` : minutesAgo(Math.floor(sec / 60))
}

/** ISO time to a 24-hour clock in the viewer's time zone, e.g. "02:13" */
export function clock(iso: string | null | undefined) {
  if (!iso) return '–'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function countByStatus(list: Resident[]) {
  const c = { fall: 0, check: 0, up: 0, asleep: 0, offline: 0 }
  for (const r of list) c[r.status]++
  return c
}

// ---------- Fixed sample for the landing page preview ----------

const dev = (id: string, battery: number): Device => ({
  id, firmware: '1.4.2', battery, signal: 'good', rssi: -60, lastSyncSec: 5, wornSince: null,
})

export const sampleResidents: Resident[] = [
  { id: '1', name: 'Margaret Ellis', room: '101', status: 'asleep', lastMovementMin: 42, heartRate: 61, heartRateRange: [56, 72], device: dev('ST-0412', 76), movement: [] },
  { id: '2', name: 'Harold Brooks', room: '102', status: 'up', lastMovementMin: 2, heartRate: 74, heartRateRange: [60, 81], device: dev('ST-0388', 64), movement: [] },
  { id: '3', name: 'Dorothy Kim', room: '103', status: 'fall', lastMovementMin: 1, heartRate: 98, heartRateRange: [58, 98], device: dev('ST-0419', 58), movement: [] },
  { id: '5', name: 'Evelyn Carter', room: '105', status: 'check', lastMovementMin: 6, heartRate: 88, heartRateRange: [63, 91], note: 'Restless for the last 20 min', device: dev('ST-0402', 83), movement: [] },
  { id: '7', name: 'Ruth Patel', room: '107', status: 'up', lastMovementMin: 4, heartRate: 70, heartRateRange: [59, 77], device: dev('ST-0407', 91), movement: [] },
]
