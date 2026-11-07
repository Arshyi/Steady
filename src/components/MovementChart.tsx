import { movementSlots } from '../data/residents'

/**
 * Movement through the night, one bar per half hour.
 * Earlier slots are neutral; the current slot gets the accent, or red when a fall happened in it.
 */
export function MovementChart({ values, fallInLastSlot }: { values: number[]; fallInLastSlot?: boolean }) {
  const last = values.length - 1
  const gridLines = [100, 50, 0]

  return (
    <div className="relative min-h-56 flex-1">
      {/* Grid */}
      <div className="absolute inset-0 bottom-6 left-8 flex flex-col justify-between">
        {gridLines.map((g) => (
          <div key={g} className="relative border-t border-line">
            <span className="absolute -top-2 -left-8 w-6 text-right font-mono text-[11px] leading-4 tabular-nums text-fg-3">
              {g}
            </span>
          </div>
        ))}
      </div>

      {/* Bars */}
      <div className="absolute inset-0 bottom-6 left-8 flex items-end gap-2 px-1">
        {values.map((v, i) => {
          const color = i === last ? (fallInLastSlot ? 'bg-fall' : 'bg-accent') : 'bg-fg-3/35'
          return (
            <div key={movementSlots[i]} className="flex h-full min-w-0 flex-1 items-end">
              <div
                className={`w-full rounded-t-[4px] ${color}`}
                style={{ height: `${Math.max(v, 2)}%` }}
                title={`${movementSlots[i]} · movement ${v}`}
              />
            </div>
          )
        })}
      </div>

      {/* Time labels */}
      <div className="absolute right-0 bottom-0 left-8 flex gap-2 px-1">
        {movementSlots.map((t, i) => (
          <span
            key={t}
            className={`min-w-0 flex-1 overflow-visible whitespace-nowrap text-center font-mono text-[11px] tabular-nums ${
              i % 2 ? 'invisible sm:visible' : ''
            } ${
              i === last ? 'text-fg' : 'text-fg-3'
            }`}
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  )
}
