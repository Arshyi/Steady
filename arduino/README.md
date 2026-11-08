# Arduino UNO + MPU6050 demo

A real accelerometer and a real gyroscope, everything else simulated. Use this
when you want to show Steady following hardware you are holding rather than a
generated waveform.

## Wiring

```
MPU6050 breakout     Arduino UNO / UNO Q
  VCC   ────────────  5V        (the module has its own 3.3 V regulator)
  GND   ────────────  GND
  SDA   ────────────  A4
  SCL   ────────────  A5
  AD0   ────────────  GND       (selects I2C address 0x68; most boards do this)
```

`XDA`, `XCL` and `INT` are unused. No library is needed: the sketch talks to the
MPU6050's registers over `Wire` directly.

On the **UNO Q**, the pins labelled SDA/SCL are D20/D21 (plain `Wire`) and A4/A5
are a second bus (`Wire2`). The sketch probes both and uses whichever answers at
0x68, so either wiring works. Power the module from **3V3** there rather than 5V:
the header's I2C lines are 3.3 V and most breakouts pull SDA/SCL up to VCC.
Select **Arduino UNO Q** as the board — that core needs the `Arduino_RouterBridge`
library from the Library Manager, and `Serial` reaches the same COM port through
the board's Linux side.

## Upload

1. Open `arduino/steady_mpu6050/steady_mpu6050.ino` in the Arduino IDE.
2. Select **Arduino UNO** (or **Arduino UNO Q**) and the port, then upload.
3. Open the Serial Monitor at **115200 baud**. You should see:

   ```
   # gyro bias (raw) 12.0 -4.0 7.0
   I,UNO-MPU1,1.2.0
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
3. Click **Connect Arduino (USB)** and pick the board's port (on the UNO Q it
   appears as `USB Serial Device (COM4)`).
   (Chrome or Edge — Web Serial is not in Safari or Firefox).
4. The panel should show `UNO-MPU1`, about 40 samples/s (the sketch asks for 50; the
   board's serial bridge adds a few milliseconds per line), with **Accelerometer reads
   gravity** and (once you turn the board) **Gyroscope responds** ticked.
5. Pick a resident and press **Pair**. The browser then sends a one-second
   summary to the server, so the resident's room follows the real sensor.

Turn, tilt and tap the board to see the trace, movement score and status change.

## Fall detection

The board decides for itself whether a drop was a fall. Three things have to
happen in order within about a second: the sensor goes weightless (`|a|` under
0.60 g) and then takes a hard impact (over 1.8 g). A real fall usually ends with
the body lying at least 40° from the way it was held, which raises confidence and
is reported as the posture change; a landing harder than 3 g counts on its own,
so a board dropped flat still raises an alert.

On a fall it prints one line, which the dashboard turns into the alert text:

```
F,6.0,82,88        peak g, posture change in degrees, confidence
```

The sensor is read at 200 Hz for detection and printed at about 40 Hz, because a
landing spike lasts only a few tens of milliseconds and the serial link cannot see
that often. `# weightless` and `# impact … g` lines appear in the Serial Monitor
while tuning.

`FALL_COOLDOWN_MS` stops a single drop from firing again and again. The
thresholds are where tuning starts, not where it ends: test with deliberate
drops onto a mat before showing anyone a fall alert, and note that a fall only
reaches the dashboard when the device is paired to a resident.

## What is real and what is not

| Thing | Source |
| --- | --- |
| Accelerometer x/y/z | **Real**, MPU6050 over I2C |
| Gyroscope x/y/z | **Real**, bias-corrected at startup |
| Movement score and trace | **Real**, computed from those sensors |
| Heart rate, battery, signal | Dummy values from each resident's profile |
| Other residents | Dummy readings so the wing still looks populated |
| Fall detection | **Real**, threshold on the board (free fall → impact → posture change) |

The dummy fill is the server's `DEMO_FILL` setting, on by default in the local
store. Turn it off with `DEMO_FILL=0 npm run dev` if you want device mode to show
only what the Arduino is actually sending (unpaired residents then go dark).

The device id is `UNO-MPU1`; change it in the sketch if you run more than one
board.

## Troubleshooting

- **`# MPU6050 not found at 0x68`** — check VCC/GND and that SDA is on A4 and SCL
  on A5. Some clones need a moment after power-up; the sketch retries every 5 s.
  On the UNO Q this means it did not answer on either header bus (SDA/SCL or
  A4/A5); both empty points at power, swapped SDA/SCL, or a loose jumper.
- **Gyro drifts slowly** — the bias calibration ran while the board was moving.
  Reset it and leave it still for a second.
- **No port in the picker** — another program (Serial Monitor, Arduino IDE) may
  hold the port; close it and reconnect.
- **`Connect Arduino (USB)` is disabled** — the browser has no Web Serial. Use
  Chrome or Edge on desktop, or the Wi-Fi/demo options.
- **Nothing reaches the dashboard** — check the data source is *Live devices* and
  the board is paired to a resident.
