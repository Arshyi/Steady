// Stands in for the UNO Q's Python uplink: posts the same batched JSON to the
// same endpoint, so the whole path (device -> ingest -> dashboard) can be
// exercised without hardware.
//
//   npm run sim:device
//   npm run sim:device -- --device ST-UNOQ1 --fall-every 90 --minutes 2
//
// Flags
//   --url <endpoint>      default http://localhost:8787/api/v1/ingest
//   --device <id>         default ST-UNOQ1
//   --firmware <version>  default 1.2.0
//   --rate <hz>           default 10 (the firmware's sampling rate)
//   --fall-every <s>      default 0 = never; raise a fall event this often
//   --minutes <n>         stop after n minutes; default 0 = run until Ctrl+C
//   --once                post a single batch and exit
//
// The device token comes from DEVICE_TOKEN so it never lands in shell history.

const args = process.argv.slice(2)
const has = (name: string) => args.includes(`--${name}`)

function flag(name: string, fallback: string) {
  const i = args.indexOf(`--${name}`)
  const next = i >= 0 ? args[i + 1] : undefined
  return next && !next.startsWith('--') ? next : fallback
}

const ENDPOINT = flag('url', process.env.STEADY_INGEST_URL ?? 'http://localhost:8787/api/v1/ingest')
const DEVICE = flag('device', process.env.STEADY_DEVICE ?? 'ST-UNOQ1')
const FIRMWARE = flag('firmware', process.env.STEADY_FIRMWARE ?? '1.2.0')
const RATE = Math.max(1, Math.min(200, Number(flag('rate', '10')) || 10))
const FALL_EVERY = Math.max(0, Number(flag('fall-every', '0')) || 0)
const MINUTES = Math.max(0, Number(flag('minutes', '0')) || 0)
const TOKEN = process.env.DEVICE_TOKEN ?? ''

const round = (v: number, places = 3) => Number(v.toFixed(places))

// ---------- motion ----------

let clock = 0
let moving = false
let moveUntil = 0

function nextSample() {
  clock += 1 / RATE
  const now = Date.now()
  if (now > moveUntil) {
    moving = Math.random() < 0.35
    moveUntil = now + 4000 + Math.random() * 8000
  }
  const amp = moving ? 45 : 3
  const gx = (Math.random() - 0.5) * amp
  const gy = (Math.random() - 0.5) * amp
  const gz = (Math.random() - 0.5) * amp
  const swing = moving ? 0.25 : 0.01
  const ax = Math.sin(clock * 1.7) * swing
  const ay = Math.cos(clock * 1.3) * swing
  const az = 1 + (Math.random() - 0.5) * 0.03
  const svm = Math.hypot(ax, ay, az)
  const tilt = Math.acos(Math.min(1, Math.max(-1, az / svm))) * (180 / Math.PI)
  return {
    ts: now,
    ax: round(ax),
    ay: round(ay),
    az: round(az),
    gx: round(gx, 1),
    gy: round(gy, 1),
    gz: round(gz, 1),
    roll: round(Math.atan2(ay, az) * (180 / Math.PI), 1),
    pitch: round(Math.atan2(-ax, Math.hypot(ay, az)) * (180 / Math.PI), 1),
    tilt: round(tilt, 1),
    svm: round(svm),
    state: moving ? 2 : 1,
  }
}

let seq = 0
function fallEvent() {
  seq += 1
  return {
    uid: `${DEVICE}-${seq}`,
    device_ts: Math.round(process.uptime() * 1000),
    ts: Date.now(),
    duration_ms: 1200,
    peak_g: 6.0,
    min_g: 0.2,
    tilt_before: 8,
    tilt_after: 90,
    tilt_delta: 82,
    confidence: 88,
    flags: 0,
    sample_count: 240,
    rate_hz: 200,
    waveform: null,
  }
}

// ---------- uplink ----------

async function post(payload: unknown) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Device-Id': DEVICE,
    'User-Agent': 'steady-device-sim/1.0',
  }
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`
  const res = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(payload) })
  const text = await res.text()
  if (!res.ok) throw new Error(`ingest ${res.status}: ${text.slice(0, 200)}`)
  return text
}

const battery = () => Math.max(1, 84 - Math.floor((Date.now() - startedAt) / 120_000))
const startedAt = Date.now()

let batch: ReturnType<typeof nextSample>[] = []

async function send(samples: ReturnType<typeof nextSample>[], event = false) {
  const payload = {
    device: DEVICE,
    firmware: FIRMWARE,
    samples,
    battery: battery(),
    rssi: -61,
    ...(event ? { events: [fallEvent()] } : {}),
  }
  const body = await post(payload)
  const reply = JSON.parse(body) as { samples?: number; events?: number }
  console.log(
    `[sim] ${DEVICE} sent ${samples.length} samples${event ? ' + fall event' : ''} -> ` +
      `${reply.samples ?? 0} stored, ${reply.events ?? 0} alerts`,
  )
}

async function runOnce() {
  batch = Array.from({ length: RATE }, nextSample)
  await send(batch)
}

async function main() {
  console.log(`[sim] ${DEVICE} firmware ${FIRMWARE} -> ${ENDPOINT} at ${RATE} Hz${TOKEN ? '' : ' (no token)'}`)
  if (has('once')) return runOnce()

  let nextFallAt = FALL_EVERY > 0 ? Date.now() + FALL_EVERY * 1000 : Infinity
  const timer = setInterval(async () => {
    batch.push(nextSample())
    if (batch.length < RATE) return
    const samples = batch
    batch = []
    const event = Date.now() >= nextFallAt
    if (event) nextFallAt = Date.now() + FALL_EVERY * 1000
    try {
      await send(samples, event)
    } catch (e) {
      console.error('[sim]', (e as Error).message)
    }
    if (MINUTES > 0 && Date.now() - startedAt >= MINUTES * 60_000) {
      clearInterval(timer)
      console.log('[sim] done')
    }
  }, 1000 / RATE)
}

main().catch((e) => {
  console.error('[sim]', (e as Error).message)
  process.exitCode = 1
})
