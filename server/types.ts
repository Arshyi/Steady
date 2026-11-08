// Types shared by the Databricks store, the local store and the HTTP layer.

export type Mode = 'simulated' | 'device'
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

/** How fast someone needs to reach an open fall. Every tier still needs a visit. */
export type Urgency = 'critical' | 'urgent' | 'watch'

export interface AlertView {
  id: string
  residentId: string
  kind: AlertKind
  raisedAt: string
  detail: string
  /** Set when staff resolved it on the dashboard. A device press never sets this. */
  handledAt: string | null
  handledBy: string | null
  /** Set when the wearer pressed "I'm OK" or tapped a tag: the alert stays open. */
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  /** Falls only: no movement since the fall, not acknowledged, or acknowledged */
  urgency: Urgency | null
}

export interface State {
  mode: Mode
  updatedAt: string | null
  slots: string[]
  residents: ResidentView[]
  alerts: AlertView[]
  error: string | null
}

/** One summarised second of motion from a device, as the dashboard understands it */
export interface DeviceReading {
  deviceId: string
  /** Optional: a relay reports the firmware it is running so the row stays current. */
  firmware?: string | null
  ts?: string
  movement: number
  gyroDps?: number
  accelG?: number
  heartRate?: number | null
  battery?: number | null
  rssi?: number | null
}

/** A wearable the server has heard from, whether or not it is paired */
export interface DeviceInfo {
  id: string
  firmware: string | null
  firstSeen: string
  lastSeen: string
  pairedTo: { residentId: string; name: string; room: string } | null
}

export interface AckResult {
  residentId: string
  /** The open fall that was downgraded, if there was one */
  alertId: string | null
  acknowledgedBy: string
}

/**
 * Everything the HTTP layer needs from a store. `state.ts` implements it on top
 * of Databricks and `local.ts` without, so the routes never care which is in use.
 */
export interface Backend {
  start(): Promise<void>
  getState(): State
  setMode(mode: Mode): Promise<void>
  handleAlert(id: string, handled: boolean, by?: string | null): Promise<void>
  pairDevice(residentId: string, deviceId: string, firmware: string | null): Promise<void>
  ingestReadings(readings: DeviceReading[]): Promise<number>
  reportFall(deviceId: string, detail?: string): Promise<boolean>
  acknowledgeDevice(deviceId: string, kind: 'ok' | 'nfc', tag: string | null): Promise<AckResult | null>
  listDevices(): DeviceInfo[]
  refreshSoon(): void
  simulateFall(residentId: string): Promise<void>
}
