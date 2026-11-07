// Steady wearable — Arduino UNO Q (STM32U585, Zephyr core)
//
// Reads the Modulino Movement (LSM6DSOX over Qwiic) 50 times a second, looks for
// the free-fall-then-impact pattern of a fall, and hands everything to the Linux
// side over the Bridge. `python/main.py` serves those samples to the dashboard
// over WebSocket; the data contract lives in src/hardware/protocol.ts.
//
// Qwiic on the UNO Q is the secondary I2C bus, so the Modulino library uses
// Wire1. If nothing is found there we retry on the A4/A5 header pins (Wire).
//
// This replaces hardware/steady_wearable (Nano 33 BLE): the UNO Q has no BLE
// radio visible to the sketch, and no onboard IMU, hence the Qwiic sensor.

#include "Arduino_RouterBridge.h"
#include <Arduino_Modulino.h>

// ---- identity -------------------------------------------------------------
// Give every device its own ID before flashing; the dashboard pairs on it.
static const char* DEVICE_ID = "ST-UNOQ1";
static const char* FIRMWARE = "1.0.0";

// ---- sampling -------------------------------------------------------------
static constexpr uint32_t SAMPLE_HZ = 50;
static constexpr uint32_t SAMPLE_MS = 1000 / SAMPLE_HZ;

// ---- fall detection (untuned: test with real drops before relying on it) ---
// A fall starts with the body becoming weightless, then a hard landing.
static constexpr float FREEFALL_G = 0.55f;      // |a| below this is "free fall"
static constexpr uint32_t FREEFALL_MIN_MS = 100; // must last at least this long
static constexpr uint32_t FREEFALL_MAX_MS = 900; // longer means thrown, not falling
static constexpr float IMPACT_G = 2.6f;          // landing after a free fall
static constexpr float IMPACT_ALONE_G = 3.5f;    // hard hit with no free fall seen
static constexpr uint32_t REFRACTORY_MS = 3000;  // one alert per 3 s

static constexpr uint8_t IDENTIFY_BLINKS = 3;
static constexpr uint32_t BLINK_MS = 120;

ModulinoMovement movement;

bool imuPresent = false;
uint32_t nextImuRetry = 0;

uint32_t lastSampleMs = 0;
uint32_t lastFallMs = 0;

bool weightless = false;
uint32_t weightlessSince = 0;
uint32_t weightlessMs = 0;

uint8_t blinksLeft = 0;
uint32_t lastBlinkMs = 0;
bool ledLit = false;

// ---- Bridge functions the Linux side can call -----------------------------

/** "<deviceId>;<firmware>", e.g. "ST-UNOQ1;1.0.0" */
String steadyInfo() {
  return String(DEVICE_ID) + ";" + FIRMWARE;
}

/** Blink the onboard LED so staff can find the device in a drawer. */
bool steadyIdentify() {
  blinksLeft = IDENTIFY_BLINKS * 2;  // on and off for each blink
  lastBlinkMs = millis();
  return true;
}

// ---- helpers --------------------------------------------------------------

void startImu() {
  Modulino.begin();  // Wire1 = Qwiic connector on the UNO Q
  imuPresent = movement.begin();

  if (!imuPresent) {
    Modulino.begin(Wire);  // fall back to SDA/SCL on the UNO headers
    imuPresent = movement.begin();
  }

  Monitor.println(imuPresent ? "[steady] Modulino Movement online"
                             : "[steady] no Modulino Movement found, retrying");
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

  Bridge.begin();
  // provide_safe runs these in loop() context, so they may touch pins
  Bridge.provide_safe("steady_info", steadyInfo);
  Bridge.provide_safe("steady_identify", steadyIdentify);

  startImu();
  Monitor.print("[steady] ");
  Monitor.print(DEVICE_ID);
  Monitor.print(" firmware ");
  Monitor.println(FIRMWARE);
}

void loop() {
  const uint32_t now = millis();

  if (!imuPresent && now >= nextImuRetry) {
    nextImuRetry = now + 2000;
    startImu();
  }

  if (imuPresent && now - lastSampleMs >= SAMPLE_MS) {
    lastSampleMs = now;
    if (movement.update()) {
      const float ax = movement.getX();
      const float ay = movement.getY();
      const float az = movement.getZ();
      // The Modulino library exposes angular rate as roll/pitch/yaw
      const float gx = movement.getRoll();
      const float gy = movement.getPitch();
      const float gz = movement.getYaw();

      detectFall(now, ax, ay, az);
      publishSample(now, ax, ay, az, gx, gy, gz);
    }
  }

  updateLed(now);
}
