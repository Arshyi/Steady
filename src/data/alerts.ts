export type AlertKind = 'fall' | 'check' | 'battery' | 'signal'

/** How fast an open fall needs someone. Every tier still needs a visit. */
export type Urgency = 'critical' | 'urgent' | 'watch'

export interface Alert {
  id: string
  residentId: string
  kind: AlertKind
  raisedAt: string // ISO
  detail: string
  /** Set when a staff member has dealt with it (ISO) */
  handledAt: string | null
  /** Who cleared it, when it wasn't the dashboard */
  handledBy?: string | null
  /** When the wearer pressed "I'm OK". The alert stays open. */
  acknowledgedAt?: string | null
  acknowledgedBy?: string | null
  /** Falls only: no movement since, not acknowledged, or acknowledged */
  urgency?: Urgency | null
}

export const urgencyLabel: Record<Urgency, string> = {
  critical: 'No movement since the fall',
  urgent: 'Not acknowledged yet',
  watch: 'Says they’re OK',
}

/** 0 is the most urgent; alerts that are not falls come last */
export const urgencyRank = (a: Alert) => (a.urgency === 'critical' ? 0 : a.urgency === 'urgent' ? 1 : a.urgency === 'watch' ? 2 : 3)

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
  acknowledgedAt: null,
  urgency: 'critical',
}
