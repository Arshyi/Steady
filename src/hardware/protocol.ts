// The format the wearable's relay uses to talk to the Settings page over Wi-Fi (a WebSocket on port 8765).
// If you change it, change the relay too: hardware/steady_unoq/python/main.py is the real one,
// server/mock-relay.ts a working stand-in.
//
// Device -> app, one text line per message:
//   I,UNOQ-01,1.4.2          device ID and firmware (reply to "I?")
//   B,87                     battery percent (the UNO Q cannot measure it, so it sends none)
//   M,ax,ay,az,gx,gy,gz      motion sample: accel in g, gyro in degrees per second
//   F                        fall detected
//   O                        a worker confirmed they responded (button press)
//   S,5,9                    a survey capture was stored (scans, access points)
//   L,103,1,82               the backend placed the board in room 103, floor 1, 82% sure
//
// App -> device:
//   I?                       ask for device info
//   I                        blink the light so staff can find the device
//
// The board also posts to the server in server/ on its own: a one-second summary to
// /api/readings, and /api/falls the moment a fall fires. The Settings page only shows
// what the board is doing.

/** Port the relay on the board's Linux side listens on for the dashboard */
export const WIFI_PORT = 8765

export interface MotionSample {
  t: number // ms, from performance.now()
  ax: number
  ay: number
  az: number
  gx: number
  gy: number
  gz: number
}
