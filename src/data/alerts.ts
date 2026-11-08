export type AlertKind = 'fall' | 'check' | 'battery' | 'signal'

export interface Alert {
  id: string
  residentId: string
  kind: AlertKind
  raisedAt: string // ISO
  detail: string
  /** Set when a staff member has dealt with it (ISO) */
  handledAt: string | null
}

export const kindLabel: Record<AlertKind, string> = {
  fall: 'Fall',
  check: 'Needs a check',
  battery: 'Low battery',
  signal: 'Weak signal',
}

/** A fixed fall for the landing page preview */
export const sampleFall: Alert = {
  id: 'sample',
  residentId: '3',
  kind: 'fall',
  raisedAt: new Date(Date.now() - 60_000).toISOString(),
  detail: 'Sudden drop, no movement since',
  handledAt: null,
}
