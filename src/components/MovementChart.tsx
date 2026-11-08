/**
 * Movement through the night, one bar per half hour.
 * Earlier slots are neutral; the current slot gets the accent, or red when the resident has fallen.
 * Empty slots (no readings) show no bar.
 */
export function MovementChart({
  values,
  labels,
  fallInLastSlot,
}: {
  values: (number | null)[]
  labels: string[]
  fallInLastSlot?: boolean
}) {
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
            <div key={i} className="flex h-full min-w-0 flex-1 items-end">
              {v !== null && (
                <div
                  className={`w-full rounded-t-[4px] ${color}`}
                  style={{ height: `${Math.max(v, 2)}%` }}
                  title={`${labels[i]} · movement ${v}`}
                />
              )}
            </div>
          )
        })}
      </div>

      {/* Time labels */}
      <div className="absolute right-0 bottom-0 left-8 flex gap-2 px-1">
        {labels.map((t, i) => (
          <span
            key={i}
            className={`min-w-0 flex-1 overflow-visible whitespace-nowrap text-center font-mono text-[11px] tabular-nums ${
              i % 2 && i !== last ? 'invisible sm:visible' : ''
            } ${i === last ? 'text-fg' : 'text-fg-3'}`}
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  )
}
