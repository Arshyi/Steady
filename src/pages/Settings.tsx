import { useEffect, useRef, useState } from 'react'
import { Bluetooth, Usb, Check, Circle, Lightbulb, Wifi } from 'lucide-react'
import { Page } from '../components/PageHeader'
import { RoomPlate, BatteryText, Dot } from '../components/board'
import { LiveTrace } from '../components/LiveTrace'
import { residents, byRoom, secondsAgo, shift, LOW_BATTERY } from '../data/residents'
import {
  connectBluetooth,
  connectUsb,
  connectNetwork,
  connectSimulated,
  support,
  type Connection,
  type DeviceEvents,
  type Transport,
} from '../hardware/connection'
import { NETWORK_DEFAULT_URL, NETWORK_URL_KEY, type MotionSample } from '../hardware/protocol'
import { usePairings } from '../hardware/pairings'
import { useAlerts } from '../alerts'
import { SurveyPanel } from '../components/SurveyPanel'

const LATEST_FIRMWARE = '1.4.2'
const TRACE_MS = 5000

const transportLabel: Record<Transport, string> = {
  bluetooth: 'Connected over Bluetooth',
  usb: 'Connected over USB',
  network: 'Connected over the network',
  simulated: 'Simulated device',
}

interface Live {
  id?: string
  firmware?: string
  battery?: number
  sample?: MotionSample
  rate: number
  gyroMoved: boolean
  fallSeen: boolean
  /** Last button press, NFC tap or survey capture, for the location panel */
  lastEvent?: string
}

const emptyLive: Live = { rate: 0, gyroMoved: false, fallSeen: false }

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
        {value === undefined ? '–' : value.toFixed(2).padStart(7, ' ')} <span className="text-fg-3">{unit}</span>
      </span>
    </div>
  )
}

type Pairings = ReturnType<typeof usePairings>

function ConnectPanel({ pairings, pair }: Pairings) {
  const [conn, setConn] = useState<Connection>()
  const [live, setLive] = useState<Live>(emptyLive)
  const [trace, setTrace] = useState<MotionSample[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [residentId, setResidentId] = useState('')
  // Remembered so the board's address only has to be typed in once
  const [networkUrl, setNetworkUrl] = useState(() => {
    try {
      return localStorage.getItem(NETWORK_URL_KEY) ?? NETWORK_DEFAULT_URL
    } catch {
      return NETWORK_DEFAULT_URL
    }
  })

  // Samples arrive up to 50 times a second, so collect them in a ref and redraw a few times a second
  const buffer = useRef<MotionSample[]>([])
  const liveRef = useRef<Live>(emptyLive)

  // Event handlers are captured when the connection starts, so read current
  // alert and pairing state through refs instead of that first render's values.
  const { alerts, handle } = useAlerts()
  const alertsRef = useRef(alerts)
  const pairingsRef = useRef(pairings)
  useEffect(() => {
    alertsRef.current = alerts
    pairingsRef.current = pairings
  })

  /** An OK press or a staff tap clears the paired resident's open fall or check. */
  const acknowledge = (by: string) => {
    const deviceId = liveRef.current.id
    if (!deviceId) return
    const resident = residents.find((r) => pairingsRef.current[r.id] === deviceId)
    if (!resident) return
    const open = alertsRef.current.find(
      (a) => a.residentId === resident.id && !a.handledAt && (a.kind === 'fall' || a.kind === 'check'),
    )
    if (open) handle(open.id, by)
  }

  useEffect(() => {
    if (!conn) return
    const timer = setInterval(() => {
      const now = performance.now()
      buffer.current = buffer.current.filter((s) => now - s.t < TRACE_MS)
      const lastSecond = buffer.current.filter((s) => now - s.t < 1000).length
      liveRef.current = { ...liveRef.current, rate: lastSecond }
      setLive(liveRef.current)
      setTrace([...buffer.current])
    }, 100)
    return () => clearInterval(timer)
  }, [conn])

  const start = async (kind: Transport) => {
    setError(undefined)
    setBusy(true)
    buffer.current = []
    liveRef.current = { ...emptyLive }
    setLive(liveRef.current)
    const update = (patch: Partial<Live>) => (liveRef.current = { ...liveRef.current, ...patch })

    const events: DeviceEvents = {
      onInfo: (id: string, firmware: string) => update({ id, firmware }),
      onBattery: (battery: number) => update({ battery }),
      onMotion: (s: MotionSample) => {
        buffer.current.push(s)
        const moved = Math.hypot(s.gx, s.gy, s.gz) > 30
        update({ sample: s, gyroMoved: liveRef.current.gyroMoved || moved })
      },
      onFall: () => update({ fallSeen: true }),
      onOk: () => {
        update({ lastEvent: "Wearer pressed I'm OK" })
        acknowledge("I'm OK button")
      },
      onTap: (tag: string) => {
        update({ lastEvent: `NFC tap ${tag.slice(-4)}` })
        acknowledge(`NFC tag ${tag.slice(-4)}`)
      },
      onSurvey: (summary) =>
        update({ lastEvent: `Survey: ${summary.scans ?? 0} scans, ${summary.accessPoints ?? 0} APs` }),
      onDisconnect: () => setConn(undefined),
    }

    try {
      const c =
        kind === 'bluetooth'
          ? await connectBluetooth(events)
          : kind === 'usb'
            ? await connectUsb(events)
            : kind === 'network'
              ? await connectNetwork(networkUrl.trim(), events)
              : await connectSimulated(events)
      setConn(c)
      if (kind === 'network') {
        try {
          localStorage.setItem(NETWORK_URL_KEY, networkUrl.trim())
        } catch {
          // storage blocked; the address lasts until the page reloads
        }
      }
    } catch (e) {
      // Closing the browser's picker counts as an error; don't show that one
      const msg = e instanceof Error ? e.message : String(e)
      if (!/cancel|No port selected|User cancelled/i.test(msg)) setError(msg)
    } finally {
      setBusy(false)
    }
  }

  const s = live.sample
  const gravity = s ? Math.hypot(s.ax, s.ay, s.az) : 0
  const pairedTo = live.id ? residents.find((r) => pairings[r.id] === live.id) : undefined

  if (!conn) {
    return (
      <section className="rounded-xl border border-line bg-card p-5">
        <h2 className="text-base font-medium">Connect a device</h2>
        <p className="mt-1 max-w-[40rem] text-sm text-fg-2">
          Connect a wearable to check its sensors are working and pair it to a resident. Bluetooth and USB work in
          Chrome or Edge on a computer or Android tablet; a wearable on the care network can be reached from any browser.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            disabled={!support.bluetooth || busy}
            onClick={() => start('bluetooth')}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-fg px-4 text-sm font-medium text-inverse transition-[opacity,transform] duration-150 ease-out hover:opacity-90 active:scale-[0.98] disabled:opacity-40"
          >
            <Bluetooth className="h-4 w-4" strokeWidth={1.5} />
            Connect over Bluetooth
          </button>
          <button
            disabled={!support.usb || busy}
            onClick={() => start('usb')}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-raised px-4 text-sm font-medium text-fg transition-colors duration-150 hover:bg-page disabled:opacity-40"
          >
            <Usb className="h-4 w-4" strokeWidth={1.5} />
            Connect over USB
          </button>
          <div className="flex w-full flex-wrap items-center gap-2">
            <input
              value={networkUrl}
              onChange={(e) => setNetworkUrl(e.target.value)}
              spellCheck={false}
              aria-label="Network address of the wearable"
              placeholder={NETWORK_DEFAULT_URL}
              className="h-10 w-64 min-w-0 rounded-lg border border-line bg-raised px-3 font-mono text-sm text-fg"
            />
            <button
              disabled={!support.network || busy || !networkUrl.trim()}
              onClick={() => start('network')}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-raised px-4 text-sm font-medium text-fg transition-colors duration-150 hover:bg-page disabled:opacity-40"
            >
              <Wifi className="h-4 w-4" strokeWidth={1.5} />
              Connect over network
            </button>
          </div>
          <button
            disabled={busy}
            onClick={() => start('simulated')}
            className="h-10 px-2 text-sm text-fg-2 transition-colors duration-150 hover:text-fg"
          >
            Try a simulated device
          </button>
        </div>
        <p className="mt-3 text-xs text-fg-3">
          An UNO Q serves readings at <span className="font-mono">ws://&lt;board-ip&gt;:8765</span> — it can stay on the
          wing's network instead of being plugged into this computer.
        </p>
        {(!support.bluetooth || !support.usb) && (
          <p className="mt-3 text-xs text-fg-3">
            This browser doesn't support {!support.bluetooth && !support.usb ? 'Bluetooth or USB' : !support.bluetooth ? 'Bluetooth' : 'USB'}{' '}
            connections. Use Chrome or Edge.
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
        <span className="font-mono text-sm tabular-nums text-fg">{live.id ?? 'Reading device…'}</span>
        {live.firmware && (
          <span className="font-mono text-xs tabular-nums text-fg-3">
            firmware {live.firmware}
            {live.firmware !== LATEST_FIRMWARE && ` · ${LATEST_FIRMWARE} available`}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          {conn.transport !== 'simulated' && (
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
            {live.rate} samples/s{live.battery !== undefined && ` · battery ${live.battery}%`}
          </p>
        </div>

        <div>
          <h3 className="text-sm font-medium">Self-test</h3>
          <ul className="mt-3">
            <TestRow ok={live.rate >= 10} label="Sending data" hint="Waiting for readings from the device" />
            <TestRow
              ok={s !== undefined && Math.abs(gravity - 1) < 0.15}
              label="Accelerometer reads gravity"
              hint={s ? `Reads ${gravity.toFixed(2)} g, should be close to 1.00 when still` : 'Hold the device still'}
            />
            <TestRow ok={live.gyroMoved} label="Gyroscope responds" hint="Turn the device in your hand" />
            <TestRow ok={live.fallSeen} label="Fall detection fires" hint="Drop it onto a cushion from about 50 cm" />
          </ul>

          <h3 className="mt-6 text-sm font-medium">Pair to a resident</h3>
          {pairedTo && (
            <p className="mt-1 text-xs text-fg-2">
              Paired to {pairedTo.name}, room {pairedTo.room}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <select
              value={residentId}
              onChange={(e) => setResidentId(e.target.value)}
              className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 text-sm text-fg"
            >
              <option value="">Choose a resident</option>
              {[...residents].sort(byRoom).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.room} · {r.name}
                </option>
              ))}
            </select>
            <button
              disabled={!residentId || !live.id}
              onClick={() => live.id && pair(residentId, live.id)}
              className="h-10 rounded-lg bg-fg px-4 text-sm font-medium text-inverse transition-[opacity,transform] duration-150 ease-out hover:opacity-90 active:scale-[0.98] disabled:opacity-40"
            >
              Pair
            </button>
          </div>
        </div>
      </div>

      <div className="mt-6 border-t border-line pt-5">
        <SurveyPanel device={live.id} lastEvent={live.lastEvent} />
      </div>
    </section>
  )
}

function deviceIssues(r: (typeof residents)[number]) {
  const issues: string[] = []
  if (r.device.battery < LOW_BATTERY) issues.push('Low battery')
  if (r.device.signal === 'weak') issues.push('Weak signal')
  if (r.device.lastSyncSec > 30) issues.push('Slow to sync')
  if (r.device.firmware !== LATEST_FIRMWARE) issues.push('Firmware out of date')
  return issues
}

function DeviceTable({ pairings }: { pairings: Pairings['pairings'] }) {
  const cols = 'grid grid-cols-[64px_1fr] md:grid-cols-[72px_1fr_104px_88px_72px_88px_104px_1fr] items-center gap-x-4'

  return (
    <section>
      <h2 className="mb-3 text-base font-medium">Devices in {shift.wing}</h2>
      <div className="overflow-hidden rounded-xl border border-line bg-card">
        <div className={`${cols} h-10 border-b border-line px-4 text-xs text-fg-3`}>
          <span>Room</span>
          <span>Resident</span>
          <span className="hidden md:block">Device</span>
          <span className="hidden md:block">Firmware</span>
          <span className="hidden text-right md:block">Battery</span>
          <span className="hidden md:block">Signal</span>
          <span className="hidden md:block">Last sync</span>
          <span className="hidden md:block">Status</span>
        </div>
        <ul>
          {[...residents].sort(byRoom).map((r) => {
            const issues = deviceIssues(r)
            const deviceId = pairings[r.id] ?? r.device.id
            return (
              <li key={r.id} className={`${cols} min-h-14 border-b border-line px-4 py-2 text-sm last:border-b-0`}>
                <RoomPlate room={r.room} />
                <div className="min-w-0">
                  <p className="truncate">{r.name}</p>
                  <p className={`truncate text-xs md:hidden ${issues.length ? 'text-check' : 'text-fg-2'}`}>
                    {issues.length ? issues.join(', ') : 'Device OK'}
                  </p>
                </div>
                <span className="hidden font-mono tabular-nums text-fg-2 md:block">{deviceId}</span>
                <span className={`hidden font-mono tabular-nums md:block ${r.device.firmware !== LATEST_FIRMWARE ? 'text-check' : 'text-fg-2'}`}>
                  {r.device.firmware}
                </span>
                <span className="hidden text-right text-fg-2 md:block">
                  <BatteryText value={r.device.battery} />
                </span>
                <span className={`hidden md:block ${r.device.signal === 'weak' ? 'text-check' : 'text-fg-2'}`}>
                  <span className="font-mono tabular-nums">{r.device.rssi}</span> dBm
                </span>
                <span className="hidden font-mono tabular-nums text-fg-2 md:block">{secondsAgo(r.device.lastSyncSec)}</span>
                <span className="hidden items-center gap-2 md:inline-flex">
                  <Dot kind={issues.length ? 'check' : 'up'} />
                  <span className={issues.length ? 'text-check' : 'text-fg-2'}>{issues.length ? issues.join(', ') : 'OK'}</span>
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

export function Settings() {
  const p = usePairings()
  return (
    <Page>
      <header>
        <h1 className="text-3xl font-normal">Settings</h1>
        <p className="mt-1 text-sm text-fg-2">Check the wearables are working and pair them to residents</p>
      </header>
      <div className="mt-8 flex flex-col gap-8">
        <ConnectPanel {...p} />
        <DeviceTable pairings={p.pairings} />
      </div>
    </Page>
  )
}
