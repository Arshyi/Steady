import type { Connection } from './connection'

/** Owns a Settings diagnostic connection, including one still opening on navigation. */
export function createConnectionSession() {
  let generation = 0
  let current: Connection | undefined

  function close() {
    generation++
    const connected = current
    current = undefined
    void connected?.disconnect()
  }

  return {
    close,
    begin() {
      close()
      const attempt = generation
      const isCurrent = () => attempt === generation
      return {
        isCurrent,
        guard<Args extends unknown[]>(callback: (...args: Args) => void) {
          return (...args: Args) => { if (isCurrent()) callback(...args) }
        },
        async attach(connected: Connection) {
          if (!isCurrent()) {
            await connected.disconnect()
            return false
          }
          current = connected
          return true
        },
        disconnected() { if (isCurrent()) current = undefined },
      }
    },
  }
}
