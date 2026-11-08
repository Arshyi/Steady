// Stand-in for the relay that will run on the Arduino UNO Q's Linux side.
// Run it with `npm run relay:mock`, then in the app: Settings -> Connect over Wi-Fi -> "localhost".
//
// It does exactly what the real relay must do:
//   1. Serve a WebSocket on port 8765 for the Settings page, streaming raw samples as text lines
//      (same format as USB serial, see src/hardware/protocol.ts): I, B, M, F out; "I?" and "I" in.
//   2. Every second, POST a summary to the Steady server's /api/readings.
//   3. On a fall, send "F" to the Settings page and POST /api/falls straight away.
// Type "f" and press Enter in this terminal to simulate a fall.

import { WebSocketServer, type WebSocket } from 'ws'
import { createInterface } from 'node:readline'

const DEVICE_ID = process.env.DEVICE_ID ?? 'UNOQ-SIM'
const FIRMWARE = '1.4.2'
const PORT = Number(process.env.RELAY_PORT ?? 8765)
const SERVER = process.env.STEADY_SERVER ?? 'http://localhost:8787'

const clients = new Set<WebSocket>()
const wss = new WebSocketServer({ port: PORT })
const broadcast = (line: string) => clients.forEach((c) => c.readyState === c.OPEN && c.send(line + '\n'))

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.on('message', (data) => {
    const cmd = String(data).trim()
    if (cmd === 'I?') ws.send(`I,${DEVICE_ID},${FIRMWARE}\nB,100\n`)
    if (cmd === 'I') console.log('[relay] blink LED (identify)')
  })
})

// ---- Fake IMU at 50 Hz: a wrist that sways, with a bigger turn every few seconds ----
type Sample = { ax: number; ay: number; az: number; gx: number; gy: number; gz: number }
const window: Sample[] = []
const start = Date.now()
const noise = (n: number) => (Math.random() - 0.5) * n

setInterval(() => {
  const s = (Date.now() - start) / 1000
  const turn = Math.max(0, Math.sin(s * 0.9)) ** 3
  const m: Sample = {
    ax: 0.02 + noise(0.02),
    ay: -0.01 + noise(0.02),
    az: 1 + noise(0.02),
    gx: 25 * Math.sin(s * 1.7) + 140 * turn * Math.sin(s * 5) + noise(4),
    gy: 15 * Math.cos(s * 1.3) + 90 * turn * Math.cos(s * 4) + noise(4),
    gz: 10 * Math.sin(s * 0.7) + noise(4),
  }
  window.push(m)
  broadcast(`M,${[m.ax, m.ay, m.az, m.gx, m.gy, m.gz].map((v) => v.toFixed(3)).join(',')}`)
}, 20)

// ---- Every second, send a summary to the server ----
setInterval(async () => {
  const batch = window.splice(0)
  if (!batch.length) return
  const mean = (f: (s: Sample) => number) => batch.reduce((t, s) => t + f(s), 0) / batch.length
  const gyroDps = mean((s) => Math.hypot(s.gx, s.gy, s.gz))
  const accelG = mean((s) => Math.hypot(s.ax, s.ay, s.az))
  try {
    const res = await fetch(`${SERVER}/api/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID, movement: Math.min(100, gyroDps / 2), gyroDps, accelG }),
    })
    const { accepted } = (await res.json()) as { accepted?: number }
    if (!accepted) console.log(`[relay] server ignored the reading: pair ${DEVICE_ID} to a resident in Settings`)
  } catch {
    console.log(`[relay] can't reach the server at ${SERVER}`)
  }
}, 1000)

// ---- Type "f" + Enter to simulate a fall ----
createInterface({ input: process.stdin }).on('line', async (line) => {
  if (line.trim().toLowerCase() !== 'f') return
  broadcast('F')
  const res = await fetch(`${SERVER}/api/falls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: DEVICE_ID }),
  }).catch(() => null)
  console.log(res?.ok ? '[relay] fall sent' : '[relay] fall not accepted (is the device paired and the data source Live devices?)')
})

console.log(`[relay] ${DEVICE_ID} on ws://localhost:${PORT}, sending to ${SERVER}. Type "f" + Enter for a fall.`)
