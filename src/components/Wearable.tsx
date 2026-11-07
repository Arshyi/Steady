/**
 * The Steady wearable, drawn in CSS: a pebble on a strap with a status light.
 * Size scales with `size` (px of the pebble's width).
 */
export function Wearable({
  deviceId,
  light = 'accent',
  size = 112,
}: {
  deviceId: string
  light?: 'accent' | 'fall' | 'check'
  size?: number
}) {
  const lightColor = { accent: 'var(--accent)', fall: 'var(--fall)', check: 'var(--check)' }[light]

  return (
    <div className="relative mx-auto" style={{ width: size, height: size * 1.6 }} aria-hidden>
      {/* Strap */}
      <div
        className="absolute inset-y-0 rounded-full border border-line"
        style={{
          left: '22%',
          right: '22%',
          background: 'linear-gradient(90deg, var(--strap-lo), var(--strap-hi) 50%, var(--strap-lo))',
        }}
      />
      {/* Pebble */}
      <div
        className="absolute inset-x-0 top-1/2 -translate-y-1/2 border border-line"
        style={{
          height: size,
          borderRadius: size * 0.3,
          background: 'linear-gradient(160deg, var(--device-hi), var(--device-lo))',
          boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.12), 0 12px 32px rgb(0 0 0 / 0.28)',
        }}
      >
        {/* Face */}
        <div
          className="absolute flex flex-col items-center justify-between border border-line"
          style={{ inset: size * 0.08, borderRadius: size * 0.22, padding: size * 0.1 }}
        >
          <span
            className="rounded-full"
            style={{
              width: size * 0.07,
              height: size * 0.07,
              background: lightColor,
              boxShadow: `0 0 0 ${size * 0.03}px color-mix(in oklab, ${lightColor} 20%, transparent)`,
            }}
          />
          <span className="font-mono tabular-nums text-fg-3" style={{ fontSize: Math.max(10, size * 0.09) }}>
            {deviceId}
          </span>
        </div>
      </div>
    </div>
  )
}
