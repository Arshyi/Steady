// Steady wearable — Arduino UNO Q (STM32U585, Zephyr core)
//
// Reads an MPU6050 (accelerometer + gyroscope over I2C) 50 times a second, looks
// for the free-fall-then-impact pattern of a fall, and hands everything to the
// Linux side over the Bridge. `python/main.py` serves those samples to the
// dashboard over WebSocket; the data contract lives in src/hardware/protocol.ts
// and README.md.
//
// Controls on the wearable:
//   * one press of the button      → "I'm OK", acknowledged on the dashboard
//   * three presses within ~1.5 s  → SURVEY MODE: the Linux side scans Wi-Fi and
//                                    uploads a fingerprint for the room
//   * tapping an NFC tag           → "responder was here", same acknowledgement
// The button is the only input, so the gesture is decided after a short pause
// rather than on key-up: a single press cannot be reported until the code knows
// two more are not coming.
//
// Wiring: MPU6050 SDA→A4, SCL→A5, VCC→3V3, GND→GND (address 0x68 with AD0 low,
// 0x69 with AD0 high — both are tried). The button sits between D2 and GND.
//
// The NFC reader (PN532, I2C, 0x24) is still optional and not fitted yet: install
// the Adafruit PN532 library in App Lab and it is picked up automatically. With
// no reader the sketch still builds and taps arrive as dummy data from the
// relay (`dummy_nfc_every_s` in python/main.py) or from the simulator, so the
// responder flow can be exercised without the hardware.
//
// This replaces hardware/steady_wearable (Nano 33 BLE): the UNO Q has no BLE
// radio visible to the sketch, and no onboard IMU.

#include "Arduino_RouterBridge.h"
#include <Wire.h>

#if __has_include(<Adafruit_PN532.h>)
#include <Adafruit_PN532.h>
#define STEADY_NFC_READY 1
#else
#define STEADY_NFC_READY 0
#endif

// ---- identity -------------------------------------------------------------
// Give every device its own ID before flashing; the dashboard pairs on it.
static const char* DEVICE_ID = "ST-UNOQ1";
static const char* FIRMWARE = "1.2.0";

// ---- sampling -------------------------------------------------------------
static constexpr uint32_t SAMPLE_HZ = 50;
static constexpr uint32_t SAMPLE_MS = 1000 / SAMPLE_HZ;

// ---- MPU6050 (I2C) --------------------------------------------------------
// Registers are only the ones this sketch touches.
static constexpr uint8_t IMU_REG_CONFIG = 0x1A;
static constexpr uint8_t IMU_REG_SMPLRT_DIV = 0x19;
static constexpr uint8_t IMU_REG_GYRO_CONFIG = 0x1B;
static constexpr uint8_t IMU_REG_ACCEL_CONFIG = 0x1C;
static constexpr uint8_t IMU_REG_ACCEL_XOUT_H = 0x3B;
static constexpr uint8_t IMU_REG_PWR_MGMT_1 = 0x6B;
static constexpr uint8_t IMU_REG_WHO_AM_I = 0x75;
static constexpr uint8_t IMU_ADDRESSES[] = {0x68, 0x69};
static constexpr float ACCEL_LSB_PER_G = 16384.0f;   // ±2 g
static constexpr float GYRO_LSB_PER_DPS = 65.5f;     // ±500 °/s

// ---- fall detection (untuned: test with real drops before relying on it) ---
// A fall starts with the body becoming weightless, then a hard landing.
static constexpr float FREEFALL_G = 0.55f;      // |a| below this is "free fall"
static constexpr uint32_t FREEFALL_MIN_MS = 100; // must last at least this long
static constexpr uint32_t FREEFALL_MAX_MS = 900; // longer means thrown, not falling
static constexpr float IMPACT_G = 2.6f;          // landing after a free fall
static constexpr float IMPACT_ALONE_G = 3.5f;    // hard hit with no free fall seen
static constexpr uint32_t REFRACTORY_MS = 3000;  // one alert per 3 s

// ---- button gestures ------------------------------------------------------
// Wire the button between D2 and GND; INPUT_PULLUP means a press reads LOW.
static constexpr uint8_t BUTTON_PIN = 2;
static constexpr uint32_t BUTTON_DEBOUNCE_MS = 25;
static constexpr uint32_t GESTURE_GAP_MS = 650;    // quiet time that ends a gesture
static constexpr uint32_t GESTURE_WINDOW_MS = 2500; // presses must fit in this
static constexpr uint8_t SURVEY_PRESSES = 3;

// ---- NFC ------------------------------------------------------------------
static constexpr uint8_t NFC_IRQ_PIN = 3;
static constexpr uint8_t NFC_RESET_PIN = 4;
static constexpr uint32_t NFC_POLL_MS = 250;
static constexpr uint32_t NFC_REPEAT_MS = 4000;  // same tag resting on the reader
static constexpr uint32_t NFC_RETRY_MS = 5000;

static constexpr uint8_t IDENTIFY_BLINKS = 3;
static constexpr uint8_t OK_BLINKS = 1;
static constexpr uint8_t TAP_BLINKS = 2;
static constexpr uint8_t SURVEY_BLINKS = 4;
static constexpr uint32_t BLINK_MS = 120;

bool imuPresent = false;
uint8_t imuAddress = IMU_ADDRESSES[0];
uint32_t nextImuRetry = 0;

uint32_t lastSampleMs = 0;
uint32_t lastFallMs = 0;

bool weightless = false;
uint32_t weightlessSince = 0;
uint32_t weightlessMs = 0;

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

#if STEADY_NFC_READY
Adafruit_PN532 nfc(NFC_IRQ_PIN, NFC_RESET_PIN);
bool nfcReady = false;
uint32_t nextNfcRetry = 0;
uint32_t lastNfcPollMs = 0;
String lastTag = "";
uint32_t lastTagMs = 0;
#endif

// ---- Bridge functions the Linux side can call -----------------------------

/** "<deviceId>;<firmware>", e.g. "ST-UNOQ1;1.2.0" */
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
  Wire.beginTransmission(imuAddress);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool imuRead(uint8_t reg, uint8_t* buf, uint8_t len) {
  Wire.beginTransmission(imuAddress);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(imuAddress, len) != len) return false;
  for (uint8_t i = 0; i < len; i++) {
    if (Wire.available() == 0) return false;
    buf[i] = (uint8_t)Wire.read();
  }
  return true;
}

int16_t be16(const uint8_t* p) {
  return (int16_t)(((uint16_t)p[0] << 8) | p[1]);
}

bool startImu() {
  Wire.begin();
  Wire.setClock(400000);

  for (uint8_t i = 0; i < sizeof(IMU_ADDRESSES); i++) {
    imuAddress = IMU_ADDRESSES[i];

    uint8_t who = 0;
    if (!imuRead(IMU_REG_WHO_AM_I, &who, 1)) continue;
    // 0x98 and 0x72 are clones that behave like an MPU6050 for these registers
    if (who != 0x68 && who != 0x98 && who != 0x72) continue;

    // Reset, then wake on the X-gyro PLL
    if (!imuWrite(IMU_REG_PWR_MGMT_1, 0x80)) continue;
    delay(100);
    if (!imuWrite(IMU_REG_PWR_MGMT_1, 0x01)) continue;

    imuWrite(IMU_REG_SMPLRT_DIV, 19);   // 1 kHz base rate / 20 = 50 Hz
    imuWrite(IMU_REG_CONFIG, 0x03);     // DLPF, ~44 Hz accelerometer bandwidth
    imuWrite(IMU_REG_GYRO_CONFIG, 0x08);  // ±500 °/s
    imuWrite(IMU_REG_ACCEL_CONFIG, 0x00); // ±2 g

    Monitor.print("[steady] MPU6050 online at 0x");
    Monitor.print(imuAddress, HEX);
    Monitor.print(", WHO_AM_I 0x");
    Monitor.println(who, HEX);
    return true;
  }

  Monitor.println("[steady] no MPU6050 on A4/A5 (0x68 or 0x69), retrying");
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

void startNfc() {
#if STEADY_NFC_READY
  nfc.begin();
  const uint32_t version = nfc.getFirmwareVersion();
  if (!version) {
    nfcReady = false;
    Monitor.println("[steady] PN532 not answering on A4/A5, will retry");
    return;
  }
  nfc.SAMConfig();
  nfcReady = true;
  Monitor.print("[steady] PN532 ready, firmware 0x");
  Monitor.println(version, HEX);
#else
  Monitor.println("[steady] NFC off: no reader fitted; taps can come from the relay's dummy mode");
#endif
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
 * for GESTURE_GAP_MS, which is why a single "I'm OK" press takes ~0.7 s to send.
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
    Monitor.println("[steady] I'm OK");
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

void pollNfc(uint32_t now) {
#if STEADY_NFC_READY
  if (!nfcReady || now - lastNfcPollMs < NFC_POLL_MS) return;
  lastNfcPollMs = now;

  uint8_t uid[7];
  uint8_t uidLength = 0;
  if (!nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLength, 80)) return;
  if (uidLength == 0) return;

  char hex[16];
  size_t used = 0;
  for (uint8_t i = 0; i < uidLength && i < 7; i++) {
    if (used + 3 > sizeof hex) break;
    used += snprintf(hex + used, sizeof hex - used, "%02X", uid[i]);
  }

  // A tag left lying on the reader should not flood the dashboard.
  if (lastTag == hex && now - lastTagMs < NFC_REPEAT_MS) return;
  lastTag = hex;
  lastTagMs = now;

  char line[32];
  snprintf(line, sizeof line, "%lu,%s", (unsigned long)now, hex);
  Bridge.call("steady_nfc", String(line));
  blink(TAP_BLINKS);
  Monitor.print("[steady] responder tap ");
  Monitor.println(hex);
#endif
}

void detectFall(uint32_t now, float ax, float ay, float az) {
  const float g = sqrtf(ax * ax + ay * ay + az * az);

  if (g < FREEFALL_G) {
    if (!weightless) {
      weightless = true;
      weightlessSince = now;
    }
    weightlessMs = now - weightlessSince;
    if (weightlessMs > FREEFALL_MAX_MS) weightless = false;  // a throw, not a fall
    return;
  }

  const bool landed = weightless && weightlessMs >= FREEFALL_MIN_MS && g >= IMPACT_G;
  const bool hardHit = g >= IMPACT_ALONE_G;  // knees first, then the torso

  if ((landed || hardHit) && now - lastFallMs >= REFRACTORY_MS) {
    lastFallMs = now;
    weightless = false;

    char event[48];
    snprintf(event, sizeof event, "%lu,%.2f,%lu", (unsigned long)now, g, (unsigned long)weightlessMs);
    Bridge.call("steady_fall", String(event));
    steadyIdentify();  // local feedback even if the network is down
  }
}

// ---- Arduino entry points -------------------------------------------------

void setup() {
  Monitor.begin(115200);

  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);  // off

  pinMode(BUTTON_PIN, INPUT_PULLUP);

  Bridge.begin();
  // provide_safe runs these in loop() context, so they may touch pins
  Bridge.provide_safe("steady_info", steadyInfo);
  Bridge.provide_safe("steady_identify", steadyIdentify);

  imuPresent = startImu();
  startNfc();

  Monitor.print("[steady] ");
  Monitor.print(DEVICE_ID);
  Monitor.print(" firmware ");
  Monitor.println(FIRMWARE);
}

void loop() {
  const uint32_t now = millis();

  updateButton(now);
  pollNfc(now);

  if (!imuPresent && now >= nextImuRetry) {
    nextImuRetry = now + 2000;
    imuPresent = startImu();
  }

#if STEADY_NFC_READY
  if (!nfcReady && now >= nextNfcRetry) {
    nextNfcRetry = now + NFC_RETRY_MS;
    startNfc();
  }
#endif

  if (imuPresent && now - lastSampleMs >= SAMPLE_MS) {
    lastSampleMs = now;
    float ax, ay, az, gx, gy, gz;
    if (readImu(ax, ay, az, gx, gy, gz)) {
      detectFall(now, ax, ay, az);
      publishSample(now, ax, ay, az, gx, gy, gz);
    }
  }

  updateLed(now);
}
