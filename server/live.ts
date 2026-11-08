// The last few seconds of raw motion each wearable sent, kept in memory only, for the
// live gyroscope graph on a resident's page. Databricks gets the one-second summaries.
//
// Samples arrive once a second as [t, ax, ay, az, gx, gy, gz], with t in the device's own
// milliseconds. They're placed on the server clock, ending at the moment they arrived.

export interface LiveSample {
  t: number // ms, server clock
  ax: number
  ay: number
  az: number
  gx: number
  gy: number
  gz: number
}

const KEEP_MS = 15_000
const MAX_PER_DEVICE = 1500
const buffers = new Map<string, LiveSample[]>()

export function addSamples(deviceId: string, raw: unknown) {
  if (!Array.isArray(raw) || raw.length === 0) return
  const rows = raw
    .filter((s): s is number[] => Array.isArray(s) && s.length === 7 && s.every((v) => typeof v === 'number' && Number.isFinite(v)))
    .slice(-MAX_PER_DEVICE)
  if (!rows.length) return
  const now = Date.now()
  const lastDeviceT = rows[rows.length - 1][0]
  const buffer = buffers.get(deviceId) ?? []
  const newest = buffer.length ? buffer[buffer.length - 1].t : 0
  for (const [t, ax, ay, az, gx, gy, gz] of rows) {
    const at = now - (lastDeviceT - t)
    if (at > newest) buffer.push({ t: at, ax, ay, az, gx, gy, gz })
  }
  const cutoff = now - KEEP_MS
  while (buffer.length && (buffer[0].t < cutoff || buffer.length > MAX_PER_DEVICE)) buffer.shift()
  buffers.set(deviceId, buffer)
}

export function recentSamples(deviceId: string): LiveSample[] {
  const cutoff = Date.now() - KEEP_MS
  return (buffers.get(deviceId) ?? []).filter((s) => s.t >= cutoff)
}
