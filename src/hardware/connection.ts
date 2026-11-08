// Connects to a Steady wearable over Bluetooth, USB, the network, or a built-in simulator.
// All of them give the same events, so the Settings page doesn't care which one is used.

import {
  STEADY_SERVICE,
  CHAR,
  CMD_IDENTIFY,
  SERIAL_BAUD,
  parseMotion,
  parseNetworkMessage,
  type MotionSample,
} from './protocol'

export type Transport = 'bluetooth' | 'usb' | 'network' | 'simulated'

/** How a survey capture ended, as reported by the board */
export interface SurveySummary {
  id?: number
  scans?: number
  accessPoints?: number
  takenAt?: number
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
  onOk?: (at: number) => void
  /** A staff member tapped an NFC tag on the wearable. */
  onTap?: (tag: string, at: number) => void
  /** The board finished a survey capture (three presses, or asked from here). */
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
  // The UNO Q serves WebSocket, which no browser lacks
  network: typeof WebSocket !== 'undefined',
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
  }
}

// ---------- Network (Arduino UNO Q over WebSocket) ----------

/**
 * Talks to `hardware/steady_unoq`, which runs on the UNO Q's Linux side and
 * broadcasts the MCU's samples as JSON text frames (see protocol.ts). Same
 * events as the other transports; the board can sit anywhere on the network.
 */
export async function connectNetwork(url: string, ev: DeviceEvents): Promise<Connection> {
  const socket = new WebSocket(url)
  let finished = false

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        socket.close()
        reject(new Error(`No answer from ${url}. Is the UNO Q app running?`))
      }
    }, 6000)

    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error(`Could not connect to ${url}. Check the board's address and that the app is running.`))
      },
      { once: true },
    )
  })

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    const message = parseNetworkMessage(event.data)
    if (!message) return

    switch (message.type) {
      case 'hello':
        ev.onInfo(message.device ?? 'ST-?', message.firmware ?? 'unknown')
        break
      case 'motion':
        ev.onMotion({
          t: performance.now(),
          ax: message.ax,
          ay: message.ay,
          az: message.az,
          gx: message.gx,
          gy: message.gy,
          gz: message.gz,
        })
        break
      case 'fall':
        ev.onFall()
        break
      case 'ok':
        ev.onOk?.(message.t ?? Date.now())
        break
      case 'tap':
        ev.onTap?.(message.tag ?? 'unknown', message.t ?? Date.now())
        break
      case 'survey':
        ev.onSurvey?.(message)
        break
      case 'location':
        ev.onLocation?.(message)
        break
      case 'error':
        break
    }
  })

  socket.addEventListener('close', () => {
    if (finished) return
    finished = true
    ev.onDisconnect()
  })

  return {
    transport: 'network',
    identify: async () => socket.send(JSON.stringify({ type: 'identify' })),
    disconnect: async () => {
      finished = true
      socket.close()
      ev.onDisconnect()
    },
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

  // The button and NFC paths, so the survey panel can be exercised without a board
  const okTimer = setInterval(() => ev.onOk?.(Date.now()), 21_000)
  const tapTimer = setInterval(() => ev.onTap?.('04A2339C1B80', Date.now()), 27_000)
  const surveyTimer = setInterval(() => ev.onSurvey?.({ scans: 5, accessPoints: 8 }), 41_000)
  // The network transport learns the room from the backend; here it is faked.
  const locationTimer = setInterval(
    () => ev.onLocation?.({ room: '103', floor: '1', confidence: 82 }),
    13_000,
  )

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
