import type { MotionSample } from '../hardware/protocol'

const W = 600
const H = 160
const RANGE = 250 // °/s shown from -RANGE to +RANGE

/** Gyroscope x, y, z over the last few seconds. X leads in the accent, y and z sit in neutrals. */
export function LiveTrace({ samples }: { samples: MotionSample[] }) {
  if (samples.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-line text-sm text-fg-3">
        Waiting for data
      </div>
    )
  }

  const t0 = samples[0].t
  const span = Math.max(samples[samples.length - 1].t - t0, 1)
  const x = (t: number) => ((t - t0) / span) * W
  const y = (v: number) => H / 2 - (Math.max(-RANGE, Math.min(RANGE, v)) / RANGE) * (H / 2)
  const line = (key: 'gx' | 'gy' | 'gz') => samples.map((s) => `${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join(' ')

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label="Live gyroscope trace">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        <polyline points={line('gz')} fill="none" stroke="var(--fg-3)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" opacity="0.6" />
        <polyline points={line('gy')} fill="none" stroke="var(--fg-2)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" opacity="0.8" />
        <polyline points={line('gx')} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-2 flex gap-4 font-mono text-[11px] text-fg-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 bg-accent" />x
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 bg-fg-2" />y
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 bg-fg-3" />z
        </span>
        <span className="ml-auto">±{RANGE} °/s · last 5 s</span>
      </div>
    </div>
  )
}
