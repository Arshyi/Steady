import { createContext, useContext, useState, type ReactNode } from 'react'
import { seedAlerts, type Alert } from './data/alerts'

interface AlertsState {
  alerts: Alert[]
  active: Alert[]
  handle: (id: string) => void
  undo: (id: string) => void
}

const AlertsContext = createContext<AlertsState | null>(null)

function clockNow() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Shares alert state so Overview, Alerts and the sidebar count stay in sync */
export function AlertsProvider({ children }: { children: ReactNode }) {
  const [alerts, setAlerts] = useState(seedAlerts)

  const handle = (id: string) =>
    setAlerts((list) => list.map((a) => (a.id === id ? { ...a, handledAt: clockNow() } : a)))
  const undo = (id: string) =>
    setAlerts((list) => list.map((a) => (a.id === id ? { ...a, handledAt: undefined } : a)))

  const active = alerts.filter((a) => !a.handledAt)

  return <AlertsContext.Provider value={{ alerts, active, handle, undo }}>{children}</AlertsContext.Provider>
}

export function useAlerts() {
  const ctx = useContext(AlertsContext)
  if (!ctx) throw new Error('useAlerts must be used inside AlertsProvider')
  return ctx
}
