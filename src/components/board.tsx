import { Link } from 'react-router'
import type { Resident, ResidentStatus } from '../data/residents'
import { minutesAgo, clock, LOW_BATTERY } from '../data/residents'
import { kindLabel, urgencyLabel, type Alert } from '../data/alerts'
import { useLive } from '../live'

/** Room number as a small door plate. Used wherever a room appears. */
export function RoomPlate({ room }: { room: string }) {
  return (
    <span className="inline-flex h-6 min-w-12 items-center justify-center rounded border border-line bg-raised px-2 font-mono text-xs tabular-nums text-fg">
      {room}
    </span>
  )
}

const statusLabel: Record<ResidentStatus, string> = {
  fall: 'Fall',
  check: 'Needs a check',
  up: 'Up',
  asleep: 'Asleep',
  offline: 'No data',
}

const dotClass = {
  fall: 'bg-fall',
  check: 'bg-check',
  up: 'border border-fg-2',
  asleep: 'bg-fg-3/40',
  offline: 'border border-dashed border-fg-3',
  battery: 'bg-fg-3',
  signal: 'bg-fg-3',
}

export function Dot({ kind }: { kind: keyof typeof dotClass }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass[kind]}`} />
}

export function StatusMark({ status }: { status: ResidentStatus }) {
  const text = {
    fall: 'text-fall font-medium',
    check: 'text-check font-medium',
    up: 'text-fg',
    asleep: 'text-fg-2',
    offline: 'text-fg-3',
  }[status]

  return (
    <span className={`inline-flex items-center gap-2 text-sm ${text}`}>
      <Dot kind={status} />
      {statusLabel[status]}
    </span>
  )
}

export function BatteryText({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="font-mono text-fg-3">–</span>
  return <span className={`font-mono tabular-nums ${value < LOW_BATTERY ? 'text-check' : ''}`}>{value}%</span>
}

function alertTitle(alert: Alert, name: string) {
  switch (alert.kind) {
    case 'fall':
      return `${name} may have fallen`
    case 'check':
      return `${name} needs a check`
    case 'battery':
      return `${name}'s device is low on battery`
    case 'signal':
      return `${name}'s device has a weak signal`
  }
}

/** The tier on an open fall: who to see first, never whether to go at all */
function UrgencyBadge({ alert }: { alert: Alert }) {
  if (!alert.urgency) return null
  const style = {
    critical: 'border-fall-line bg-fall-soft text-fall',
    urgent: 'border-line bg-raised text-check',
    watch: 'border-line bg-card text-fg-2',
  }[alert.urgency]
  return <span className={`rounded border px-1.5 py-0.5 text-xs font-normal ${style}`}>{urgencyLabel[alert.urgency]}</span>
}

const buttonBase =
  'h-10 shrink-0 rounded-lg px-4 text-sm font-medium transition-[opacity,background-color,transform] duration-150 ease-out active:scale-[0.98]'

interface AlertRowProps {
  alert: Alert
  /** Pass a resident to skip the live lookup (used by the landing page preview) */
  resident?: Resident
  onHandle: () => void
  onUndo: () => void
}

/** One alert. Falls get the only strong color in the app. */
export function AlertRow({ alert, resident: given, onHandle, onUndo }: AlertRowProps) {
  const { findResident } = useLive()
  const resident = given ?? findResident(alert.residentId)
  if (!resident) return null

  if (alert.handledAt) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-card px-5 py-3">
        <RoomPlate room={resident.room} />
        <p className="min-w-48 flex-1 text-sm text-fg-2">
          <Link to={`/residents/${resident.id}`} className="text-fg hover:underline">
            {resident.name}
          </Link>{' '}
          · {kindLabel[alert.kind].toLowerCase()} at <span className="font-mono tabular-nums">{clock(alert.raisedAt)}</span>,
          handled at <span className="font-mono tabular-nums">{clock(alert.handledAt)}</span>
          {alert.handledBy && <> · via {alert.handledBy}</>}
        </p>
        <button onClick={onUndo} className="text-sm text-fg-2 transition-colors duration-150 hover:text-fg">
          Undo
        </button>
      </div>
    )
  }

  const isFall = alert.kind === 'fall'

  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-4 rounded-xl border px-5 py-4 ${
        isFall ? 'border-fall-line bg-fall-soft' : 'border-line bg-card'
      }`}
    >
      <RoomPlate room={resident.room} />
      <div className="min-w-48 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-base font-medium text-fg">
          <Dot kind={alert.kind} />
          <Link to={`/residents/${resident.id}`} className="hover:underline">
            {alertTitle(alert, resident.name)}
          </Link>
          <UrgencyBadge alert={alert} />
        </p>
        <p className="mt-1 pl-4 text-sm text-fg-2">
          <span className="font-mono tabular-nums">{clock(alert.raisedAt)}</span> · {alert.detail}
          {alert.acknowledgedAt && (
            <>
              {' '}
              · I'm OK at <span className="font-mono tabular-nums">{clock(alert.acknowledgedAt)}</span>, still needs a visit
            </>
          )}
          {isFall && resident.heartRate !== null && (
            <>
              {' '}
              · heart rate <span className="font-mono tabular-nums">{resident.heartRate}</span> bpm
            </>
          )}
        </p>
      </div>
      <button
        onClick={onHandle}
        className={
          isFall
            ? `${buttonBase} bg-fall text-white hover:opacity-90`
            : `${buttonBase} border border-line bg-raised text-fg hover:bg-page`
        }
      >
        {isFall ? 'Mark checked' : alert.kind === 'check' ? 'Acknowledge' : 'Done'}
      </button>
    </div>
  )
}

const fullCols = 'grid grid-cols-[64px_1fr_auto] md:grid-cols-[72px_1fr_176px_144px_88px] items-center gap-x-4'
const compactCols = 'grid grid-cols-[64px_1fr_auto] md:grid-cols-[72px_1fr_152px_80px] items-center gap-x-4'

/** All residents, one row each. Rows open the resident's page. Compact drops the last-movement column. */
export function ResidentList({ residents, compact }: { residents: Resident[]; compact?: boolean }) {
  const cols = compact ? compactCols : fullCols
  const movementCol = compact ? 'hidden' : 'hidden md:block'
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card">
      <div className={`${cols} h-10 border-b border-line px-4 text-xs text-fg-3`}>
        <span>Room</span>
        <span>Resident</span>
        <span className="hidden md:block">Status</span>
        <span className={movementCol}>Last movement</span>
        <span className="text-right">Heart rate</span>
      </div>
      <ul>
        {residents.map((r) => (
          <li key={r.id} className="border-b border-line last:border-b-0">
            <Link
              to={`/residents/${r.id}`}
              className={`${cols} min-h-14 px-4 py-2 transition-colors duration-150 hover:bg-raised/50`}
            >
              <RoomPlate room={r.room} />
              <div className="min-w-0">
                <p className="truncate text-sm text-fg">{r.name}</p>
                {r.note && <p className="truncate text-xs text-fg-2">{r.note}</p>}
                <div className="mt-1 md:hidden">
                  <StatusMark status={r.status} />
                </div>
              </div>
              <span className="hidden md:block">
                <StatusMark status={r.status} />
              </span>
              <span className={`${movementCol} text-sm text-fg-2`}>{minutesAgo(r.lastMovementMin)}</span>
              <span className="text-right font-mono text-sm tabular-nums text-fg-2">
                {r.heartRate === null ? '–' : `${r.heartRate} bpm`}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
