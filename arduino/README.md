# Arduino UNO accelerometer demo

A real accelerometer, everything else simulated. Use this when you want to show
Steady moving with hardware you are holding rather than a generated waveform.

## Wiring

```
accelerometer        Arduino UNO
  VCC   ────────────  3V3
  GND   ────────────  GND
  X     ────────────  A0
  Y     ────────────  A1
  Z     ────────────  A2
```

Works with an ADXL335 module, or any analog 3-axis part with a mid-supply rest
voltage. Nothing else is needed: no Wi-Fi, no battery, no NFC.

## Upload

1. Open `arduino/steady_accel/steady_accel.ino` in the Arduino IDE.
2. Select **Arduino UNO** and the port, then upload.
3. Open the Serial Monitor at **115200 baud** to check the output:

   ```
   I,UNO-ACCEL-1,1.0.0
   M,0.021,-0.004,1.003,1.2,0.4,0.0
   ```

   Lay the board flat: `az` should read close to `1.000` and `ax`/`ay` near `0`.
   If not, adjust `ZERO_G` (and `COUNTS_PER_G` for a different sensor) at the top
   of the sketch until it does.

## Run the demo

```sh
npm run dev          # dashboard + server
```

1. Open the dashboard's **Settings** screen.
2. Choose **Live devices** as the data source.
3. Click **Connect Arduino (USB)** and pick the UNO's port
   (Chrome or Edge — Web Serial is not in Safari or Firefox).
4. The panel should show `UNO-ACCEL-1`, 20 samples/s, and **Accelerometer reads
   gravity** ticked. Tilt the board to see the trace and movement change.
5. Pick a resident and press **Pair**. The browser then sends a one-second
   summary to the server (`/api/readings`), so the resident's room follows the
   real sensor.

## What is real and what is not

| Thing | Source |
| --- | --- |
| Accelerometer x/y/z | **Real**, from the UNO over USB |
| Movement score and trace | **Real**, computed from that sensor |
| Rotation rate (gyro) | Derived from the accelerometer, not a real gyro |
| Heart rate, battery, signal | Dummy values from each resident's profile |
| Other residents | Dummy readings so the wing still looks populated |
| Fall detection | Dummy (simulated `events`, not this sketch) |

The dummy fill is the server's `DEMO_FILL` setting, on by default in the local
store. Turn it off with `DEMO_FILL=0 npm run dev` if you want device mode to show
only what the Arduino is actually sending (unpaired residents then go dark).

The Arduino's device id is `UNO-ACCEL-1`; change it in the sketch if you run
more than one board.

## Troubleshooting

- **No port in the picker** — another program (Serial Monitor, Arduino IDE) may
  hold the port; close it and reconnect.
- **`Connect Arduino (USB)` is disabled** — the browser has no Web Serial. Use
  Chrome or Edge on desktop, or the Wi-Fi/demo options.
- **Values drift or look scaled** — recalibrate `ZERO_G`; the ADC reference and
  sensor supply must match the constants at the top of the sketch.
- **Nothing reaches the dashboard** — check the data source is *Live devices* and
  the board is paired to a resident.
