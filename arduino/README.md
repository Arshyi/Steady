# Arduino UNO + MPU6050 demo

A real accelerometer and a real gyroscope, everything else simulated. Use this
when you want to show Steady following hardware you are holding rather than a
generated waveform.

## Wiring

```
MPU6050 breakout     Arduino UNO
  VCC   ────────────  5V        (the module has its own 3.3 V regulator)
  GND   ────────────  GND
  SDA   ────────────  A4
  SCL   ────────────  A5
  AD0   ────────────  GND       (selects I2C address 0x68; most boards do this)
```

`XDA`, `XCL` and `INT` are unused. No library is needed: the sketch talks to the
MPU6050's registers over `Wire` directly.

## Upload

1. Open `arduino/steady_mpu6050/steady_mpu6050.ino` in the Arduino IDE.
2. Select **Arduino UNO** and the port, then upload.
3. Open the Serial Monitor at **115200 baud**. You should see:

   ```
   # gyro bias (raw) 12.0 -4.0 7.0
   I,UNO-MPU1,1.1.0
   M,0.021,-0.004,1.003,0.4,-0.2,0.1
   ```

   Leave the board still for the first second after reset — that is when the gyro
   zero-rate offset is measured. The `#` lines are diagnostics and are ignored by
   the dashboard.

4. Lay the board flat: `az` should be close to `1.000`, `ax`/`ay` near `0`, and
   the gyro near `0` when still. If it is not, check the module's orientation and
   the wiring rather than editing constants — the MPU6050 is factory-calibrated.

The sketch uses the ±2 g and ±250 °/s ranges. If you change `REG_ACCEL_CONFIG` or
`REG_GYRO_CONFIG`, update `ACCEL_LSB_PER_G` and `GYRO_LSB_PER_DPS` to match.

## Run the demo

```sh
npm run dev          # dashboard + server
```

1. Open the dashboard's **Settings** screen.
2. Choose **Live devices** as the data source.
3. Click **Connect Arduino (USB)** and pick the UNO's port
   (Chrome or Edge — Web Serial is not in Safari or Firefox).
4. The panel should show `UNO-MPU1`, 20 samples/s, with **Accelerometer reads
   gravity** and (once you turn the board) **Gyroscope responds** ticked.
5. Pick a resident and press **Pair**. The browser then sends a one-second
   summary to the server, so the resident's room follows the real sensor.

Turn, tilt and tap the board to see the trace, movement score and status change.

## What is real and what is not

| Thing | Source |
| --- | --- |
| Accelerometer x/y/z | **Real**, MPU6050 over I2C |
| Gyroscope x/y/z | **Real**, bias-corrected at startup |
| Movement score and trace | **Real**, computed from those sensors |
| Heart rate, battery, signal | Dummy values from each resident's profile |
| Other residents | Dummy readings so the wing still looks populated |
| Fall detection | Dummy (simulated `events`, not this sketch) |

The dummy fill is the server's `DEMO_FILL` setting, on by default in the local
store. Turn it off with `DEMO_FILL=0 npm run dev` if you want device mode to show
only what the Arduino is actually sending (unpaired residents then go dark).

The device id is `UNO-MPU1`; change it in the sketch if you run more than one
board.

## Troubleshooting

- **`# MPU6050 not found at 0x68`** — check VCC/GND and that SDA is on A4 and SCL
  on A5. Some clones need a moment after power-up; the sketch retries every 5 s.
- **Gyro drifts slowly** — the bias calibration ran while the board was moving.
  Reset it and leave it still for a second.
- **No port in the picker** — another program (Serial Monitor, Arduino IDE) may
  hold the port; close it and reconnect.
- **`Connect Arduino (USB)` is disabled** — the browser has no Web Serial. Use
  Chrome or Edge on desktop, or the Wi-Fi/demo options.
- **Nothing reaches the dashboard** — check the data source is *Live devices* and
  the board is paired to a resident.
