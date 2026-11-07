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
