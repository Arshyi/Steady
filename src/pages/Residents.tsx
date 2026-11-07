import { Link, NavLink, useParams } from 'react-router'
import { ChevronLeft } from 'lucide-react'
import {
  residents, byRoom, findResident, minutesAgo, secondsAgo, LOW_BATTERY, movementSlots, type Resident,
} from '../data/residents'
import { kindLabel } from '../data/alerts'
import { BatteryText, Dot, RoomPlate, StatusMark } from '../components/board'
import { MovementChart } from '../components/MovementChart'
import { Wearable } from '../components/Wearable'
import { useAlerts } from '../alerts'

const signalLabel = { good: 'Good', fair: 'Fair', weak: 'Weak' }

function ResidentPicker({ selectedId }: { selectedId?: string }) {
  return (
    <nav aria-label="Residents" className="overflow-hidden rounded-xl border border-line bg-card">
      <ul>
        {[...residents].sort(byRoom).map((r) => (
          <li key={r.id} className="border-b border-line last:border-b-0">
            <NavLink
              to={`/residents/${r.id}`}
              className={`flex h-14 items-center gap-3 px-4 transition-colors duration-150 ${
                r.id === selectedId ? 'bg-raised' : 'hover:bg-raised/50'
              }`}
            >
              <RoomPlate room={r.room} />
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{r.name}</span>
              <Dot kind={r.status} />
              <span className="w-10 text-right text-xs text-fg-2">
                <BatteryText value={r.device.battery} />
              </span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'fall' | 'check' }) {
  const color = tone === 'fall' ? 'text-fall' : tone === 'check' ? 'text-check' : 'text-fg'
  return (
    <div className="rounded-xl border border-line bg-card p-5">
      <p className="text-sm text-fg-2">{label}</p>
      <p className={`mt-2 text-[28px] leading-none font-medium tabular-nums ${color}`}>{value}</p>
      <p className="mt-2 font-mono text-xs tabular-nums text-fg-3">{sub}</p>
    </div>
  )
}

function ResidentDetail({ r }: { r: Resident }) {
  const { alerts } = useAlerts()
  const events = alerts.filter((a) => a.residentId === r.id)
  const d = r.device
  const lowBattery = d.battery < LOW_BATTERY
  const light = r.status === 'fall' ? 'fall' : r.status === 'check' || lowBattery ? 'check' : 'accent'

  return (
    <div className="min-w-0">
      <Link to="/residents" className="mb-4 inline-flex items-center gap-1 text-sm text-fg-2 hover:text-fg lg:hidden">
        <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
        All residents
      </Link>

      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <RoomPlate room={r.room} />
        <h1 className="text-3xl font-normal">{r.name}</h1>
        <StatusMark status={r.status} />
      </header>
      {r.note && <p className="mt-2 text-sm text-fg-2">{r.note}</p>}

      <div className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat
          label="Heart rate"
          value={`${r.heartRate} bpm`}
          sub={`${r.heartRateRange[0]}–${r.heartRateRange[1]} tonight`}
          tone={r.status === 'fall' ? 'fall' : undefined}
        />
        <Stat label="Last movement" value={minutesAgo(r.lastMovementMin)} sub={`Worn since ${d.wornSince}`} />
        <Stat
          label="Battery"
          value={`${d.battery}%`}
          sub={lowBattery ? 'Charge on next round' : 'Lasts the shift'}
          tone={lowBattery ? 'check' : undefined}
        />
        <Stat
          label="Signal"
          value={signalLabel[d.signal]}
          sub={`${d.rssi} dBm`}
          tone={d.signal === 'weak' ? 'check' : undefined}
        />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[2fr_1fr]">
        <section className="flex flex-col rounded-xl border border-line bg-card p-5">
          <div className="mb-6 flex items-baseline justify-between gap-4">
            <h2 className="text-base font-medium">Movement tonight</h2>
            <p className="text-xs text-fg-3">
              Per half hour since {movementSlots[0]}
            </p>
          </div>
          <MovementChart values={r.movement} fallInLastSlot={r.status === 'fall'} />
        </section>

        <section className="rounded-xl border border-line bg-card p-5">
          <h2 className="text-base font-medium">Device</h2>
          <div className="my-6 rounded-xl bg-deep py-6">
            <Wearable deviceId={d.id} light={light} size={88} />
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-fg-2">Device</dt>
            <dd className="text-right font-mono tabular-nums">{d.id}</dd>
            <dt className="text-fg-2">Firmware</dt>
            <dd className="text-right font-mono tabular-nums">{d.firmware}</dd>
            <dt className="text-fg-2">Battery</dt>
            <dd className="text-right">
              <BatteryText value={d.battery} />
            </dd>
            <dt className="text-fg-2">Last sync</dt>
            <dd className="text-right font-mono tabular-nums">{secondsAgo(d.lastSyncSec)}</dd>
          </dl>
        </section>
      </div>

      <section className="mt-3 rounded-xl border border-line bg-card p-5">
        <h2 className="text-base font-medium">Alerts tonight</h2>
        {events.length ? (
          <ul className="mt-4 flex flex-col">
            {events.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line py-3 text-sm">
                <span className="w-12 font-mono tabular-nums text-fg-3">{a.time}</span>
                <span className="inline-flex items-center gap-2 text-fg">
                  <Dot kind={a.kind} />
                  {kindLabel[a.kind]}
                </span>
                <span className="flex-1 text-fg-2">{a.detail}</span>
                <span className="font-mono text-xs tabular-nums text-fg-3">
                  {a.handledAt ? `Handled ${a.handledAt}` : 'Open'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-fg-2">None tonight</p>
        )}
      </section>
    </div>
  )
}

export function Residents() {
  const { id } = useParams()
  const selected = id ? findResident(id) : [...residents].sort(byRoom)[0]

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-8">
      <div className="grid gap-8 lg:grid-cols-[288px_1fr]">
        <div className={id ? 'hidden lg:block' : ''}>
          <h2 className="mb-3 text-base font-medium">Residents</h2>
          <ResidentPicker selectedId={selected?.id} />
        </div>
        <div className={id ? '' : 'hidden lg:block'}>
          {selected ? <ResidentDetail r={selected} /> : <p className="text-sm text-fg-2">Resident not found</p>}
        </div>
      </div>
    </div>
  )
}
