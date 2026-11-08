// Steady — Arduino UNO + MPU6050 demo.
//
// Talks to the MPU6050 over I2C directly (no library to install) and prints the
// same text lines the UNO Q relay uses, so the dashboard reads it over USB:
//
//   I,UNO-MPU1,1.1.0           device id and firmware, every 2 s
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
// Only the MPU6050 is real. Heart rate, battery, signal and fall detection stay
// simulated on the server — this sketch never claims a fall.

#include <Wire.h>

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

const unsigned long SAMPLE_MS = 50;  // 20 Hz, the rate the settings page expects
const unsigned long INFO_MS = 2000;  // re-announce the device so the page can (re)connect
const uint16_t GYRO_SAMPLES = 200;   // zero-rate calibration at startup

float gyroBiasX = 0;
float gyroBiasY = 0;
float gyroBiasZ = 0;
bool ready = false;

void writeRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
}

uint8_t readRegister(uint8_t reg) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return 0;
  if (Wire.requestFrom(MPU_ADDR, (uint8_t)1) != 1) return 0;
  return Wire.read();
}

/** Reads accel, temperature and gyro in one burst. Returns false if the bus failed. */
bool readMotion(int16_t &ax, int16_t &ay, int16_t &az, int16_t &gx, int16_t &gy, int16_t &gz) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(REG_ACCEL_XOUT_H);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU_ADDR, (uint8_t)14) != 14) return false;

  ax = (int16_t)((Wire.read() << 8) | Wire.read());
  ay = (int16_t)((Wire.read() << 8) | Wire.read());
  az = (int16_t)((Wire.read() << 8) | Wire.read());
  (void)((Wire.read() << 8) | Wire.read());  // temperature, not used
  gx = (int16_t)((Wire.read() << 8) | Wire.read());
  gy = (int16_t)((Wire.read() << 8) | Wire.read());
  gz = (int16_t)((Wire.read() << 8) | Wire.read());
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

bool beginSensor() {
  Wire.begin();
  Wire.setClock(400000);
  Wire.beginTransmission(MPU_ADDR);
  if (Wire.endTransmission() != 0) return false;
  if (readRegister(REG_WHO_AM_I) != 0x68) return false;

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
  Serial.println(F("I,UNO-MPU1,1.1.0"));
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
    Serial.println(F("# MPU6050 not found at 0x68. Check VCC/GND/SDA(A4)/SCL(A5)."));
  }
  announce();
}

void loop() {
  static unsigned long lastSample = 0;
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

  if (now - lastSample < SAMPLE_MS) return;
  lastSample = now;

  int16_t rax, ray, raz, rgx, rgy, rgz;
  if (!readMotion(rax, ray, raz, rgx, rgy, rgz)) return;

  const float ax = rax / ACCEL_LSB_PER_G;
  const float ay = ray / ACCEL_LSB_PER_G;
  const float az = raz / ACCEL_LSB_PER_G;
  const float gx = (rgx - gyroBiasX) / GYRO_LSB_PER_DPS;
  const float gy = (rgy - gyroBiasY) / GYRO_LSB_PER_DPS;
  const float gz = (rgz - gyroBiasZ) / GYRO_LSB_PER_DPS;

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
