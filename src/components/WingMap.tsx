import { Link } from 'react-router'
import { BatteryLow } from 'lucide-react'
import { byRoom, LOW_BATTERY, type Resident } from '../data/residents'
import { RoomPlate, StatusMark } from './board'

function RoomTile({ r, side }: { r: Resident; side: 'north' | 'south' }) {
  const tone =
    r.status === 'fall'
      ? 'border-fall-line bg-fall-soft'
      : r.status === 'check'
        ? 'border-check/40 bg-card'
        : 'border-line bg-card'
  const battery = r.device?.battery

  return (
    <Link
      to={`/residents/${r.id}`}
      className={`flex min-h-24 flex-col justify-between gap-3 border p-3 transition-colors duration-150 hover:bg-raised ${tone} ${
        side === 'north' ? 'rounded-t-xl rounded-b-sm' : 'rounded-t-sm rounded-b-xl'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <RoomPlate room={r.room} />
        {battery !== null && battery !== undefined && battery < LOW_BATTERY && (
          <BatteryLow className="h-4 w-4 text-check" strokeWidth={1.5} aria-label="Device battery low" />
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm text-fg">{r.name}</p>
        <div className="mt-1">
          <StatusMark status={r.status} />
        </div>
      </div>
    </Link>
  )
}

/** The wing as it's laid out: rooms on both sides of the corridor, nurses' station at the end */
export function WingMap({ residents }: { residents: Resident[] }) {
  const rooms = [...residents].sort(byRoom)
  const half = Math.ceil(rooms.length / 2)
  const north = rooms.slice(0, half)
  const south = rooms.slice(half)

  return (
    <div className="grid gap-2 md:grid-cols-[1fr_96px]">
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {north.map((r) => (
            <RoomTile key={r.id} r={r} side="north" />
          ))}
        </div>
        <div className="flex h-8 items-center rounded-sm border border-dashed border-line px-3 text-xs text-fg-3">
          Corridor
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {south.map((r) => (
            <RoomTile key={r.id} r={r} side="south" />
          ))}
        </div>
      </div>
      <div className="flex items-center justify-center rounded-xl border border-line bg-raised px-3 py-3 text-center text-xs text-fg-2 md:py-0">
        Nurses’ station
      </div>
    </div>
  )
}
