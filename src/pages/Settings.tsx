import { useEffect, useRef, useState } from 'react'
import { Wifi, Check, Circle, Lightbulb, Usb } from 'lucide-react'
import { Page } from '../components/PageHeader'
import { LiveTrace } from '../components/LiveTrace'
import { SurveyPanel } from '../components/SurveyPanel'
import { byRoom } from '../data/residents'
import { connectWifi, connectSimulated, type Connection, type FallDetail, type Transport } from '../hardware/connection'
import { connectSerial, serialSupported } from '../hardware/serial'
import type { MotionSample } from '../hardware/protocol'
import { useLive, post, type DataMode } from '../live'
import { apiFetch, useAuth } from '../auth'

const TRACE_MS = 5000
const SEND_EVERY_MS = 1000

const transportLabel: Record<Transport, string> = {
  wifi: 'Connected over Wi-Fi',
  serial: 'Arduino UNO over USB',
  simulated: 'Demo device',
}

interface LiveDevice {
  id?: string
  firmware?: string
  battery?: number
  sample?: MotionSample
  rate: number
  gyroMoved: boolean
  fallSeen: boolean
}

const emptyDevice: LiveDevice = { rate: 0, gyroMoved: false, fallSeen: false }

const ADDRESS_KEY = 'steady.boardAddress'
function savedAddress() {
  try {
    return localStorage.getItem(ADDRESS_KEY) ?? 'unoq.local'
  } catch {
    return 'unoq.local'
  }
}

function stamp() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

// ---------- Data source ----------

const modes: { id: DataMode; label: string; text: string }[] = [
  {
    id: 'simulated',
    label: 'Simulated',
    text: 'The server writes simulated gyroscope readings for every resident into Databricks.',
  },
  {
    id: 'device',
    label: 'Live devices',
    text: 'Only real wearables count. Pair a device below and its readings go to Databricks.',
  },
]

function DataSource() {
  const { mode, setMode, residents, simulateFall } = useLive()
  const [switching, setSwitching] = useState(false)
  const [fallFor, setFallFor] = useState('')
  const [message, setMessage] = useState<string>()

  const choose = async (m: DataMode) => {
    if (m === mode) return
    setSwitching(true)
    setMessage(undefined)
    try {
      await setMode(m)
    } catch (e) {
      setMessage((e as Error).message)
    } finally {
      setSwitching(false)
    }
  }

  const fall = async () => {
    if (!fallFor) return
    try {
      await simulateFall(fallFor)
      const r = residents.find((x) => x.id === fallFor)
      setMessage(`Fall sent for ${r?.name ?? 'resident'}. It shows on Alerts within a few seconds.`)
      setFallFor('')
    } catch (e) {
      setMessage((e as Error).message)
    }
  }

  return (
    <section className="rounded-xl border border-line bg-card p-5">
      <h2 className="text-base font-medium">Data source</h2>
      <p className="mt-1 text-sm text-fg-2">Every screen reads from Databricks. Choose where the readings come from.</p>

      <div role="radiogroup" className="mt-5 grid gap-2 sm:grid-cols-2">
        {modes.map((m) => {
          const selected = mode === m.id
          return (
            <button
              key={m.id}
              role="radio"
              aria-checked={selected}
              disabled={switching}
              onClick={() => choose(m.id)}
              className={`flex items-start gap-3 rounded-lg border p-4 text-left transition-colors duration-150 disabled:opacity-60 ${
                selected ? 'border-accent/60 bg-raised' : 'border-line hover:bg-raised/50'
              }`}
            >
              <span
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  selected ? 'border-accent' : 'border-fg-3'
                }`}
              >
                {selected && <span className="h-2 w-2 rounded-full bg-accent" />}
              </span>
              <span>
                <span className="block text-sm font-medium text-fg">{m.label}</span>
                <span className="mt-1 block text-sm text-fg-2">{m.text}</span>
              </span>
            </button>
          )
        })}
      </div>

      {mode === 'simulated' && (
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-5">
          <span className="mr-2 text-sm text-fg-2">Demo a fall</span>
          <select
            value={fallFor}
            onChange={(e) => setFallFor(e.target.value)}
            className="h-10 min-w-48 rounded-lg border border-line bg-raised px-3 text-sm text-fg"
          >
            <option value="">Choose a resident</option>
            {[...residents].sort(byRoom).map((r) => (
              <option key={r.id} value={r.id} disabled={r.status === 'fall'}>
                {r.room} · {r.name}
              </option>
            ))}
          </select>
          <button
            disabled={!fallFor}
            onClick={fall}
            className="h-10 rounded-lg border border-line bg-raised px-4 text-sm font-medium text-fg transition-colors duration-150 hover:bg-page disabled:opacity-40"
          >
            Send fall
          </button>
        </div>
      )}
      {message && <p className="mt-3 text-sm text-fg-2">{message}</p>}
    </section>
  )
}

// ---------- Connect a device ----------

function TestRow({ ok, label, hint }: { ok: boolean; label: string; hint: string }) {
  return (
    <li className="flex items-start gap-3 border-t border-line py-3">
      {ok ? (
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" strokeWidth={1.5} />
      ) : (
        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-fg-3" strokeWidth={1.5} />
      )}
      <div>
        <p className="text-sm text-fg">{label}</p>
        <p className="text-xs text-fg-2">{ok ? 'Passed' : hint}</p>
      </div>
    </li>
  )
}

function Reading({ label, value, unit }: { label: string; value?: number; unit: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-fg-2">{label}</span>
      <span className="font-mono tabular-nums text-fg">
        {value === undefined ? '–' : value.toFixed(2)} <span className="text-fg-3">{unit}</span>
      </span>
    </div>
  )
}

/** Movement score 0–100 from gyroscope activity, on the same scale the simulator uses */
function summarize(samples: MotionSample[]) {
  const gyro = samples.map((s) => Math.hypot(s.gx, s.gy, s.gz))
  const accel = samples.map((s) => Math.hypot(s.ax, s.ay, s.az))
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
  const gyroDps = mean(gyro)
  // The raw second too, for the live graph on the resident's page
  const raw = samples.map((s) => [Math.round(s.t), s.ax, s.ay, s.az, s.gx, s.gy, s.gz])
  return { movement: Math.min(100, gyroDps / 2), gyroDps, accelG: mean(accel), samples: raw }
}

function ConnectPanel() {
  const { mode, residents, allResidents, pair, addResident } = useLive()
  const [conn, setConn] = useState<Connection>()
  const [dev, setDev] = useState<LiveDevice>(emptyDevice)
  const [trace, setTrace] = useState<MotionSample[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [residentId, setResidentId] = useState('')
  // Typing in a new resident instead of choosing one
  const [newName, setNewName] = useState('')
  const [newRoom, setNewRoom] = useState('')
  // Shown straight after pairing, before the next refresh confirms it
  const [justPaired, setJustPaired] = useState<{ device: string; name: string; room: string }>()
  const [sent, setSent] = useState<{ ok: number; note?: string }>({ ok: 0 })
  const [address, setAddress] = useState(savedAddress)
  // a worker response, a survey or a room match, as the board reported it
  const [lastEvent, setLastEvent] = useState<string>()

  // Samples arrive up to 50 times a second, so collect them in a ref and redraw a few times a second
  const buffer = useRef<MotionSample[]>([])
  const devRef = useRef<LiveDevice>(emptyDevice)
  const lastSent = useRef(0)
  const modeRef = useRef(mode)
  modeRef.current = mode
  // A board on Wi-Fi sends its own readings and falls to the server, so the browser doesn't
  const forwardRef = useRef(true)

  useEffect(() => {
    if (!conn) return
    const timer = setInterval(() => {
      const now = performance.now()
      buffer.current = buffer.current.filter((s) => now - s.t < TRACE_MS)
      const lastSecond = buffer.current.filter((s) => now - s.t < 1000)
      devRef.current = { ...devRef.current, rate: lastSecond.length }
      setDev(devRef.current)
      setTrace([...buffer.current])

      // In "Live devices" mode, send a one-second summary to Databricks through the server
      const d = devRef.current
      if (forwardRef.current && modeRef.current === 'device' && d.id && lastSecond.length && now - lastSent.current >= SEND_EVERY_MS) {
        lastSent.current = now
        post('/api/readings', { deviceId: d.id, battery: d.battery ?? null, ...summarize(lastSecond) })
          .then((r: { accepted: number }) =>
            setSent((s) =>
              r.accepted ? { ok: s.ok + 1 } : { ok: s.ok, note: 'Pair this device to a resident to send its readings' },
            ),
          )
          .catch(() => setSent((s) => ({ ok: s.ok, note: 'Can’t reach the server' })))
      }
    }, 100)
    return () => clearInterval(timer)
  }, [conn])

  const start = async (kind: Transport) => {
    setError(undefined)
    setBusy(true)
    setSent({ ok: 0 })
    setLastEvent(undefined)
    buffer.current = []
    devRef.current = { ...emptyDevice }
    setDev(devRef.current)
    const update = (patch: Partial<LiveDevice>) => (devRef.current = { ...devRef.current, ...patch })
    forwardRef.current = kind !== 'wifi'

    const events = {
      onInfo: (id: string, firmware: string) => update({ id, firmware }),
      onBattery: (battery: number) => update({ battery }),
      onMotion: (s: MotionSample) => {
        buffer.current.push(s)
        const moved = Math.hypot(s.gx, s.gy, s.gz) > 30
        update({ sample: s, gyroMoved: devRef.current.gyroMoved || moved })
      },
      onFall: (detail?: FallDetail) => {
        update({ fallSeen: true })
        // Fast path: falls go straight to the server, with what the board measured
        if (forwardRef.current && modeRef.current === 'device' && devRef.current.id)
          post('/api/falls', { deviceId: devRef.current.id, detail }).catch(() => {})
        const measured = [
          detail?.peakG !== undefined ? `peak ${detail.peakG.toFixed(1)} g` : null,
          detail?.tiltDelta !== undefined ? `tilt ${Math.round(detail.tiltDelta)}°` : null,
        ].filter(Boolean)
        setLastEvent(measured.length ? `Fall detected · ${measured.join(', ')}` : 'Fall detected')
      },
      onOk: () => setLastEvent(`Worker responded at ${stamp()}`),
      onSurvey: (summary: { scans?: number; accessPoints?: number }) =>
        setLastEvent(`Survey captured · ${summary.scans ?? '?'} scans, ${summary.accessPoints ?? '?'} APs`),
      onLocation: (place: { room?: string; floor?: string; confidence?: number }) =>
        setLastEvent(
          `Located in room ${place.room}${place.floor ? `, floor ${place.floor}` : ''}${
            place.confidence ? ` · ${place.confidence}%` : ''
          }`,
        ),
      onDisconnect: () => setConn(undefined),
    }

    try {
      if (kind === 'wifi') {
        try {
          localStorage.setItem(ADDRESS_KEY, address)
        } catch {
          // fine, just not remembered
        }
      }
      if (kind === 'wifi') setConn(await connectWifi(address, events))
      else if (kind === 'serial') setConn(await connectSerial(events))
      else setConn(await connectSimulated(events))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const s = dev.sample
  const gravity = s ? Math.hypot(s.ax, s.ay, s.az) : 0
  const pairedTo = dev.id ? residents.find((r) => r.device?.id === dev.id) : undefined

  if (!conn) {
    return (
      <section className="rounded-xl border border-line bg-card p-5">
        <h2 className="text-base font-medium">Connect a device</h2>
        <p className="mt-1 max-w-[40rem] text-sm text-fg-2">
          Connect a wearable over Wi-Fi, or an Arduino UNO with an MPU6050 over USB, to check its accelerometer and
          gyroscope and pair it to a resident.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="board-address">
            Board address
          </label>
          <input
            id="board-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && address && start('wifi')}
            placeholder="Board address, e.g. unoq.local or 192.168.1.40"
            className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 font-mono text-sm text-fg placeholder:font-sans placeholder:text-fg-3 sm:max-w-80"
          />
          <button
            disabled={!address || busy}
            onClick={() => start('wifi')}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-fg px-4 text-sm font-medium text-inverse transition-[opacity,transform] duration-150 ease-out hover:opacity-90 active:scale-[0.98] disabled:opacity-40"
          >
            <Wifi className="h-4 w-4" strokeWidth={1.5} />
            Connect over Wi-Fi
          </button>
          <button
            disabled={busy || !serialSupported()}
            onClick={() => start('serial')}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-raised px-4 text-sm text-fg transition-colors duration-150 hover:bg-page disabled:opacity-40"
          >
            <Usb className="h-4 w-4" strokeWidth={1.5} />
            Connect Arduino (USB)
          </button>
          <button
            disabled={busy}
            onClick={() => start('simulated')}
            className="h-10 px-2 text-sm text-fg-2 transition-colors duration-150 hover:text-fg"
          >
            Try a demo device
          </button>
        </div>
        {!serialSupported() && (
          <p className="mt-3 text-xs text-fg-3">
            USB serial needs Chrome or Edge on desktop. Use Wi-Fi or the demo device otherwise.
          </p>
        )}
        {error && <p className="mt-3 text-sm text-fall">{error}</p>}
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-line bg-card p-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex items-center gap-2 text-sm text-fg">
          <span className="h-2 w-2 rounded-full bg-accent" />
          {transportLabel[conn.transport]}
        </span>
        <span className="font-mono text-sm tabular-nums text-fg">{dev.id ?? 'Reading device…'}</span>
        <div className="ml-auto flex gap-2">
          {conn.transport === 'wifi' && (
            <button
              onClick={() => conn.identify()}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-raised px-3 text-sm text-fg transition-colors duration-150 hover:bg-page"
            >
              <Lightbulb className="h-4 w-4" strokeWidth={1.5} />
              Blink light
            </button>
          )}
          <button
            onClick={() => conn.disconnect()}
            className="h-9 rounded-lg px-3 text-sm text-fg-2 transition-colors duration-150 hover:bg-raised hover:text-fg"
          >
            Disconnect
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div>
          <h3 className="text-sm font-medium">Gyroscope</h3>
          <div className="mt-3">
            <LiveTrace samples={trace} />
          </div>
          <div className="mt-5 grid gap-x-8 gap-y-1 text-sm sm:grid-flow-col sm:grid-rows-3">
            <Reading label="Accel x" value={s?.ax} unit="g" />
            <Reading label="Accel y" value={s?.ay} unit="g" />
            <Reading label="Accel z" value={s?.az} unit="g" />
            <Reading label="Gyro x" value={s?.gx} unit="°/s" />
            <Reading label="Gyro y" value={s?.gy} unit="°/s" />
            <Reading label="Gyro z" value={s?.gz} unit="°/s" />
          </div>
          <p className="mt-3 font-mono text-xs tabular-nums text-fg-3">
            {dev.rate} samples/s{dev.battery !== undefined && ` · battery ${dev.battery}%`}
          </p>
          <p className="mt-1 text-xs text-fg-2">
            {conn.transport === 'wifi'
              ? 'The board sends its own readings to Databricks. This view is for checking the sensor.'
              : mode === 'device'
                ? sent.note ?? (sent.ok ? `Sending to Databricks · ${sent.ok} summaries sent` : 'Sending to Databricks…')
                : 'Not sending to Databricks. Switch the data source to Live devices to send these readings.'}
          </p>
        </div>

        <div>
          <h3 className="text-sm font-medium">Self-test</h3>
          <ul className="mt-3">
            <TestRow ok={dev.rate >= 10} label="Sending data" hint="Waiting for readings from the device" />
            <TestRow
              ok={s !== undefined && Math.abs(gravity - 1) < 0.15}
              label="Accelerometer reads gravity"
              hint={s ? `Reads ${gravity.toFixed(2)} g, should be close to 1.00 when still` : 'Hold the device still'}
            />
            <TestRow ok={dev.gyroMoved} label="Gyroscope responds" hint="Turn the device in your hand" />
            <TestRow ok={dev.fallSeen} label="Fall detection fires" hint="Drop it onto a cushion from about 50 cm" />
          </ul>

          <h3 className="mt-6 text-sm font-medium">Pair to a resident</h3>
          {(() => {
            // The pairing just made wins over data that hasn't refreshed yet
            const shown = justPaired?.device === dev.id ? justPaired : pairedTo
            return (
              shown && (
                <p className="mt-1 text-xs text-fg-2">
                  Paired to {shown.name}
                  {shown.room && `, room ${shown.room}`}
                </p>
              )
            )
          })()}
          <div className="mt-3 flex flex-wrap gap-2">
            <select
              value={residentId}
              onChange={(e) => setResidentId(e.target.value)}
              className="h-10 min-w-0 flex-1 basis-56 rounded-lg border border-line bg-raised px-3 text-sm text-fg"
            >
              <option value="">Choose a resident</option>
              <option value="__new">+ Add a new resident</option>
              {[...allResidents].sort(byRoom).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.room ? `${r.room} · ${r.name}` : r.name}
                </option>
              ))}
            </select>
            {residentId === '__new' && (
              <>
                <label className="sr-only" htmlFor="new-resident-name">
                  Resident’s name
                </label>
                <input
                  id="new-resident-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Resident’s name"
                  autoComplete="off"
                  className="h-10 min-w-0 flex-1 basis-48 rounded-lg border border-line bg-raised px-3 text-sm text-fg placeholder:text-fg-3"
                />
                <label className="sr-only" htmlFor="new-resident-room">
                  Room (optional)
                </label>
                <input
                  id="new-resident-room"
                  value={newRoom}
                  onChange={(e) => setNewRoom(e.target.value)}
                  placeholder="Room (optional)"
                  autoComplete="off"
                  className="h-10 w-36 rounded-lg border border-line bg-raised px-3 text-sm text-fg placeholder:text-fg-3"
                />
              </>
            )}
            <button
              disabled={!dev.id || !residentId || (residentId === '__new' && !newName.trim())}
              onClick={async () => {
                if (!dev.id) return
                setError(undefined)
                try {
                  let id = residentId
                  let who = allResidents.find((r) => r.id === id)
                  if (id === '__new') {
                    const name = newName.trim()
                    const room = newRoom.trim()
                    id = await addResident(name, room)
                    who = { name, room } as (typeof allResidents)[number]
                    setNewName('')
                    setNewRoom('')
                  }
                  await pair(id, dev.id, dev.firmware)
                  setResidentId('')
                  if (who) setJustPaired({ device: dev.id, name: who.name, room: who.room })
                  setSent({ ok: sent.ok })
                } catch (e) {
                  setError((e as Error).message)
                }
              }}
              className="h-10 rounded-lg bg-fg px-4 text-sm font-medium text-inverse transition-[opacity,transform] duration-150 ease-out hover:opacity-90 active:scale-[0.98] disabled:opacity-40"
            >
              {residentId === '__new' ? 'Add and pair' : 'Pair'}
            </button>
          </div>
          {mode === 'simulated' && (
            <p className="mt-2 text-xs text-fg-3">Pairings apply to Live devices mode.</p>
          )}
          {error && <p className="mt-2 text-sm text-fall">{error}</p>}
        </div>
      </div>

      <div className="mt-8 border-t border-line pt-6">
        <SurveyPanel device={dev.id} lastEvent={lastEvent} />
      </div>
    </section>
  )
}

// ---------- Wearables reporting in ----------

interface SeenDevice {
  id: string
  firmware: string | null
  firstSeen: string
  lastSeen: string
  pairedTo: { residentId: string; name: string; room: string } | null
}

/** A wearable that sent data in the last 15 seconds counts as connected */
const CONNECTED_WITHIN_S = 15
const secondsSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))

function seenAgo(iso: string) {
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (sec < 5) return 'just now'
  if (sec < 90) return sec + ' s ago'
  if (sec < 5400) return Math.round(sec / 60) + ' min ago'
  return Math.round(sec / 3600) + ' h ago'
}

/** Green while a wearable is sending, grey once it goes quiet */
function StatusLight({ on }: { on: boolean }) {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0" role="img" aria-label={on ? 'Connected' : 'Not connected'}>
      {on && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500 opacity-40 motion-reduce:hidden" />}
      <span className={`relative h-2.5 w-2.5 rounded-full ${on ? 'bg-emerald-500' : 'bg-fg-3/40'}`} />
    </span>
  )
}

/**
 * The wearable posts straight to the server, so a wearable shows up here as
 * soon as it comes online, before anyone pairs it to a resident.
 */
function DevicesSeen() {
  const { allResidents } = useLive()
  const added = new Set(allResidents.map((r) => r.id))
  const [devices, setDevices] = useState<SeenDevice[] | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const res = await apiFetch('/api/devices')
        if (res.ok && !cancelled) setDevices((await res.json()) as SeenDevice[])
      } catch {
        // Backend offline: keep the last list and try again.
      }
      if (!cancelled) timer = setTimeout(load, 5000)
    }
    load()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  return (
    <section>
      <h2 className="mb-1 text-base font-medium">Wearables reporting in</h2>
      <p className="mb-3 text-sm text-fg-2">
        Devices that have sent data to the server. A green light means it’s sending right now. Pair one below to give
        its readings to a resident.
      </p>
      <div className="overflow-hidden rounded-xl border border-line bg-card">
        {devices && devices.length > 0 ? (
          <ul>
            {devices.map((d) => (
              <li
                key={d.id}
                className="grid min-h-14 grid-cols-[1fr_1fr] items-center gap-x-4 border-b border-line px-4 py-2 text-sm last:border-b-0 md:grid-cols-[1fr_160px_1fr]"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <StatusLight on={secondsSince(d.lastSeen) <= CONNECTED_WITHIN_S} />
                  <span className="truncate font-mono">{d.id}</span>
                </span>
                <span className="hidden tabular-nums text-fg-2 md:block">
                  {secondsSince(d.lastSeen) <= CONNECTED_WITHIN_S ? 'Connected' : `Last seen ${seenAgo(d.lastSeen)}`}
                </span>
                <span className="truncate text-fg-2">
                  {d.pairedTo && added.has(d.pairedTo.residentId)
                    ? (d.pairedTo.room ? `Room ${d.pairedTo.room} · ` : '') + d.pairedTo.name
                    : 'Not paired'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-5 text-sm text-fg-2">
            {devices === null
              ? "Looking for wearables…"
              : "No wearables yet. Power one on, or run npm run sim:device to pretend."}
          </p>
        )}
      </div>
    </section>
  )
}

// ---------- Device table ----------

export function Settings() {
  // Caretakers can connect and pair devices; the data source and demo fall are for admins
  const { isAdmin } = useAuth()
  return (
    <Page>
      <header>
        <h1 className="text-3xl font-normal">Settings</h1>
        <p className="mt-1 text-sm text-fg-2">
          {isAdmin
            ? 'Choose the data source, check the wearables are working, and pair them to residents'
            : 'Check the wearables are working and pair them to residents'}
        </p>
      </header>
      <div className="mt-8 flex flex-col gap-8">
        {isAdmin && <DataSource />}
        <ConnectPanel />
        <DevicesSeen />
      </div>
    </Page>
  )
}
