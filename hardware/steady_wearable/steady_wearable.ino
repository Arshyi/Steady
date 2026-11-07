// Steady wearable: starter firmware
//
// Sends accelerometer + gyroscope readings to the Steady web app over Bluetooth (BLE)
// and over the USB cable, detects falls, and blinks its light when asked.
// The data format must match src/hardware/protocol.ts in the web app.
//
// Boards: Arduino Nano 33 BLE / BLE Sense (Rev1 or Rev2), Nano 33 IoT, Nano RP2040 Connect.
// Libraries (Arduino IDE > Library Manager): "ArduinoBLE" plus the IMU library for your board below.

// ---- 1. Pick your board's motion sensor (uncomment exactly one) ----
#define IMU_BMI270      // Nano 33 BLE Rev2 / Sense Rev2  -> library "Arduino_BMI270_BMM150"
// #define IMU_LSM9DS1  // Nano 33 BLE Rev1 / Sense Rev1  -> library "Arduino_LSM9DS1"
// #define IMU_LSM6DS3  // Nano 33 IoT                    -> library "Arduino_LSM6DS3"
// #define IMU_LSM6DSOX // Nano RP2040 Connect            -> library "Arduino_LSM6DSOX"

#if defined(IMU_BMI270)
  #include <Arduino_BMI270_BMM150.h>
#elif defined(IMU_LSM9DS1)
  #include <Arduino_LSM9DS1.h>
#elif defined(IMU_LSM6DS3)
  #include <Arduino_LSM6DS3.h>
#elif defined(IMU_LSM6DSOX)
  #include <Arduino_LSM6DSOX.h>
#endif
#include <ArduinoBLE.h>

// ---- 2. Give every device its own ID before flashing ----
const char* DEVICE_ID = "ST-0001";
const char* FIRMWARE  = "1.4.2";

// ---- Bluetooth layout (same UUIDs as protocol.ts) ----
BLEService steadyService("53746561-6479-4000-8000-000000000000");
BLECharacteristic motionChar("53746561-6479-4000-8000-000000000001", BLENotify, 24);
BLEStringCharacteristic infoChar("53746561-6479-4000-8000-000000000002", BLERead, 32);
BLEByteCharacteristic commandChar("53746561-6479-4000-8000-000000000003", BLEWrite);
BLEByteCharacteristic fallChar("53746561-6479-4000-8000-000000000004", BLERead | BLENotify);

BLEService batteryService("180F");                                    // standard Battery Service
BLEUnsignedCharCharacteristic batteryChar("2A19", BLERead | BLENotify); // standard Battery Level

const unsigned long SAMPLE_MS = 20; // 50 readings a second
unsigned long lastSample = 0;
unsigned long lastBattery = 0;
unsigned long identifyUntil = 0;

// ---- Battery ----
// The Nano boards can't measure a battery on their own. Wire the LiPo through a
// 2:1 voltage divider to A0, then set HAS_BATTERY_DIVIDER to 1.
#define HAS_BATTERY_DIVIDER 0
uint8_t readBatteryPercent() {
#if HAS_BATTERY_DIVIDER
  float volts = analogRead(A0) * (3.3 / 1023.0) * 2.0;
  float pct = (volts - 3.3) / (4.2 - 3.3) * 100.0; // rough LiPo curve
  return (uint8_t)constrain(pct, 0, 100);
#else
  return 100; // placeholder until a divider is wired
#endif
}

// ---- Fall detection ----
// A simple starting point: a moment of free fall (|a| < 0.4 g) followed by an
// impact (|a| > 2.5 g) within one second. Tune with real tests before relying on it.
const float FREEFALL_G = 0.4;
const float IMPACT_G = 2.5;
const unsigned long IMPACT_WINDOW_MS = 1000;
const unsigned long FALL_COOLDOWN_MS = 5000;
unsigned long freefallAt = 0;
unsigned long lastFall = 0;

void reportFall() {
  lastFall = millis();
  fallChar.writeValue(1);
  Serial.println("F");
  fallChar.writeValue(0); // reset so the next fall notifies again
}

void checkFall(float ax, float ay, float az) {
  unsigned long now = millis();
  if (now - lastFall < FALL_COOLDOWN_MS) return;
  float g = sqrt(ax * ax + ay * ay + az * az);
  if (g < FREEFALL_G) freefallAt = now;
  else if (freefallAt && g > IMPACT_G && now - freefallAt < IMPACT_WINDOW_MS) {
    freefallAt = 0;
    reportFall();
  } else if (freefallAt && now - freefallAt > IMPACT_WINDOW_MS) freefallAt = 0;
}

// ---- Info over USB ----
void printInfo() {
  Serial.print("I,"); Serial.print(DEVICE_ID); Serial.print(","); Serial.println(FIRMWARE);
  Serial.print("B,"); Serial.println(readBatteryPercent());
}

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(10); // never stall the 50 Hz loop waiting for a command
  pinMode(LED_BUILTIN, OUTPUT);

  if (!IMU.begin()) {
    // Motion sensor missing: blink fast forever so it's obvious on the bench
    while (true) { digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN)); delay(100); }
  }

  if (!BLE.begin()) {
    Serial.println("# Bluetooth failed to start; USB only");
  } else {
    String name = String("Steady ") + DEVICE_ID;
    BLE.setLocalName(name.c_str());
    BLE.setAdvertisedService(steadyService);
    steadyService.addCharacteristic(motionChar);
    steadyService.addCharacteristic(infoChar);
    steadyService.addCharacteristic(commandChar);
    steadyService.addCharacteristic(fallChar);
    BLE.addService(steadyService);
    batteryService.addCharacteristic(batteryChar);
    BLE.addService(batteryService);

    infoChar.writeValue(String(DEVICE_ID) + ";" + FIRMWARE);
    fallChar.writeValue(0);
    batteryChar.writeValue(readBatteryPercent());
    BLE.advertise();
  }
}

void loop() {
  BLE.poll();
  unsigned long now = millis();

  // Commands from the web app: Bluetooth byte 1, or "I" / "I?" over USB
  if (commandChar.written() && commandChar.value() == 1) identifyUntil = now + 3000;
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line == "I?") printInfo();
    else if (line == "I") identifyUntil = now + 3000;
  }

  // Blink to identify, otherwise light off
  digitalWrite(LED_BUILTIN, now < identifyUntil ? (now / 150) % 2 : LOW);

  // Battery every 30 s
  if (now - lastBattery > 30000) {
    lastBattery = now;
    uint8_t pct = readBatteryPercent();
    batteryChar.writeValue(pct);
    if (Serial) { Serial.print("B,"); Serial.println(pct); }
  }

  // Motion at 50 Hz
  if (now - lastSample < SAMPLE_MS) return;
  if (!IMU.accelerationAvailable() || !IMU.gyroscopeAvailable()) return;
  lastSample = now;

  float m[6]; // ax, ay, az in g; gx, gy, gz in degrees per second
  IMU.readAcceleration(m[0], m[1], m[2]);
  IMU.readGyroscope(m[3], m[4], m[5]);

  checkFall(m[0], m[1], m[2]);

  // Bluetooth: 6 little-endian floats (all these boards are little-endian)
  if (BLE.connected()) motionChar.writeValue((uint8_t*)m, sizeof(m));

  // USB: one text line
  if (Serial) {
    Serial.print("M");
    for (int i = 0; i < 6; i++) { Serial.print(","); Serial.print(m[i], 3); }
    Serial.println();
  }
}
