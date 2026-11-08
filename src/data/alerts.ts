// Placeholder alerts for tonight. Later these will come from Databricks.

export type AlertKind = 'fall' | 'check' | 'battery' | 'signal'

export interface Alert {
  id: string
  residentId: string
  kind: AlertKind
  time: string // when it was raised, HH:MM
  detail: string
  /** Set when a staff member has dealt with it */
  handledAt?: string
  /** Who cleared it, when it wasn't the dashboard: "I'm OK button", "NFC tag 1B80" */
  handledBy?: string
}

export const kindLabel: Record<AlertKind, string> = {
  fall: 'Fall',
  check: 'Needs a check',
  battery: 'Low battery',
  signal: 'Weak signal',
}

export const seedAlerts: Alert[] = [
  { id: 'a1', residentId: '3', kind: 'fall', time: '02:13', detail: 'Sudden drop, no movement since' },
  { id: 'a2', residentId: '5', kind: 'check', time: '02:08', detail: 'In and out of bed for 20 min' },
  { id: 'a3', residentId: '8', kind: 'battery', time: '01:52', detail: 'Device at 9%' },
  { id: 'a4', residentId: '6', kind: 'signal', time: '01:31', detail: 'Last synced 48 s ago, signal −84 dBm' },
  { id: 'a5', residentId: '2', kind: 'check', time: '23:34', detail: 'Up for 15 min', handledAt: '23:41' },
  { id: 'a6', residentId: '4', kind: 'signal', time: '23:02', detail: 'Device stopped syncing for 4 min', handledAt: '23:10' },
  { id: 'a7', residentId: '7', kind: 'check', time: '22:47', detail: 'Restless for 25 min', handledAt: '22:55' },
]
