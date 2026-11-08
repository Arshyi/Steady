// Steady — Arduino UNO accelerometer demo.
//
// Reads a 3-axis analog accelerometer and prints the same text lines the UNO Q
// relay uses, so the dashboard can read it straight over USB with Web Serial:
//
//   I,UNO-ACCEL-1,1.0.0        device id and firmware, every 2 s
//   M,ax,ay,az,gx,gy,gz        accel in g, rotation rate in deg/s (derived)
//
// Wiring, with the accelerometer powered from the UNO's 3.3V pin:
//
//   VCC -> 3V3      GND -> GND
//   X   -> A0       Y   -> A1       Z  -> A2
//
// This works for an ADXL335 module, or any analog 3-axis part that outputs a
// voltage around mid-supply at rest. If your board is 5V-only (e.g. an analog
// ADXL335 breakout fed from 5V), change VREF and re-calibrate ZERO_G below.
//
// Only the accelerometer is real. The gyro numbers are derived by differentiating
// the gravity vector, which is enough for the dashboard's movement trace and its
// "gyroscope responds" check. Heart rate, battery, signal and fall detection stay
// simulated on the server — this sketch never claims a fall.

const uint8_t PIN_X = A0;
const uint8_t PIN_Y = A1;
const uint8_t PIN_Z = A2;

// Calibration. With the sensor on 3.3 V and the ADC on its 5 V reference:
//   zero g sits at 1.65 V  -> 512 counts
//   sensitivity 330 mV/g   -> 67.5 counts per g
// Hold the board still, open the Serial Monitor and nudge ZERO_G until the
// printed ax/ay/az are near 0, 0, 1.
const float ZERO_G = 512.0;
const float COUNTS_PER_G = 67.5;

const unsigned long SAMPLE_MS = 50;   // 20 Hz, the rate the settings page expects
const unsigned long INFO_MS = 2000;   // re-announce the device so the page can (re)connect
const float GYRO_LIMIT = 400.0;       // deg/s, keeps noise from looking like a spin

float previousAx = 0;
float previousAy = 0;
bool havePrevious = false;

void announce() {
  Serial.println(F("I,UNO-ACCEL-1,1.0.0"));
}

void setup() {
  Serial.begin(115200);
  // Wait briefly for the USB port to come up; harmless when nothing is listening.
  unsigned long started = millis();
  while (!Serial && millis() - started < 2000) {
    // spin
  }
  announce();
}

void loop() {
  static unsigned long lastSample = 0;
  static unsigned long lastInfo = 0;
  const unsigned long now = millis();

  if (now - lastInfo >= INFO_MS) {
    announce();
    lastInfo = now;
  }

  if (now - lastSample < SAMPLE_MS) return;

  float dt = (now - lastSample) / 1000.0;
  lastSample = now;
  if (dt <= 0 || dt > 1) dt = SAMPLE_MS / 1000.0;

  const float ax = (analogRead(PIN_X) - ZERO_G) / COUNTS_PER_G;
  const float ay = (analogRead(PIN_Y) - ZERO_G) / COUNTS_PER_G;
  const float az = (analogRead(PIN_Z) - ZERO_G) / COUNTS_PER_G;

  // Small-angle approximation: a 1 g change per second is about 57.3 deg/s.
  float gx = 0;
  float gy = 0;
  if (havePrevious && dt > 0) {
    gx = constrain((ay - previousAy) * 57.3 / dt, -GYRO_LIMIT, GYRO_LIMIT);
    gy = constrain(-(ax - previousAx) * 57.3 / dt, -GYRO_LIMIT, GYRO_LIMIT);
  }
  previousAx = ax;
  previousAy = ay;
  havePrevious = true;

  Serial.print(F("M,"));
  Serial.print(ax, 3);
  Serial.print(',');
  Serial.print(ay, 3);
  Serial.print(',');
  Serial.print(az, 3);
  Serial.print(',');
  Serial.print(gx, 1);
  Serial.print(',');
  Serial.print(gy, 1);
  Serial.print(F(",0.0"));
  Serial.println();
}
