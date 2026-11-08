// Live data from Databricks, via the backend in server/.
// Polls /api/state every few seconds and shares it with every screen.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Resident } from './data/residents'
import type { Alert } from './data/alerts'

export type DataMode = 'simulated' | 'device'

interface ApiState {
  mode: DataMode
  updatedAt: string | null
  slots: string[]
  residents: Resident[]
  alerts: Alert[]
  error: string | null
}

interface Live extends ApiState {
  /** True until the first data arrives */
  loading: boolean
  /** Set when the backend itself can't be reached */
  offline: string | null
  active: Alert[]
  findResident: (id: string) => Resident | undefined
  handle: (alertId: string) => Promise<void>
  undo: (alertId: string) => Promise<void>
  pair: (residentId: string, deviceId: string, firmware?: string) => Promise<void>
  setMode: (mode: DataMode) => Promise<void>
  simulateFall: (residentId: string) => Promise<void>
}

const POLL_MS = 3000
const empty: ApiState = { mode: 'simulated', updatedAt: null, slots: [], residents: [], alerts: [], error: null }
const LiveContext = createContext<Live | null>(null)

export async function post(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Request failed (${res.status})`)
  return res.json()
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<ApiState>(empty)
  const [offline, setOffline] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const load = useCallback(async () => {
    clearTimeout(timer.current)
    try {
      const res = await fetch('/api/state')
      if (!res.ok) throw new Error(`Backend returned ${res.status}`)
      const next: ApiState = await res.json()
      setData(next)
      setOffline(null)
      if (next.updatedAt) setLoaded(true)
    } catch {
      setOffline('Can’t reach the Steady server. Is `npm run dev` running?')
    }
    timer.current = setTimeout(load, POLL_MS)
  }, [])

  useEffect(() => {
    load()
    return () => clearTimeout(timer.current)
  }, [load])

  // Show a change straight away, then confirm with the server
  const patchAlert = (id: string, handledAt: string | null) =>
    setData((d) => ({ ...d, alerts: d.alerts.map((a) => (a.id === id ? { ...a, handledAt } : a)) }))

  const value: Live = {
    ...data,
    loading: !loaded,
    offline,
    active: data.alerts.filter((a) => !a.handledAt),
    findResident: (id) => data.residents.find((r) => r.id === id),
    handle: async (id) => {
      patchAlert(id, new Date().toISOString())
      await post(`/api/alerts/${id}/handle`)
      load()
    },
    undo: async (id) => {
      patchAlert(id, null)
      await post(`/api/alerts/${id}/undo`)
      load()
    },
    pair: async (residentId, deviceId, firmware) => {
      await post('/api/pairings', { residentId, deviceId, firmware })
      load()
    },
    setMode: async (mode) => {
      setLoaded(false)
      setData((d) => ({ ...d, mode, residents: [], alerts: [], updatedAt: null }))
      await post('/api/mode', { mode })
      load()
    },
    simulateFall: async (residentId) => {
      await post('/api/simulate/fall', { residentId })
      load()
    },
  }

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

export function useLive() {
  const ctx = useContext(LiveContext)
  if (!ctx) throw new Error('useLive must be used inside LiveProvider')
  return ctx
}
