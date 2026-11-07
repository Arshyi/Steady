import { useState } from 'react'

// Which device each resident wears. For now this is saved in this browser only.
// Once there's a backend, save it there so every screen in the home sees the same pairing.

const KEY = 'steady.pairings'

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function usePairings() {
  const [pairings, setPairings] = useState(load)

  const pair = (residentId: string, deviceId: string) => {
    // A device can only be on one resident, so drop any old pairing for it
    const next = Object.fromEntries(Object.entries(pairings).filter(([, d]) => d !== deviceId))
    next[residentId] = deviceId
    setPairings(next)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // storage blocked; pairing lasts until the page reloads
    }
  }

  return { pairings, pair }
}
