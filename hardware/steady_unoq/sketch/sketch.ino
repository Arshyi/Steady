// Steady wearable — Arduino UNO Q (STM32U585, Zephyr core)
//
// Reads an MPU6050 (accelerometer + gyroscope over I2C) 50 times a second, looks
// for the free-fall-then-impact pattern of a fall, and hands everything to the
// Linux side over the Bridge. `python/main.py` serves those samples to the
// dashboard over WebSocket; the data contract lives in src/hardware/protocol.ts
// and README.md.
//
// Controls on the wearable:
//   * one press of the button      → "Worker responded", resolves an open fall on the dashboard
//   * three presses within ~1.5 s  → SURVEY MODE: the Linux side scans Wi-Fi and
//                                    uploads a fingerprint for the room
// The button is the only input, so the gesture is decided after a short pause
// rather than on key-up: a single press cannot be reported until the code knows
// two more are not coming.
//
// Wiring: MPU6050 SDA→A4, SCL→A5, VCC→3V3, GND→GND (address 0x68 with AD0 low,
// 0x69 with AD0 high — both are tried). The button sits across D2 and D4: D4 is
// held low and D2 is pulled up, so a press reads LOW without a GND wire.
//
// This replaces hardware/steady_wearable (Nano 33 BLE): the UNO Q has no BLE
// radio visible to the sketch, and no onboard IMU.

#include "Arduino_RouterBridge.h"
#include <Wire.h>
#include "fall_detector.h"

// ---- identity -------------------------------------------------------------
// Give every device its own ID before flashing; the dashboard pairs on it.
static const char* DEVICE_ID = "ST-UNOQ1";
static const char* FIRMWARE = "1.2.1";

// ---- sampling -------------------------------------------------------------
static constexpr uint32_t SAMPLE_HZ = 50;
static constexpr uint32_t SAMPLE_MS = 1000 / SAMPLE_HZ;
// Falls are checked far more often than samples are sent: a landing spike lasts
// only a few tens of milliseconds, so 50 Hz can miss it.
static constexpr uint32_t DETECT_MS = 5;

// ---- MPU6050 (I2C) --------------------------------------------------------
// Which I2C bus the MPU6050 is on. On the UNO Q the pins labelled SDA/SCL are
// D20/D21 (plain Wire), while A4/A5 are the board's third bus (Wire2), so both
// are probed and the one that answers is kept. On older boards there is only one.
#if defined(ARDUINO_ARCH_ZEPHYR)
static TwoWire *imuBus = &Wire;
static TwoWire *const imuAltBus = &Wire2;
#else
static TwoWire *imuBus = &Wire;
static TwoWire *const imuAltBus = nullptr;
#endif
// Registers are only the ones this sketch touches.
static constexpr uint8_t IMU_REG_CONFIG = 0x1A;
static constexpr uint8_t IMU_REG_SMPLRT_DIV = 0x19;
static constexpr uint8_t IMU_REG_GYRO_CONFIG = 0x1B;
static constexpr uint8_t IMU_REG_ACCEL_CONFIG = 0x1C;
static constexpr uint8_t IMU_REG_ACCEL_XOUT_H = 0x3B;
static constexpr uint8_t IMU_REG_PWR_MGMT_1 = 0x6B;
static constexpr uint8_t IMU_REG_WHO_AM_I = 0x75;
static constexpr uint8_t IMU_ADDRESSES[] = {0x68, 0x69};
// ±8 g: at ±2 g every axis tops out at 2 g, below the 2.6 g / 3.5 g impact
// thresholds, so most landings could never register as a fall.
static constexpr float ACCEL_LSB_PER_G = 4096.0f;    // ±8 g
static constexpr float GYRO_LSB_PER_DPS = 65.5f;     // ±500 °/s

// ---- fall detection: see fall_detector.h (the USB sketch's rules, tested with drops)
FallDetector fallDetector;

// ---- button gestures ------------------------------------------------------
// The button sits across D2 and D4. D4 is driven low and D2 held high through its
// pull-up, so a press shorts the two and reads LOW on D2. Wiring D2 to GND instead
// also works: D4 then simply idles low and the press pulls D2 to ground either way.
static constexpr uint8_t BUTTON_PIN = 2;
static constexpr uint8_t BUTTON_COMMON_PIN = 4;
static constexpr uint32_t BUTTON_DEBOUNCE_MS = 25;
static constexpr uint32_t GESTURE_GAP_MS = 650;    // quiet time that ends a gesture
static constexpr uint32_t GESTURE_WINDOW_MS = 2500; // presses must fit in this
static constexpr uint8_t SURVEY_PRESSES = 3;

static constexpr uint8_t IDENTIFY_BLINKS = 3;
static constexpr uint8_t OK_BLINKS = 1;
static constexpr uint8_t SURVEY_BLINKS = 4;
static constexpr uint32_t BLINK_MS = 120;

bool imuPresent = false;
uint8_t imuAddress = IMU_ADDRESSES[0];
uint32_t nextImuRetry = 0;

uint32_t lastSampleMs = 0;
uint32_t lastDetectMs = 0;

// Button gesture state machine. `gestureOpen` stays true while presses are still
// arriving; `GESTURE_GAP_MS` after the last one the gesture is decided.
bool buttonDown = false;
uint32_t buttonChangedMs = 0;
bool gestureOpen = false;
uint32_t firstPressMs = 0;
uint32_t lastPressMs = 0;
uint8_t pressCount = 0;

uint8_t blinksLeft = 0;
uint32_t lastBlinkMs = 0;
bool ledLit = false;

// ---- Bridge functions the Linux side can call -----------------------------

/** "<deviceId>;<firmware>", e.g. "ST-UNOQ1;1.2.1" */
String steadyInfo() {
  return String(DEVICE_ID) + ";" + FIRMWARE;
}

/** Blink the onboard LED so staff can find the device in a drawer. */
bool steadyIdentify() {
  blinksLeft = IDENTIFY_BLINKS * 2;  // on and off for each blink
  lastBlinkMs = millis();
  return true;
}

// ---- MPU6050 helpers ------------------------------------------------------

bool imuWrite(uint8_t reg, uint8_t value) {
  imuBus->beginTransmission(imuAddress);
  imuBus->write(reg);
  imuBus->write(value);
  return imuBus->endTransmission() == 0;
}

bool imuRead(uint8_t reg, uint8_t* buf, uint8_t len) {
  imuBus->beginTransmission(imuAddress);
  imuBus->write(reg);
  if (imuBus->endTransmission(false) != 0) return false;
  if (imuBus->requestFrom(imuAddress, len) != len) return false;
  for (uint8_t i = 0; i < len; i++) {
    if (imuBus->available() == 0) return false;
    buf[i] = (uint8_t)imuBus->read();
  }
  return true;
}

int16_t be16(const uint8_t* p) {
  return (int16_t)(((uint16_t)p[0] << 8) | p[1]);
}

bool startImu() {
  TwoWire* buses[2] = {&Wire, imuAltBus};

  for (uint8_t a = 0; a < sizeof(IMU_ADDRESSES); a++) {
    for (uint8_t b = 0; b < 2; b++) {
      if (buses[b] == nullptr) continue;
      imuAddress = IMU_ADDRESSES[a];
      imuBus = buses[b];

      imuBus->begin();
      imuBus->setClock(400000);
      imuBus->beginTransmission(imuAddress);
      if (imuBus->endTransmission() != 0) continue;

      uint8_t who = 0;
      if (!imuRead(IMU_REG_WHO_AM_I, &who, 1)) continue;
      // 0x98 and 0x72 are clones that behave like an MPU6050 for these registers
      if (who != 0x68 && who != 0x98 && who != 0x72) continue;

      // Reset, then wake on the X-gyro PLL
      if (!imuWrite(IMU_REG_PWR_MGMT_1, 0x80)) continue;
      delay(100);
      if (!imuWrite(IMU_REG_PWR_MGMT_1, 0x01)) continue;

      imuWrite(IMU_REG_SMPLRT_DIV, 4);      // 1 kHz base rate / 5 = 200 Hz, for fall detection
      imuWrite(IMU_REG_CONFIG, 0x03);       // DLPF, ~44 Hz accelerometer bandwidth
      imuWrite(IMU_REG_GYRO_CONFIG, 0x08);  // +/-500 deg/s
      imuWrite(IMU_REG_ACCEL_CONFIG, 0x10); // +/-8 g (AFS_SEL=2), matches ACCEL_LSB_PER_G

      Monitor.print("[steady] MPU6050 online at 0x");
      Monitor.print(imuAddress, HEX);
      Monitor.print(" on ");
      Monitor.print(imuBus == imuAltBus ? "A4/A5 (Wire2)" : "SDA/SCL (Wire)");
      Monitor.print(", WHO_AM_I 0x");
      Monitor.println(who, HEX);
      return true;
    }
  }

  Monitor.println("[steady] no MPU6050 on A4/A5 or SDA/SCL (0x68/0x69), retrying");
  return false;
}

bool readImu(float& ax, float& ay, float& az, float& gx, float& gy, float& gz) {
  uint8_t buf[14];
  if (!imuRead(IMU_REG_ACCEL_XOUT_H, buf, sizeof(buf))) return false;

  ax = be16(&buf[0]) / ACCEL_LSB_PER_G;
  ay = be16(&buf[2]) / ACCEL_LSB_PER_G;
  az = be16(&buf[4]) / ACCEL_LSB_PER_G;
  // buf[6..7] is die temperature; not needed for fall detection
  gx = be16(&buf[8]) / GYRO_LSB_PER_DPS;
  gy = be16(&buf[10]) / GYRO_LSB_PER_DPS;
  gz = be16(&buf[12]) / GYRO_LSB_PER_DPS;
  return true;
}

// ---- helpers --------------------------------------------------------------

void blink(uint8_t times) {
  blinksLeft = times * 2;
  lastBlinkMs = millis();
}

void updateLed(uint32_t now) {
  if (blinksLeft == 0) return;
  if (now - lastBlinkMs < BLINK_MS) return;

  lastBlinkMs = now;
  ledLit = !ledLit;
  // LED_BUILTIN on the UNO Q is active LOW
  digitalWrite(LED_BUILTIN, ledLit ? LOW : HIGH);
  blinksLeft--;
  if (blinksLeft == 0) digitalWrite(LED_BUILTIN, HIGH);
}

void publishSample(uint32_t now, float ax, float ay, float az, float gx, float gy, float gz) {
  // One compact line: the Bridge caps a message at 256 bytes, and at 50 Hz the
  // link is the bottleneck, so keep it as short as it stays readable.
  char line[80];
  snprintf(line, sizeof line, "%lu,%.3f,%.3f,%.3f,%.1f,%.1f,%.1f", (unsigned long)now, ax, ay, az, gx, gy, gz);
  Bridge.call("steady_motion", String(line));
}

/**
 * Decides what a finished gesture meant. Called once the button has been quiet
 * for GESTURE_GAP_MS, which is why a single confirmation press takes ~0.7 s to send.
 */
void emitGesture(uint8_t presses, uint32_t now) {
  char line[24];
  snprintf(line, sizeof line, "%lu,%u", (unsigned long)now, presses);

  if (presses >= SURVEY_PRESSES) {
    Bridge.call("steady_survey", String(line));
    blink(SURVEY_BLINKS);
    Monitor.println("[steady] survey requested");
  } else if (presses == 1) {
    Bridge.call("steady_ok", String(line));
    blink(OK_BLINKS);
    Monitor.println("[steady] worker responded");
  }
  // Two presses is almost always a fumbled double tap; ignore it rather than
  // acknowledge something the wearer did not mean.
}

void updateButton(uint32_t now) {
  const bool pressed = digitalRead(BUTTON_PIN) == LOW;

  if (pressed != buttonDown) {
    if (now - buttonChangedMs < BUTTON_DEBOUNCE_MS) return;
    buttonChangedMs = now;
    buttonDown = pressed;
    if (!buttonDown) return;  // count on the way down only

    if (!gestureOpen || now - firstPressMs > GESTURE_WINDOW_MS) {
      gestureOpen = true;
      firstPressMs = now;
      pressCount = 0;
    }
    if (pressCount < 200) pressCount++;
    lastPressMs = now;
    return;
  }

  if (gestureOpen && now - lastPressMs >= GESTURE_GAP_MS) {
    gestureOpen = false;
    const uint8_t presses = pressCount;
    pressCount = 0;
    emitGesture(presses, now);
  }
}

void detectFall(uint32_t now, float ax, float ay, float az) {
  const FallEvent fall = fallDetector.update(now, ax, ay, az);
  if (fallDetector.lastStep == 1) Monitor.println("[steady] weightless");
  if (fallDetector.lastStep == 2) Monitor.println("[steady] impact");
  if (!fall.fired) return;

  // "<ms>,<peak g>,<weightless ms>,<posture change degrees>"
  char event[56];
  snprintf(event, sizeof event, "%lu,%.2f,%lu,%.0f", (unsigned long)now, fall.peakG, (unsigned long)fall.airMs, fall.tiltDeg);
  Monitor.print("[steady] FALL ");
  Monitor.println(event);
  Bridge.call("steady_fall", String(event));
  steadyIdentify();  // local feedback even if the network is down
}

// ---- Arduino entry points -------------------------------------------------

void setup() {
  Monitor.begin(115200);

  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);  // off

  // Button: the second leg is D4, not GND. Drive it low, then read D2 against it.
  pinMode(BUTTON_COMMON_PIN, OUTPUT);
  digitalWrite(BUTTON_COMMON_PIN, LOW);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  Bridge.begin();
  // provide_safe runs these in loop() context, so they may touch pins
  Bridge.provide_safe("steady_info", steadyInfo);
  Bridge.provide_safe("steady_identify", steadyIdentify);

  imuPresent = startImu();

  Monitor.print("[steady] ");
  Monitor.print(DEVICE_ID);
  Monitor.print(" firmware ");
  Monitor.println(FIRMWARE);
}

void loop() {
  const uint32_t now = millis();

  updateButton(now);

  if (!imuPresent && now >= nextImuRetry) {
    nextImuRetry = now + 2000;
    imuPresent = startImu();
  }

  // Read the sensor every 5 ms for fall detection; send every 4th reading (50 Hz)
  if (imuPresent && now - lastDetectMs >= DETECT_MS) {
    lastDetectMs = now;
    float ax, ay, az, gx, gy, gz;
    if (readImu(ax, ay, az, gx, gy, gz)) {
      detectFall(now, ax, ay, az);
      if (now - lastSampleMs >= SAMPLE_MS) {
        lastSampleMs = now;
        publishSample(now, ax, ay, az, gx, gy, gz);
      }
    }
  }

  updateLed(now);
}
