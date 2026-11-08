// Steady backend. Run with `npm run dev` (starts this and the web app together).
//
//   GET  /api/state                 everything the dashboard shows
//   GET  /api/devices               wearables the server has heard from
//   POST /api/mode                  { mode: 'simulated' | 'device' }
//   POST /api/alerts/:id/handle     acknowledge or mark done
//   POST /api/alerts/:id/undo
//   POST /api/residents             { name, room? } add a resident to pair a wearable to
//   POST /api/pairings              { residentId, deviceId, firmware? }
//   GET  /api/live/:deviceId        the last 15 s of raw motion, for the live graph
//   POST /api/readings              [{ deviceId, movement, gyroDps, accelG, battery, ... }]  from devices or the relay
//   POST /api/falls                 { deviceId }  fast path for a fall
//   POST /api/acks                  { deviceId, kind }  a worker confirmed they responded
//   POST /api/simulate/fall         { residentId }  demo: make a simulated resident fall
//
//   GET  /api/accounts              public: is login / registering turned on
//   POST /api/register              public: { careHome, name, email } makes a care home and its admin
//   GET  /api/me                    the signed-in staff member
//   GET  /api/staff                 admin: everyone in the care home
//   POST /api/staff                 admin: { email, name?, role? } invite someone
//   PATCH /api/staff/:id            admin: { role }
//   DELETE /api/staff/:id           admin
//   POST /api/staff/:id/resend      admin: email the set-password link again
//
// Staff routes need an Auth0 login when it's turned on (see auth.ts). Changing the data source
// and the demo fall are admin only. Device routes (readings, falls, acks, ingest) don't use
// staff logins; the firmware has its own token.
//
//   GET  /api/demo/status           demo page, this computer only: what a reset would remove
//   POST /api/demo/reset-live       { readings? } staff-added residents, pairings, live alerts
//   POST /api/demo/reset-accounts   delete every Auth0 login
//
//   GET  /api/v1/health             liveness; says which store is in use
//   POST /api/v1/ingest             the firmware's batched uplink (bearer token)
//
// The store is Databricks when DATABRICKS_HOST and DATABRICKS_WAREHOUSE_ID are
// set, and a local file-backed store otherwise, so the whole path can be run and
// simulated on one machine.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { configured } from './databricks.ts'
import { touchDevice, forgetDevices } from './devices.ts'
import { addSamples, recentSamples } from './live.ts'
import type { Backend, DeviceReading } from './types.ts'
import {
  HttpError, authEnabled, accountsEnabled, currentStaff, requireAdmin, registerCareHome,
  listStaff, inviteStaff, setRole, removeStaff, resendInvite, listAccounts, deleteAllAccounts,
} from './auth.ts'

const PORT = Number(process.env.PORT) || 8787
const DEVICE_TOKEN = process.env.DEVICE_TOKEN ?? ''

const backend: Backend = configured ? await import('./state.ts') : await import('./local.ts')

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

// ---------- device uplink ----------

let warnedOpen = false

/**
 * The firmware sends `Authorization: Bearer <token>` from its config. With no
 * DEVICE_TOKEN set the endpoint stays open, which is what makes local demos
 * work out of the box; set one before exposing the server.
 */
function deviceAuthorised(req: IncomingMessage, url: URL) {
  if (!DEVICE_TOKEN) {
    if (!warnedOpen) {
      console.warn('[server] DEVICE_TOKEN is not set: /api/v1/ingest accepts anyone')
      warnedOpen = true
    }
    return true
  }
  const header = String(req.headers.authorization ?? '')
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  return bearer === DEVICE_TOKEN || url.searchParams.get('token') === DEVICE_TOKEN
}

interface FirmwareSample {
  ts?: number
  ax?: number
  ay?: number
  az?: number
  gx?: number
  gy?: number
  gz?: number
  svm?: number
}

interface FirmwareEvent {
  peak_g?: number
  tilt_delta?: number
  confidence?: number
}

/**
 * The device samples at 10-200 Hz; the dashboard wants one row per second. This
 * folds a batch into seconds of movement, gyro and acceleration.
 */
function summariseSamples(deviceId: string, samples: FirmwareSample[], body: any): DeviceReading[] {
  const buckets = new Map<number, FirmwareSample[]>()
  for (const s of samples) {
    if (!s || typeof s !== 'object') continue
    const ms = Number(s.ts)
    const second = Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000)
    const list = buckets.get(second)
    if (list) list.push(s)
    else buckets.set(second, [s])
  }

  const battery = Number.isFinite(Number(body?.battery)) ? Number(body.battery) : null
  const rssi = Number.isFinite(Number(body?.rssi)) ? Number(body.rssi) : null

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([second, list]) => {
      let gyro = 0
      let accel = 0
      for (const s of list) {
        gyro += Math.hypot(Number(s.gx) || 0, Number(s.gy) || 0, Number(s.gz) || 0)
        accel += Math.hypot(Number(s.ax) || 0, Number(s.ay) || 0, Number(s.az) || 0)
      }
      const gyroDps = gyro / list.length
      const accelG = accel / list.length
      return {
        deviceId,
        ts: new Date(second * 1000).toISOString(),
        movement: Math.min(100, Math.round(gyroDps * 20) / 10),
        gyroDps: Math.round(gyroDps * 10) / 10,
        accelG: Math.round(accelG * 1000) / 1000,
        battery,
        rssi,
      }
    })
}

/** "Fall detected by the device: peak 6.0 g, posture change 82°" */
function fallDetail(e: FirmwareEvent) {
  const bits: string[] = []
  const peak = Number(e.peak_g)
  if (Number.isFinite(peak) && peak > 0) bits.push(`peak ${peak.toFixed(1)} g`)
  const tilt = Number(e.tilt_delta)
  if (Number.isFinite(tilt) && Math.abs(tilt) >= 1) bits.push(`posture change ${Math.round(tilt)}°`)
  const confidence = Number(e.confidence)
  if (Number.isFinite(confidence) && confidence > 0) bits.push(`${Math.round(confidence)}% confidence`)
  return bits.length ? `Fall detected by the device: ${bits.join(', ')}` : 'Fall detected by the device'
}

// ---------- routes ----------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  try {
    // ---------- demo tools (this computer only) ----------
    // Wipe live devices or every login so pairing and sign-up can be demonstrated again.
    // Only from this machine: the Vite proxy and the browser here are loopback, a board or
    // a phone on the Wi-Fi is not. The custom header stops other websites posting here.
    if (path.startsWith('/api/demo/')) {
      const from = req.socket.remoteAddress ?? ''
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(from))
        return send(res, 403, { error: 'Demo tools only work on the computer running the server' })
      if (req.method === 'GET' && path === '/api/demo/status') {
        // Each part on its own, so a slow Databricks can't hold up the account list
        const within = <T,>(p: Promise<T>, ms: number) =>
          Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error('Databricks is slow to answer')), ms))])
        const [live, accounts] = await Promise.allSettled([
          within(backend.liveCounts(), 20_000),
          authEnabled ? listAccounts() : Promise.resolve(null),
        ])
        return send(res, 200, {
          live: live.status === 'fulfilled' ? live.value : null,
          liveError: live.status === 'rejected' ? (live.reason as Error).message : null,
          accounts: accounts.status === 'fulfilled' ? accounts.value : [],
          accountsError: accounts.status === 'rejected' ? (accounts.reason as Error).message : null,
          login: authEnabled,
          mode: backend.getState().mode,
        })
      }
      if (req.method !== 'POST' || req.headers['x-steady-demo'] !== 'reset')
        return send(res, 400, { error: 'Send a POST with the x-steady-demo: reset header' })
      if (path === '/api/demo/reset-live') {
        const { readings } = await readJson(req)
        const removed = await backend.resetLive({ readings: readings === true })
        forgetDevices()
        console.log('[demo] live devices reset', removed)
        return send(res, 200, { removed })
      }
      if (path === '/api/demo/reset-accounts') return send(res, 200, await deleteAllAccounts())
      return send(res, 404, { error: 'Not found' })
    }

    // ---------- accounts ----------

    if (req.method === 'GET' && path === '/api/accounts') return send(res, 200, { login: authEnabled, register: accountsEnabled })

    if (req.method === 'POST' && path === '/api/register') return send(res, 200, await registerCareHome(req, await readJson(req)))

    if (req.method === 'GET' && path === '/api/me') {
      const me = await currentStaff(req)
      // With login off, everyone can do everything
      return send(res, 200, me ?? { id: null, name: null, email: null, role: 'admin', careHome: null, careHomeName: null, joined: true })
    }

    if (path === '/api/staff' || path.startsWith('/api/staff/')) {
      const me = await requireAdmin(req)
      if (!me) return send(res, 409, { error: 'Staff accounts need Auth0 login turned on' })
      const [, , , id, action] = path.split('/').map(decodeURIComponent)
      if (req.method === 'GET' && !id) return send(res, 200, await listStaff(me))
      if (req.method === 'POST' && !id) return send(res, 200, await inviteStaff(me, await readJson(req)))
      if (req.method === 'PATCH' && id && !action) return send(res, 200, await setRole(me, id, await readJson(req)))
      if (req.method === 'DELETE' && id && !action) {
        await removeStaff(me, id)
        return send(res, 200, { ok: true })
      }
      if (req.method === 'POST' && id && action === 'resend') {
        await resendInvite(me, id)
        return send(res, 200, { ok: true })
      }
      return send(res, 404, { error: 'Not found' })
    }

    // ---------- dashboard ----------

    if (req.method === 'GET' && path === '/api/state') {
      await currentStaff(req)
      return send(res, 200, backend.getState())
    }

    const liveMatch = path.match(/^\/api\/live\/([\w.:-]+)$/)
    if (req.method === 'GET' && liveMatch) {
      await currentStaff(req)
      return send(res, 200, recentSamples(liveMatch[1]))
    }

    if (req.method === 'GET' && path === '/api/devices') {
      await currentStaff(req)
      return send(res, 200, backend.listDevices())
    }

    if (req.method === 'GET' && path === '/api/v1/health') {
      const state = backend.getState()
      return send(res, 200, {
        ok: true,
        store: configured ? 'databricks' : 'local',
        mode: state.mode,
        devices: backend.listDevices().length,
        time: new Date().toISOString(),
      })
    }

    if (req.method === 'POST' && path === '/api/v1/ingest') {
      if (!deviceAuthorised(req, url)) return send(res, 401, { error: 'Bad or missing device token' })
      const body = await readJson(req)
      const deviceId = String(body.device ?? req.headers['x-device-id'] ?? '')
      if (!deviceId) return send(res, 400, { error: 'device is required' })
      const firmware = body.firmware ? String(body.firmware) : null
      touchDevice(deviceId, firmware)

      const samples: FirmwareSample[] = Array.isArray(body.samples) ? body.samples : []
      const events: FirmwareEvent[] = Array.isArray(body.events) ? body.events : []
      const accepted = await backend.ingestReadings(summariseSamples(deviceId, samples, body))
      let alerts = 0
      for (const e of events) if (await backend.reportFall(deviceId, fallDetail(e))) alerts += 1
      if (samples.length || events.length) backend.refreshSoon()

      return send(res, 200, { ok: true, device: deviceId, samples: samples.length ? accepted : 0, events: alerts })
    }

    if (req.method === 'POST' && path === '/api/mode') {
      await requireAdmin(req)
      const { mode } = await readJson(req)
      if (mode !== 'simulated' && mode !== 'device') return send(res, 400, { error: 'mode must be simulated or device' })
      await backend.setMode(mode)
      return send(res, 200, { mode })
    }

    const alertMatch = path.match(/^\/api\/alerts\/([\w-]+)\/(handle|undo)$/)
    if (req.method === 'POST' && alertMatch) {
      const me = await currentStaff(req)
      const { by } = await readJson(req)
      // Signed in: record who it was. Login off: take the name the page sends, if any.
      const who = me ? me.name : by ? String(by) : null
      await backend.handleAlert(alertMatch[1], alertMatch[2] === 'handle', who)
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && path === '/api/residents') {
      await currentStaff(req)
      const { name, room } = await readJson(req)
      const cleanName = String(name ?? '').trim().slice(0, 80)
      if (!cleanName) return send(res, 400, { error: 'Enter the resident’s name' })
      const cleanRoom = String(room ?? '').trim().slice(0, 12) || null
      return send(res, 200, await backend.addResident(cleanName, cleanRoom))
    }

    if (req.method === 'POST' && path === '/api/pairings') {
      await currentStaff(req)
      const { residentId, deviceId, firmware } = await readJson(req)
      if (!residentId || !deviceId) return send(res, 400, { error: 'residentId and deviceId are required' })
      await backend.pairDevice(String(residentId), String(deviceId), firmware ? String(firmware) : null)
      return send(res, 200, { ok: true })
    }

    if (req.method === 'POST' && path === '/api/readings') {
      const body = await readJson(req)
      const list: DeviceReading[] = Array.isArray(body) ? body : [body]
      // A relay naming its firmware keeps the row honest after an OTA, instead of
      // showing whatever version first registered.
      for (const r of list) {
        if (r?.deviceId) touchDevice(String(r.deviceId), r.firmware ? String(r.firmware) : null)
        // Raw samples for the live graph stay in memory; Databricks gets the summary
        if (r?.deviceId) addSamples(String(r.deviceId), (r as { samples?: unknown }).samples)
      }
      const accepted = await backend.ingestReadings(list.filter((r) => r && r.deviceId && Number.isFinite(r.movement)))
      return send(res, 200, { accepted })
    }

    if (req.method === 'POST' && path === '/api/falls') {
      const { deviceId, detail } = await readJson(req)
      const bits: string[] = []
      if (detail && typeof detail === 'object') {
        const d = detail as Record<string, unknown>
        const peak = Number(d.peakG)
        const tilt = Number(d.tiltDelta)
        if (Number.isFinite(peak) && peak > 0) bits.push(`peak ${peak.toFixed(1)} g`)
        if (Number.isFinite(tilt) && Math.abs(tilt) >= 1) bits.push(`posture change ${Math.round(tilt)}°`)
      }
      const measured = bits.length ? `Fall detected by the device: ${bits.join(', ')}` : undefined
      const ok = await backend.reportFall(String(deviceId), measured)
      return send(res, ok ? 200 : 409, ok ? { ok } : { error: 'Device is not paired to a resident' })
    }

    if (req.method === 'POST' && path === '/api/acks') {
      const { deviceId, kind } = await readJson(req)
      if (!deviceId || kind !== 'ok') return send(res, 400, { error: 'deviceId and kind (ok) are required' })
      const result = await backend.acknowledgeDevice(String(deviceId))
      if (!result) return send(res, 409, { error: 'Device is not paired to a resident' })
      return send(res, 200, result)
    }

    if (req.method === 'POST' && path === '/api/simulate/fall') {
      await requireAdmin(req)
      if (backend.getState().mode !== 'simulated') return send(res, 409, { error: 'Switch to simulated data first' })
      const { residentId } = await readJson(req)
      await backend.simulateFall(String(residentId))
      backend.refreshSoon()
      return send(res, 200, { ok: true })
    }

    send(res, 404, { error: 'Not found' })
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message })
    console.error(`[${req.method} ${path}]`, (e as Error).message)
    send(res, 500, { error: (e as Error).message })
  }
})

server.listen(PORT, () => console.log(`[server] http://localhost:${PORT} (${configured ? 'Databricks' : 'local store'})`))

try {
  await backend.start()
  console.log(`[server] ready in ${backend.getState().mode} mode`)
} catch (e) {
  console.error('[server] start failed:', (e as Error).message)
}
