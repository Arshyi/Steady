// Placeholder data. Later this will come from Databricks.

export type ResidentStatus = 'fall' | 'check' | 'up' | 'asleep'
export type Signal = 'good' | 'fair' | 'weak'

export interface Device {
  id: string
  firmware: string
  battery: number // percent
  signal: Signal
  rssi: number // dBm
  lastSyncSec: number
  wornSince: string
}

export interface Resident {
  id: string
  name: string
  room: string
  status: ResidentStatus
  lastMovementMin: number
  heartRate: number
  heartRateRange: [number, number] // lowest and highest tonight
  note?: string
  device: Device
  /** Movement score 0–100 for each half hour since the shift started */
  movement: number[]
}

export const shift = {
  wing: 'Wing A',
  name: 'Night shift',
  date: 'Sat 7 Nov',
  hours: '22:00–07:00',
  updatedAt: '02:14',
}

/** Half-hour slots the movement chart covers, matching Resident.movement */
export const movementSlots = ['22:00', '22:30', '23:00', '23:30', '00:00', '00:30', '01:00', '01:30', '02:00']

export const residents: Resident[] = [
  {
    id: '1', name: 'Margaret Ellis', room: '101', status: 'asleep', lastMovementMin: 42, heartRate: 61, heartRateRange: [56, 72],
    device: { id: 'ST-0412', firmware: '1.4.2', battery: 76, signal: 'good', rssi: -58, lastSyncSec: 8, wornSince: '21:10' },
    movement: [38, 22, 9, 4, 6, 3, 2, 5, 2],
  },
  {
    id: '2', name: 'Harold Brooks', room: '102', status: 'up', lastMovementMin: 2, heartRate: 74, heartRateRange: [60, 81],
    device: { id: 'ST-0388', firmware: '1.4.2', battery: 64, signal: 'good', rssi: -61, lastSyncSec: 5, wornSince: '20:45' },
    movement: [41, 30, 12, 46, 18, 8, 6, 14, 52],
  },
  {
    id: '3', name: 'Dorothy Kim', room: '103', status: 'fall', lastMovementMin: 1, heartRate: 98, heartRateRange: [58, 98],
    device: { id: 'ST-0419', firmware: '1.4.2', battery: 58, signal: 'good', rssi: -63, lastSyncSec: 3, wornSince: '21:30' },
    movement: [26, 14, 6, 4, 3, 5, 4, 11, 88],
  },
  {
    id: '4', name: 'Walter Nguyen', room: '104', status: 'asleep', lastMovementMin: 64, heartRate: 58, heartRateRange: [54, 69],
    device: { id: 'ST-0371', firmware: '1.3.9', battery: 41, signal: 'fair', rssi: -72, lastSyncSec: 21, wornSince: '20:30' },
    movement: [18, 9, 5, 3, 2, 4, 2, 1, 1],
  },
  {
    id: '5', name: 'Evelyn Carter', room: '105', status: 'check', lastMovementMin: 6, heartRate: 88, heartRateRange: [63, 91],
    note: 'In and out of bed for 20 min',
    device: { id: 'ST-0402', firmware: '1.4.2', battery: 83, signal: 'good', rssi: -57, lastSyncSec: 4, wornSince: '21:05' },
    movement: [34, 20, 11, 8, 6, 9, 15, 47, 63],
  },
  {
    id: '6', name: 'Frank Morales', room: '106', status: 'asleep', lastMovementMin: 25, heartRate: 63, heartRateRange: [57, 74],
    device: { id: 'ST-0395', firmware: '1.4.2', battery: 69, signal: 'weak', rssi: -84, lastSyncSec: 48, wornSince: '21:20' },
    movement: [29, 17, 8, 6, 11, 5, 3, 7, 4],
  },
  {
    id: '7', name: 'Ruth Patel', room: '107', status: 'up', lastMovementMin: 4, heartRate: 70, heartRateRange: [59, 77],
    device: { id: 'ST-0407', firmware: '1.4.2', battery: 91, signal: 'good', rssi: -55, lastSyncSec: 6, wornSince: '21:00' },
    movement: [33, 24, 10, 7, 5, 4, 9, 22, 38],
  },
  {
    id: '8', name: 'George Hall', room: '108', status: 'asleep', lastMovementMin: 50, heartRate: 60, heartRateRange: [55, 68],
    device: { id: 'ST-0366', firmware: '1.3.9', battery: 9, signal: 'good', rssi: -60, lastSyncSec: 11, wornSince: '19:50' },
    movement: [22, 12, 6, 3, 4, 2, 3, 2, 3],
  },
]

export function findResident(id: string) {
  return residents.find((r) => r.id === id)
}

const priority: Record<ResidentStatus, number> = { fall: 0, check: 1, up: 2, asleep: 3 }

/** Most urgent first, then by room number */
export function byUrgency(a: Resident, b: Resident) {
  return priority[a.status] - priority[b.status] || a.room.localeCompare(b.room)
}

export function byRoom(a: Resident, b: Resident) {
  return a.room.localeCompare(b.room)
}

export function minutesAgo(min: number) {
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h} hr ${m} min ago` : `${h} hr ago`
}

export function secondsAgo(sec: number) {
  return sec < 60 ? `${sec} s ago` : minutesAgo(Math.floor(sec / 60))
}

export function countByStatus(list: Resident[]) {
  const c = { fall: 0, check: 0, up: 0, asleep: 0 }
  for (const r of list) c[r.status]++
  return c
}

export const LOW_BATTERY = 20
