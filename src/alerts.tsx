import { createContext, useContext, useState, type ReactNode } from 'react'
import { seedAlerts, type Alert } from './data/alerts'

interface AlertsState {
  alerts: Alert[]
  active: Alert[]
  /** `handledBy` names who cleared it when it wasn't the dashboard (I'm OK, NFC tap) */
  handle: (id: string, handledBy?: string) => void
  undo: (id: string) => void
}

const AlertsContext = createContext<AlertsState | null>(null)

function clockNow() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Shares alert state so Overview, Alerts and the sidebar count stay in sync */
export function AlertsProvider({ children }: { children: ReactNode }) {
  const [alerts, setAlerts] = useState(seedAlerts)

  // Already-handled alerts are left alone: a late tap should not rewrite who cleared what.
  const handle = (id: string, handledBy?: string) =>
    setAlerts((list) =>
      list.map((a) => (a.id === id && !a.handledAt ? { ...a, handledAt: clockNow(), handledBy } : a)),
    )
  const undo = (id: string) =>
    setAlerts((list) => list.map((a) => (a.id === id ? { ...a, handledAt: undefined, handledBy: undefined } : a)))

  const active = alerts.filter((a) => !a.handledAt)

  return <AlertsContext.Provider value={{ alerts, active, handle, undo }}>{children}</AlertsContext.Provider>
}

export function useAlerts() {
  const ctx = useContext(AlertsContext)
  if (!ctx) throw new Error('useAlerts must be used inside AlertsProvider')
  return ctx
}
