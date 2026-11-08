// Steady — Arduino UNO + MPU6050 demo.
//
// Talks to the MPU6050 over I2C directly (no library to install) and prints the
// same text lines the UNO Q relay uses, so the dashboard reads it over USB:
//
//   I,UNO-MPU1,1.2.0           device id and firmware, every 2 s
//   M,ax,ay,az,gx,gy,gz        accel in g, gyro in deg/s — both real
//
// Wiring (MPU6050 breakout, AD0 tied low so the address is 0x68):
//
//   VCC -> 5V      GND -> GND
//   SDA -> A4      SCL -> A5
//   AD0 -> GND     (optional; most boards pull it low already)
//
// Keep the board still for the first second after reset: the sketch measures
// the gyro's zero-rate offset then. Ranges are ±2 g and ±250 °/s, which is what
// the dashboard expects; change ACCEL_LSB_PER_G / GYRO_LSB_PER_DPS if you edit
// the configuration registers.
//
// The MPU6050 is real, and so is fall detection: the board watches for
// weightlessness, then a hard impact, then a change of posture (checkFall()).
// Heart rate, battery and signal stay simulated on the server.

#include <Wire.h>

// Which I2C bus the MPU6050 sits on.
//   UNO Q: the pins labelled SDA/SCL are D20/D21 (plain Wire); A4/A5 are the
//          board's third bus (Wire2). beginSensor() probes both and keeps the one
//          that answers at 0x68, so either wiring works.
//   Classic UNO R3 / UNO WiFi Rev2: A4/A5 are the only bus.
#if defined(ARDUINO_ARCH_ZEPHYR)
static TwoWire *bus = &Wire;
static TwoWire *const altBus = &Wire2;
#else
static TwoWire *bus = &Wire;
static TwoWire *const altBus = nullptr;
#endif

const uint8_t MPU_ADDR = 0x68;
const uint8_t REG_CONFIG = 0x1A;
const uint8_t REG_GYRO_CONFIG = 0x1B;
const uint8_t REG_ACCEL_CONFIG = 0x1C;
const uint8_t REG_ACCEL_XOUT_H = 0x3B;
const uint8_t REG_PWR_MGMT_1 = 0x6B;
const uint8_t REG_WHO_AM_I = 0x75;

// ±2 g and ±250 °/s, the chip's default full-scale ranges
const float ACCEL_LSB_PER_G = 16384.0;
const float GYRO_LSB_PER_DPS = 131.0;

const unsigned long SAMPLE_MS = 20;   // how often an M line is printed
const unsigned long DETECT_MS = 5;    // how often the sensor is read for fall detection
                                      // A landing spike lasts a few tens of ms, so it has
                                      // to be sampled far faster than the serial link.
const unsigned long INFO_MS = 2000;  // re-announce the device so the page can (re)connect
const uint16_t GYRO_SAMPLES = 200;   // zero-rate calibration at startup

float gyroBiasX = 0;
float gyroBiasY = 0;
float gyroBiasZ = 0;
bool ready = false;

// ---- Fall detection -------------------------------------------------------
// A drop is weightlessness followed by a hard impact. A real fall usually ends
// with the body lying at a different angle too, so a big posture change counts
// as a confirmation, but a board dropped flat lands without one: a very hard
// impact is enough on its own. The thresholds are a starting point; tune them
// against real drops.
const float FREEFALL_G = 0.60;         // |a| below this means nothing is holding it up
const float IMPACT_G = 1.8;            // spike when it lands
const unsigned long IMPACT_WINDOW_MS = 1200;
const unsigned long SETTLE_MS = 250;   // let the landing bounce die down
const float TILT_DELTA_MIN = 40.0;     // degrees of posture change
const float HARD_IMPACT_G = 3.0;       // a landing this hard counts even if it lands flat
const unsigned long FALL_COOLDOWN_MS = 5000;

bool inAir = false;
bool landing = false;
unsigned long airAt = 0;
unsigned long impactAt = 0;
unsigned long lastFall = 0;
float peakG = 0;
float uprightX = 0, uprightY = 0, uprightZ = 1;  // gravity while it is still supported
float preX = 0, preY = 0, preZ = 1;              // gravity just before the drop

static float norm3(float x, float y, float z) { return sqrtf(x * x + y * y + z * z); }

/** Angle in degrees between two gravity vectors */
static float tiltBetween(float ax, float ay, float az, float bx, float by, float bz) {
  const float na = norm3(ax, ay, az);
  const float nb = norm3(bx, by, bz);
  if (na < 0.3f || nb < 0.3f) return 0;
  float c = (ax * bx + ay * by + az * bz) / (na * nb);
  if (c > 1.0f) c = 1.0f;
  if (c < -1.0f) c = -1.0f;
  return acosf(c) * 180.0f / PI;
}

static void reportFall(float peak, float tilt) {
  lastFall = millis();
  int confidence = 55 + (int)((peak - IMPACT_G) * 12.0f) + (int)((tilt - TILT_DELTA_MIN) * 0.6f);
  if (confidence > 98) confidence = 98;
  if (confidence < 60) confidence = 60;
  Serial.print(F("F,"));
  Serial.print(peak, 1);
  Serial.print(',');
  Serial.print(tilt, 0);
  Serial.print(',');
  Serial.println(confidence);
}

static void checkFall(float ax, float ay, float az) {
  const unsigned long now = millis();
  const float g = norm3(ax, ay, az);

  if (now - lastFall < FALL_COOLDOWN_MS) return;

  if (!inAir && !landing) {
    if (g < FREEFALL_G) {
      inAir = true;
      airAt = now;
      peakG = 0;
      preX = uprightX; preY = uprightY; preZ = uprightZ;
      Serial.println(F("# weightless"));
    } else if (g > 0.7f) {
      uprightX = ax; uprightY = ay; uprightZ = az;
    }
    return;
  }

  if (inAir) {
    if (g > peakG) peakG = g;
    if (g > IMPACT_G && now - airAt <= IMPACT_WINDOW_MS) {
      inAir = false;
      landing = true;
      impactAt = now;
      Serial.print(F("# impact "));
      Serial.print(g, 1);
      Serial.println(F(" g"));
    } else if (now - airAt > IMPACT_WINDOW_MS) {
      inAir = false;  // a fast gesture, not a drop
    }
    return;
  }

  if (landing && now - impactAt >= SETTLE_MS) {
    landing = false;
    const float delta = tiltBetween(preX, preY, preZ, ax, ay, az);
    if (delta >= TILT_DELTA_MIN || peakG >= HARD_IMPACT_G) reportFall(peakG, delta);
  }
}

void writeRegister(uint8_t reg, uint8_t value) {
  bus->beginTransmission(MPU_ADDR);
  bus->write(reg);
  bus->write(value);
  bus->endTransmission();
}

uint8_t readRegister(uint8_t reg) {
  bus->beginTransmission(MPU_ADDR);
  bus->write(reg);
  if (bus->endTransmission(false) != 0) return 0;
  if (bus->requestFrom(MPU_ADDR, (uint8_t)1) != 1) return 0;
  return bus->read();
}

/** Reads accel, temperature and gyro in one burst. Returns false if the bus failed. */
bool readMotion(int16_t &ax, int16_t &ay, int16_t &az, int16_t &gx, int16_t &gy, int16_t &gz) {
  bus->beginTransmission(MPU_ADDR);
  bus->write(REG_ACCEL_XOUT_H);
  if (bus->endTransmission(false) != 0) return false;
  if (bus->requestFrom(MPU_ADDR, (uint8_t)14) != 14) return false;

  ax = (int16_t)((bus->read() << 8) | bus->read());
  ay = (int16_t)((bus->read() << 8) | bus->read());
  az = (int16_t)((bus->read() << 8) | bus->read());
  (void)((bus->read() << 8) | bus->read());  // temperature, not used
  gx = (int16_t)((bus->read() << 8) | bus->read());
  gy = (int16_t)((bus->read() << 8) | bus->read());
  gz = (int16_t)((bus->read() << 8) | bus->read());
  return true;
}

void calibrateGyro() {
  int32_t sx = 0, sy = 0, sz = 0;
  uint16_t counted = 0;
  for (uint16_t i = 0; i < GYRO_SAMPLES; i++) {
    int16_t ax, ay, az, gx, gy, gz;
    if (readMotion(ax, ay, az, gx, gy, gz)) {
      sx += gx;
      sy += gy;
      sz += gz;
      counted++;
    }
    delay(5);
  }
  if (!counted) return;
  gyroBiasX = (float)sx / counted;
  gyroBiasY = (float)sy / counted;
  gyroBiasZ = (float)sz / counted;
  Serial.print(F("# gyro bias (raw) "));
  Serial.print(gyroBiasX, 1);
  Serial.print(' ');
  Serial.print(gyroBiasY, 1);
  Serial.print(' ');
  Serial.println(gyroBiasZ, 1);
}

static bool probeBus(TwoWire *w) {
  w->begin();
  w->setClock(400000);
  w->beginTransmission(MPU_ADDR);
  if (w->endTransmission() != 0) return false;
  return readRegister(REG_WHO_AM_I) == 0x68;
}

bool beginSensor() {
  bus = &Wire;
  bool found = probeBus(bus);
  if (!found && altBus) {
    bus = altBus;
    found = probeBus(bus);
  }
  if (!found) {
    bus = &Wire;
    return false;
  }
  Serial.println(bus == altBus ? F("# MPU6050 on A4/A5 (Wire2)") : F("# MPU6050 on SDA/SCL (Wire)"));

  writeRegister(REG_PWR_MGMT_1, 0x00);  // wake up
  delay(50);
  writeRegister(REG_CONFIG, 0x03);       // 44 Hz digital low-pass filter
  writeRegister(REG_GYRO_CONFIG, 0x00);  // ±250 °/s
  writeRegister(REG_ACCEL_CONFIG, 0x00); // ±2 g
  delay(20);
  calibrateGyro();
  return true;
}

void announce() {
  Serial.println(F("I,UNO-MPU1,1.2.0"));
}

void setup() {
  Serial.begin(115200);
  unsigned long started = millis();
  while (!Serial && millis() - started < 2000) {
    // wait for USB, harmless when nothing is listening
  }

  ready = beginSensor();
  if (!ready) {
    // Lines starting with '#' are ignored by the dashboard's parser
    Serial.println(F("# MPU6050 not found at 0x68. Check VCC/GND and the SDA/SCL wiring."));
  }
  announce();
}

void loop() {
  static unsigned long lastSample = 0;
  static unsigned long lastRead = 0;
  static unsigned long lastInfo = 0;
  static unsigned long lastRetry = 0;
  const unsigned long now = millis();

  if (!ready && now - lastRetry >= 5000) {
    lastRetry = now;
    ready = beginSensor();
    if (ready) {
      Serial.println(F("# MPU6050 connected"));
      announce();
    }
  }

  if (now - lastInfo >= INFO_MS) {
    announce();
    lastInfo = now;
  }

  if (now - lastRead < DETECT_MS) return;
  lastRead = now;

  int16_t rax, ray, raz, rgx, rgy, rgz;
  if (!readMotion(rax, ray, raz, rgx, rgy, rgz)) return;

  const float ax = rax / ACCEL_LSB_PER_G;
  const float ay = ray / ACCEL_LSB_PER_G;
  const float az = raz / ACCEL_LSB_PER_G;
  const float gx = (rgx - gyroBiasX) / GYRO_LSB_PER_DPS;
  const float gy = (rgy - gyroBiasY) / GYRO_LSB_PER_DPS;
  const float gz = (rgz - gyroBiasZ) / GYRO_LSB_PER_DPS;

  // Detection runs on every read; printing stays at the dashboard's rate.
  checkFall(ax, ay, az);

  if (now - lastSample < SAMPLE_MS) return;
  lastSample = now;

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
  Serial.print(',');
  Serial.print(gz, 1);
  Serial.println();
}
