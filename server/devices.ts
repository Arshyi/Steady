// Devices the server has heard from since it started.
//
// The firmware posts a heartbeat every 30 s, so a wearable shows up here within
// half a minute of coming online even before anyone pairs it to a resident. The
// dashboard's Settings screen reads this list through GET /api/devices.

export interface SeenDevice {
  id: string
  firmware: string | null
  firstSeen: string
  lastSeen: string
}

const seen = new Map<string, SeenDevice>()

/** Record that `id` just talked to us. Cheap: called on every ingest batch. */
export function touchDevice(id: string, firmware: string | null) {
  const now = new Date().toISOString()
  const existing = seen.get(id)
  if (existing) {
    existing.lastSeen = now
    if (firmware) existing.firmware = firmware
    return
  }
  seen.set(id, { id, firmware, firstSeen: now, lastSeen: now })
}

/** Forget every device (demo reset); ones still sending reappear within seconds */
export function forgetDevices() {
  seen.clear()
}

/** Everything heard from, most recently seen first */
export function listSeen(): SeenDevice[] {
  return [...seen.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
}
