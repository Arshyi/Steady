// USB serial link to an Arduino UNO.
//
// The sketch in arduino/steady_accel prints the same text lines as the UNO Q
// relay (see protocol.ts), so the only new piece is opening the port and
// feeding lines to the existing parser:
//
//   I,UNO-ACCEL-1,1.0.0
//   M,ax,ay,az,gx,gy,gz
//
// Web Serial is Chrome/Edge only, and needs a secure context (localhost is fine).

import { handleLine, type Connection, type DeviceEvents } from './connection'

const BAUD = 115200

interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>
  close(): Promise<void>
  readable: ReadableStream<Uint8Array> | null
  writable: WritableStream<Uint8Array> | null
}

interface SerialApi {
  requestPort(): Promise<SerialPortLike>
}

function serialApi(): SerialApi | undefined {
  return (navigator as Navigator & { serial?: SerialApi }).serial
}

/** True when this browser can talk to a board over USB */
export function serialSupported() {
  return typeof navigator !== 'undefined' && serialApi() !== undefined
}

/**
 * Ask for a serial port and read lines from it until the board is unplugged or
 * `disconnect()` is called. Device events match the Wi-Fi transport, so the
 * Settings page treats an Arduino like any other wearable.
 */
export async function connectSerial(ev: DeviceEvents): Promise<Connection> {
  const api = serialApi()
  if (!api) throw new Error('This browser cannot use USB serial. Try Chrome or Edge on desktop.')

  let port: SerialPortLike
  try {
    port = await api.requestPort()
  } catch {
    throw new Error('No serial port chosen.')
  }

  try {
    await port.open({ baudRate: BAUD })
  } catch (e) {
    throw new Error(`Could not open the port: ${(e as Error).message}. Close the Arduino IDE's Serial Monitor.`)
  }

  const reader = port.readable?.getReader()
  if (!reader) {
    await port.close().catch(() => {})
    throw new Error('The port opened but has no readable stream.')
  }

  let closed = false
  const decoder = new TextDecoder()
  let buffer = ''

  const pump = async () => {
    try {
      while (!closed) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const raw of lines) {
          const line = raw.trim()
          if (line) handleLine(line, ev)
        }
      }
    } catch {
      // Unplugged mid-read: fall through to the disconnect notification.
    } finally {
      if (!closed) ev.onDisconnect()
    }
  }
  void pump()

  return {
    transport: 'serial',
    // The sketch ignores input, but asking again makes it re-announce the id.
    identify: async () => {
      const writer = port.writable?.getWriter()
      if (!writer) return
      try {
        await writer.write(new TextEncoder().encode('I\n'))
      } catch {
        // The board may already be gone.
      } finally {
        writer.releaseLock()
      }
    },
    disconnect: async () => {
      closed = true
      await reader.cancel().catch(() => {})
      await port.close().catch(() => {})
      ev.onDisconnect()
    },
  }
}
