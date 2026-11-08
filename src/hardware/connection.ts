// Connects to a Steady wearable over Bluetooth, USB, Wi-Fi, or a built-in simulator.
// All of them give the same events, so the Settings page doesn't care which one is used.

import { STEADY_SERVICE, CHAR, CMD_IDENTIFY, SERIAL_BAUD, WIFI_PORT, parseMotion, type MotionSample } from './protocol'

export type Transport = 'bluetooth' | 'usb' | 'wifi' | 'simulated'

/** How a survey capture ended, as reported by the board */
export interface SurveySummary {
  scans?: number
  accessPoints?: number
}

/** The room the backend matched to the board's Wi-Fi fingerprint */
export interface KnownLocation {
  room?: string
  floor?: string
  confidence?: number
}

export interface DeviceEvents {
  onInfo: (id: string, firmware: string) => void
  onBattery: (percent: number) => void
  onMotion: (sample: MotionSample) => void
  onFall: () => void
  onDisconnect: () => void
  /** The wearer pressed the button once: "I'm OK". */
  onOk?: () => void
  /** A staff member tapped an NFC tag on the wearable. */
  onTap?: (tag: string) => void
  /** The board finished a survey capture (three presses). */
  onSurvey?: (summary: SurveySummary) => void
  /** The backend placed the device in a room after a scan. */
  onLocation?: (location: KnownLocation) => void
}

export interface Connection {
  transport: Transport
  identify: () => Promise<void>
  disconnect: () => Promise<void>
}

export const support = {
  bluetooth: typeof navigator !== 'undefined' && 'bluetooth' in navigator,
  usb: typeof navigator !== 'undefined' && 'serial' in navigator,
}

// ---------- Bluetooth ----------

export async function connectBluetooth(ev: DeviceEvents): Promise<Connection> {
  // Opens the browser's device picker, showing only Steady wearables
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [STEADY_SERVICE] }],
    optionalServices: ['battery_service'],
  })
  device.addEventListener('gattserverdisconnected', ev.onDisconnect)

  const server = await device.gatt!.connect()
  const service = await server.getPrimaryService(STEADY_SERVICE)

  const info = await (await service.getCharacteristic(CHAR.info)).readValue()
  const [id, firmware] = new TextDecoder().decode(info).split(';')
  ev.onInfo(id, firmware)

  try {
    const battery = await (await server.getPrimaryService('battery_service')).getCharacteristic('battery_level')
    ev.onBattery((await battery.readValue()).getUint8(0))
    await battery.startNotifications()
    battery.addEventListener('characteristicvaluechanged', (e) =>
      ev.onBattery((e.target as BluetoothRemoteGATTCharacteristic).value!.getUint8(0)),
    )
  } catch {
    // Battery service is optional on the device
  }

  const motion = await service.getCharacteristic(CHAR.motion)
  await motion.startNotifications()
  motion.addEventListener('characteristicvaluechanged', (e) => {
    const value = (e.target as BluetoothRemoteGATTCharacteristic).value!
    ev.onMotion({ t: performance.now(), ...parseMotion(value) })
  })

  const fall = await service.getCharacteristic(CHAR.fall)
  await fall.startNotifications()
  fall.addEventListener('characteristicvaluechanged', (e) => {
    if ((e.target as BluetoothRemoteGATTCharacteristic).value!.getUint8(0) === 1) ev.onFall()
  })

  const command = await service.getCharacteristic(CHAR.command)

  return {
    transport: 'bluetooth',
    identify: () => command.writeValue(new Uint8Array([CMD_IDENTIFY])),
    disconnect: async () => device.gatt?.disconnect(),
  }
}

// ---------- USB serial ----------

export async function connectUsb(ev: DeviceEvents): Promise<Connection> {
  // Opens the browser's port picker
  const port = await navigator.serial.requestPort()
  await port.open({ baudRate: SERIAL_BAUD })

  const encoder = new TextEncoder()
  const send = async (text: string) => {
    const writer = port.writable!.getWriter()
    await writer.write(encoder.encode(text))
    writer.releaseLock()
  }

  const decoder = new TextDecoderStream()
  const closed = port.readable!.pipeTo(decoder.writable as WritableStream<Uint8Array>).catch(() => {})
  const reader = decoder.readable.getReader()
  let stopped = false

  // Read lines until disconnected
  ;(async () => {
    let buffer = ''
    try {
      while (!stopped) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += value
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) handleLine(line.trim(), ev)
      }
    } catch {
      // Port unplugged
    }
    ev.onDisconnect()
  })()

  await send('I?\n') // ask the device to report its info

  return {
    transport: 'usb',
    identify: () => send('I\n'),
    disconnect: async () => {
      stopped = true
      await reader.cancel().catch(() => {})
      await closed
      await port.close().catch(() => {})
    },
  }
}

function handleLine(line: string, ev: DeviceEvents) {
  const parts = line.split(',')
  switch (parts[0]) {
    case 'I':
      if (parts.length >= 3) ev.onInfo(parts[1], parts[2])
      break
    case 'B':
      ev.onBattery(Number(parts[1]))
      break
    case 'M': {
      const [ax, ay, az, gx, gy, gz] = parts.slice(1).map(Number)
      if ([ax, ay, az, gx, gy, gz].every(Number.isFinite)) ev.onMotion({ t: performance.now(), ax, ay, az, gx, gy, gz })
      break
    }
    case 'F':
      ev.onFall()
      break
    case 'O':
      ev.onOk?.()
      break
    case 'T':
      if (parts[1]) ev.onTap?.(parts[1].trim())
      break
    case 'S':
      ev.onSurvey?.({ scans: Number(parts[1]) || undefined, accessPoints: Number(parts[2]) || undefined })
      break
    case 'L':
      if (parts[1]) {
        ev.onLocation?.({
          room: parts[1].trim(),
          floor: parts[2]?.trim() || undefined,
          confidence: Number(parts[3]) || undefined,
        })
      }
      break
  }
}

// ---------- Wi-Fi (UNO Q relay) ----------

/**
 * Connects to the relay running on the board's Linux side over a WebSocket.
 * It speaks the same text lines as USB serial (see protocol.ts): I, M, F, O, T, S, L in;
 * "I?" and "I" out. The board sends its own readings and falls to the server.
 */
export async function connectWifi(address: string, ev: DeviceEvents): Promise<Connection> {
  const host = address.trim().replace(/\/+$/, '')
  const url = /^wss?:\/\//.test(host) ? host : `ws://${host}${/:\d+$/.test(host) ? '' : `:${WIFI_PORT}`}`

  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`No answer from ${url}. Check the board is on and on the same Wi-Fi.`))
    }, 5000)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`Couldn't connect to ${url}. Check the address and that the relay is running.`))
    }
  })

  ws.onmessage = (e) => {
    for (const line of String(e.data).split('\n')) handleLine(line.trim(), ev)
  }
  ws.onclose = () => ev.onDisconnect()
  ws.send('I?\n')

  return {
    transport: 'wifi',
    identify: async () => ws.send('I\n'),
    disconnect: async () => ws.close(),
  }
}

// ---------- Simulator, for trying the page without hardware ----------

export async function connectSimulated(ev: DeviceEvents): Promise<Connection> {
  ev.onInfo('ST-SIM1', '1.4.2')
  ev.onBattery(87)
  const start = performance.now()

  const timer = setInterval(() => {
    const t = performance.now()
    const s = (t - start) / 1000
    // A wrist at rest that sways gently, with a bigger turn every few seconds
    const turn = Math.max(0, Math.sin(s * 0.9)) ** 3
    const noise = () => (Math.random() - 0.5) * 0.02
    ev.onMotion({
      t,
      ax: 0.02 + noise(),
      ay: -0.01 + noise(),
      az: 1 + noise(),
      gx: 25 * Math.sin(s * 1.7) + 140 * turn * Math.sin(s * 5) + noise() * 200,
      gy: 15 * Math.cos(s * 1.3) + 90 * turn * Math.cos(s * 4) + noise() * 200,
      gz: 10 * Math.sin(s * 0.7) + noise() * 200,
    })
  }, 20) // 50 samples a second, like the sketch

  // Simulated fall after 8 seconds so the fall check can pass
  const fallTimer = setTimeout(ev.onFall, 8000)

  // The button, the NFC tap (standing in for a tag until readers are fitted) and a survey
  const okTimer = setInterval(() => ev.onOk?.(), 21_000)
  const tapTimer = setInterval(() => ev.onTap?.('04A2339C1B80'), 27_000)
  const surveyTimer = setInterval(() => ev.onSurvey?.({ scans: 5, accessPoints: 8 }), 41_000)
  const locationTimer = setInterval(() => ev.onLocation?.({ room: '103', floor: '1', confidence: 82 }), 13_000)

  return {
    transport: 'simulated',
    identify: async () => {},
    disconnect: async () => {
      clearInterval(timer)
      clearTimeout(fallTimer)
      clearInterval(okTimer)
      clearInterval(tapTimer)
      clearInterval(surveyTimer)
      clearInterval(locationTimer)
      ev.onDisconnect()
    },
  }
}
