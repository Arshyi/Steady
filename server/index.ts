// Steady backend. Run with `npm run dev` (starts this and the web app together).
//
//   GET  /api/state                 everything the dashboard shows
//   POST /api/mode                  { mode: 'simulated' | 'device' }
//   POST /api/alerts/:id/handle     acknowledge or mark done
//   POST /api/alerts/:id/undo
//   POST /api/pairings              { residentId, deviceId, firmware? }
//   POST /api/readings              [{ deviceId, movement, gyroDps, accelG, battery, ... }]  from devices or the relay
//   POST /api/falls                 { deviceId }  fast path for a fall
//   POST /api/simulate/fall         { residentId }  demo: make a simulated resident fall

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { setupSchema } from './schema.ts'
import { simulateFall } from './simulator.ts'
import {
  start, getState, setMode, handleAlert, pairDevice, ingestReadings, reportFall, refreshSoon, type DeviceReading,
} from './state.ts'

const PORT = Number(process.env.PORT ?? 8787)

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const text = Buffer.concat(chunks).toString()
  return text ? JSON.parse(text) : {}
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  try {
    if (req.method === 'GET' && path === '/api/state') return send(res, 200, getState())

    if (req.method === 'POST' && path === '/api/mode') {
      const { mode } = await readJson(req)
      if (mode !== 'simulated' && mode !== 'device') return send(res, 400, { error: 'mode must be simulated or device' })
      await setMode(mode)
      return send(res, 200, { mode })
    }

    const alertMatch = path.match(/^\/api\/alerts\/([\w-]+)\/(handle|undo)$/)
    if (req.method === 'POST' && alertMatch) {
      await handleAlert(alertMatch[1], alertMatch[2] === 'handle')
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && path === '/api/pairings') {
      const { residentId, deviceId, firmware } = await readJson(req)
      if (!residentId || !deviceId) return send(res, 400, { error: 'residentId and deviceId are required' })
      await pairDevice(String(residentId), String(deviceId), firmware ? String(firmware) : null)
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && path === '/api/readings') {
      const body = await readJson(req)
      const list: DeviceReading[] = Array.isArray(body) ? body : [body]
      const accepted = await ingestReadings(list.filter((r) => r && r.deviceId && Number.isFinite(r.movement)))
      return send(res, 200, { accepted })
    }

    if (req.method === 'POST' && path === '/api/falls') {
      const { deviceId } = await readJson(req)
      const ok = await reportFall(String(deviceId))
      return send(res, ok ? 200 : 409, ok ? { ok } : { error: 'Device is not paired to a resident' })
    }

    if (req.method === 'POST' && path === '/api/simulate/fall') {
      if (getState().mode !== 'simulated') return send(res, 409, { error: 'Switch to simulated data first' })
      const { residentId } = await readJson(req)
      await simulateFall(String(residentId))
      refreshSoon()
      return send(res, 200, { ok: true })
    }

    send(res, 404, { error: 'Not found' })
  } catch (e) {
    console.error(`[${req.method} ${path}]`, (e as Error).message)
    send(res, 500, { error: (e as Error).message })
  }
})

server.listen(PORT, () => console.log(`[server] http://localhost:${PORT}`))

try {
  console.log('[server] setting up Databricks tables…')
  await setupSchema()
  await start()
  console.log('[server] connected to Databricks')
} catch (e) {
  console.error('[server] Databricks setup failed:', (e as Error).message)
}
