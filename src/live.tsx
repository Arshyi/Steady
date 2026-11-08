// Live data from Databricks, via the backend in server/.
// Polls /api/state every few seconds and shares it with every screen.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Resident } from './data/residents'
import type { Alert } from './data/alerts'
import { api, apiFetch, useAuth } from './auth'

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
  /** Every resident, including ones hidden in live mode. Only for choosing who to pair a wearable to. */
  allResidents: Resident[]
  findResident: (id: string) => Resident | undefined
  handle: (alertId: string) => Promise<void>
  undo: (alertId: string) => Promise<void>
  pair: (residentId: string, deviceId: string, firmware?: string) => Promise<void>
  /** Add a resident to pair a real wearable to; returns their id */
  addResident: (name: string, room: string) => Promise<string>
  setMode: (mode: DataMode) => Promise<void>
  simulateFall: (residentId: string) => Promise<void>
}

const POLL_MS = 3000
const empty: ApiState = { mode: 'simulated', updatedAt: null, slots: [], residents: [], alerts: [], error: null }
const LiveContext = createContext<Live | null>(null)

export const post = (path: string, body?: unknown) => api<any>(path, 'POST', body ?? {})

export function LiveProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<ApiState>(empty)
  const [offline, setOffline] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Clicks the server hasn't confirmed yet. Laid over every poll so an older reply can't undo them.
  const pending = useRef(new Map<string, { handled: boolean; at: number }>())

  const withPending = (next: ApiState): ApiState => {
    if (!pending.current.size) return next
    return {
      ...next,
      alerts: next.alerts.map((a) => {
        const p = pending.current.get(a.id)
        if (!p) return a
        // The server agrees now, or it's taking too long: stop overriding
        if (!!a.handledAt === p.handled || Date.now() - p.at > 30_000) {
          pending.current.delete(a.id)
          return a
        }
        return { ...a, handledAt: p.handled ? new Date(p.at).toISOString() : null }
      }),
    }
  }

  const load = useCallback(async () => {
    clearTimeout(timer.current)
    try {
      const res = await apiFetch('/api/state')
      if (res.status === 401 || res.status === 403) {
        setOffline((await res.json().catch(() => ({}))).error ?? 'Please log in again')
      } else {
        if (!res.ok) throw new Error(`Backend returned ${res.status}`)
        const next: ApiState = await res.json()
        setData(withPending(next))
        setOffline(null)
        if (next.updatedAt) setLoaded(true)
      }
    } catch {
      setOffline('Can’t reach the Steady server. Is `npm run dev` running?')
    }
    timer.current = setTimeout(load, POLL_MS)
  }, [])

  // Only poll once someone is signed in (always, when login is off)
  const auth = useAuth()
  const ready = auth.signedIn && !auth.loading && !auth.error
  useEffect(() => {
    if (!ready) return
    load()
    return () => clearTimeout(timer.current)
  }, [load, ready])

  // Show a change straight away, then confirm with the server
  const setAlert = async (id: string, handled: boolean) => {
    const at = Date.now()
    pending.current.set(id, { handled, at })
    const handledAt = handled ? new Date(at).toISOString() : null
    setData((d) => ({ ...d, alerts: d.alerts.map((a) => (a.id === id ? { ...a, handledAt } : a)) }))
    try {
      await post(`/api/alerts/${id}/${handled ? 'handle' : 'undo'}`)
    } catch (e) {
      // Saving failed, so show the server's version again
      console.error('Could not update alert', e)
      if (pending.current.get(id)?.at === at) pending.current.delete(id)
    }
    load()
  }

  // Only residents wearing a device show: in live mode that means a paired wearable, and
  // residents added for real wearables never show in simulated mode
  const residents = data.residents.filter((r) => r.device)

  const value: Live = {
    ...data,
    residents,
    allResidents: data.residents,
    loading: !loaded,
    offline,
    active: data.alerts.filter((a) => !a.handledAt),
    findResident: (id) => data.residents.find((r) => r.id === id),
    handle: (id) => setAlert(id, true),
    undo: (id) => setAlert(id, false),
    addResident: async (name, room) => {
      const { id } = await post('/api/residents', { name, room })
      load()
      return id as string
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
