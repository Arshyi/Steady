// Connects to a Steady wearable over Wi-Fi (the UNO Q relay), or a built-in demo device.
// Both give the same events, so the Settings page doesn't care which one is used.

import type { MotionSample } from './protocol'

export type Transport = 'wifi' | 'simulated'

export interface DeviceEvents {
  onInfo: (id: string, firmware: string) => void
  onBattery: (percent: number) => void
  onMotion: (sample: MotionSample) => void
  onFall: () => void
  onDisconnect: () => void
}

export interface Connection {
  transport: Transport
  identify: () => Promise<void>
  disconnect: () => Promise<void>
}

/** Parse one text line from the device (format in protocol.ts) */
function handleLine(line: string, ev: DeviceEvents) {
  const parts = line.split(',')
  switch (parts[0]) {
    case 'I':
      if (parts.length >= 3) ev.onInfo(parts[1], parts[2])
      break
    case 'B':
      ev.onBattery(Number(parts[1]))
      break
    case 'M': {
      const [ax, ay, az, gx, gy, gz] = parts.slice(1).map(Number)
      if ([ax, ay, az, gx, gy, gz].every(Number.isFinite)) ev.onMotion({ t: performance.now(), ax, ay, az, gx, gy, gz })
      break
    }
    case 'F':
      ev.onFall()
      break
  }
}

// ---------- Wi-Fi (UNO Q relay) ----------

/** Port the relay on the board listens on for the Settings page */
export const WIFI_PORT = 8765

/**
 * Connects to the relay running on the board's Linux side over a WebSocket.
 * It speaks the text lines in protocol.ts: I, B, M, F in; "I?" and "I" out.
 */
export async function connectWifi(address: string, ev: DeviceEvents): Promise<Connection> {
  const host = address.trim().replace(/\/+$/, '')
  const url = /^wss?:\/\//.test(host) ? host : `ws://${host}${/:\d+$/.test(host) ? '' : `:${WIFI_PORT}`}`

  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`No answer from ${url}. Check the board is on and on the same Wi-Fi.`))
    }, 5000)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`Couldn't connect to ${url}. Check the address and that the relay is running.`))
    }
  })

  ws.onmessage = (e) => {
    for (const line of String(e.data).split('\n')) handleLine(line.trim(), ev)
  }
  ws.onclose = () => ev.onDisconnect()
  ws.send('I?\n')

  return {
    transport: 'wifi',
    identify: async () => ws.send('I\n'),
    disconnect: async () => ws.close(),
  }
}

// ---------- Simulator, for trying the page without hardware ----------

export async function connectSimulated(ev: DeviceEvents): Promise<Connection> {
  ev.onInfo('ST-SIM1', '1.4.2')
  ev.onBattery(87)
  const start = performance.now()

  const timer = setInterval(() => {
    const t = performance.now()
    const s = (t - start) / 1000
    // A wrist at rest that sways gently, with a bigger turn every few seconds
    const turn = Math.max(0, Math.sin(s * 0.9)) ** 3
    const noise = () => (Math.random() - 0.5) * 0.02
    ev.onMotion({
      t,
      ax: 0.02 + noise(),
      ay: -0.01 + noise(),
      az: 1 + noise(),
      gx: 25 * Math.sin(s * 1.7) + 140 * turn * Math.sin(s * 5) + noise() * 200,
      gy: 15 * Math.cos(s * 1.3) + 90 * turn * Math.cos(s * 4) + noise() * 200,
      gz: 10 * Math.sin(s * 0.7) + noise() * 200,
    })
  }, 20) // 50 samples a second, like the sketch

  // Simulated fall after 8 seconds so the fall check can pass
  const fallTimer = setTimeout(ev.onFall, 8000)

  return {
    transport: 'simulated',
    identify: async () => {},
    disconnect: async () => {
      clearInterval(timer)
      clearTimeout(fallTimer)
      ev.onDisconnect()
    },
  }
}
