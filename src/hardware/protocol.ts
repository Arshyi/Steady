// The format the wearable's relay uses to talk to the Settings page over Wi-Fi (a WebSocket on port 8765).
// If you change it, change the relay too (see server/mock-relay.ts for a working example).
//
// Device -> app, one text line per message:
//   I,UNOQ-01,1.4.2          device ID and firmware (reply to "I?")
//   B,87                     battery percent
//   M,ax,ay,az,gx,gy,gz      motion sample: accel in g, gyro in degrees per second
//   F                        fall detected
//
// App -> device:
//   I?                       ask for device info
//   I                        blink the light so staff can find the device

export interface MotionSample {
  t: number // ms, from performance.now()
  ax: number
  ay: number
  az: number
  gx: number
  gy: number
  gz: number
}
