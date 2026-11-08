// The contract between the Steady wearable (hardware/steady_wearable.ino) and the web app.
// If you change a UUID or the data layout here, change it in the Arduino sketch too.

/** Bluetooth service the wearable advertises */
export const STEADY_SERVICE = '53746561-6479-4000-8000-000000000000'

/** Bluetooth characteristics inside that service */
export const CHAR = {
  /** Notify, 24 bytes: accel x,y,z in g then gyro x,y,z in °/s, float32 little-endian */
  motion: '53746561-6479-4000-8000-000000000001',
  /** Read, text: "<deviceId>;<firmware>", e.g. "ST-0419;1.4.2" */
  info: '53746561-6479-4000-8000-000000000002',
  /** Write, 1 byte: 1 = blink the LED so staff can find the device */
  command: '53746561-6479-4000-8000-000000000003',
  /** Notify, 1 byte: 1 when the device detects a fall */
  fall: '53746561-6479-4000-8000-000000000004',
}

export const CMD_IDENTIFY = 1

/**
 * USB serial uses the same data as plain text lines at 115200 baud:
 *   I,ST-0419,1.4.2          device info
 *   B,87                     battery percent
 *   M,ax,ay,az,gx,gy,gz      motion sample
 *   F                        fall detected
 * The web app sends "I\n" to blink the LED.
 */
export const SERIAL_BAUD = 115200

export interface MotionSample {
  t: number // ms, from performance.now()
  ax: number
  ay: number
  az: number
  gx: number
  gy: number
  gz: number
}

export function parseMotion(view: DataView): Omit<MotionSample, 't'> {
  return {
    ax: view.getFloat32(0, true),
    ay: view.getFloat32(4, true),
    az: view.getFloat32(8, true),
    gx: view.getFloat32(12, true),
    gy: view.getFloat32(16, true),
    gz: view.getFloat32(20, true),
  }
}

// ---------- Network transport (Arduino UNO Q) ----------

/**
 * `hardware/steady_unoq` serves the same six channels over a WebSocket instead
 * of Bluetooth: the sketch reads the Modulino Movement, the button and the NFC
 * reader, and hands each event to Python over the Bridge, which broadcasts JSON
 * text frames.
 *
 *   server → app   {"type":"hello","device":"ST-UNOQ1","firmware":"1.1.0","rate":50}
 *                  {"type":"motion","t":12345,"ax":0.02,"ay":-0.01,"az":1,"gx":12.4,"gy":-3.1,"gz":0.8}
 *                  {"type":"fall","t":12980,"peak":3.42}
 *                  {"type":"ok","t":13110}
 *                  {"type":"tap","t":14400,"tag":"04A2339C1B80"}
 *                  {"type":"survey","id":12,"scans":5,"accessPoints":9,"takenAt":1690000000000}
 *                  {"type":"location","room":"103","floor":"1","confidence":82}
 *   app → server   {"type":"identify"}
 *                  {"type":"survey"}      ask the board to capture a room now
 *
 * g and °/s again; `t` is the device's uptime in ms and is optional because the
 * app times samples with performance.now() like the other transports do. The
 * survey and location frames come from the backend round-trip, so they only
 * appear when the board is configured with a backend URL.
 */
export const NETWORK_DEFAULT_URL = 'ws://127.0.0.1:8765'

/** Local storage key for the last address that worked */
export const NETWORK_URL_KEY = 'steady.networkUrl'

export type NetworkMessage =
  | { type: 'hello'; device?: string; firmware?: string; rate?: number }
  | { type: 'motion'; t?: number; ax: number; ay: number; az: number; gx: number; gy: number; gz: number }
  | { type: 'fall'; t?: number; peak?: number }
  | { type: 'ok'; t?: number }
  | { type: 'tap'; t?: number; tag?: string }
  | { type: 'survey'; id?: number; scans?: number; accessPoints?: number; takenAt?: number }
  | { type: 'location'; room?: string; floor?: string; confidence?: number }
  | { type: 'error'; message?: string }

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Reads one frame from the UNO Q. Malformed or unknown frames return undefined. */
export function parseNetworkMessage(raw: string): NetworkMessage | undefined {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!data || typeof data !== 'object') return undefined

  const frame = data as Record<string, unknown>
  const t = number(frame.t)

  switch (frame.type) {
    case 'hello':
      return {
        type: 'hello',
        device: text(frame.device),
        firmware: text(frame.firmware),
        rate: number(frame.rate),
      }
    case 'motion': {
      const ax = number(frame.ax)
      const ay = number(frame.ay)
      const az = number(frame.az)
      const gx = number(frame.gx)
      const gy = number(frame.gy)
      const gz = number(frame.gz)
      if (ax === undefined || ay === undefined || az === undefined) return undefined
      if (gx === undefined || gy === undefined || gz === undefined) return undefined
      return { type: 'motion', t, ax, ay, az, gx, gy, gz }
    }
    case 'fall':
      return { type: 'fall', t, peak: number(frame.peak) }
    case 'ok':
      return { type: 'ok', t }
    case 'tap':
      return { type: 'tap', t, tag: text(frame.tag) }
    case 'survey':
      return {
        type: 'survey',
        id: number(frame.id),
        scans: number(frame.scans),
        accessPoints: number(frame.accessPoints),
        takenAt: number(frame.takenAt),
      }
    case 'location':
      return {
        type: 'location',
        room: text(frame.room),
        floor: text(frame.floor),
        confidence: number(frame.confidence),
      }
    case 'error':
      return { type: 'error', message: text(frame.message) }
    default:
      return undefined
  }
}
