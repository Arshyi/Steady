#pragma once
// Fall detection for the Steady wearable, kept free of Arduino code so it can be
// tested on a laptop (tools/fall_detector_test.cpp).
//
// The same rules as the USB sketch (arduino/steady_mpu6050), which were checked
// with real drops:
//   1. weightless: |a| drops below 0.60 g
//   2. impact: |a| goes above 1.8 g within 1.2 s
//   3. after 250 ms of settling, it's a fall if the posture changed by 40° or
//      more, or the impact was hard (3.0 g or more) even if it landed flat
// Feed it every reading, ideally every 5 ms: a landing spike only lasts a few
// tens of milliseconds.

#include <math.h>
#include <stdint.h>

struct FallEvent {
  bool fired;
  float peakG;     // hardest impact seen
  float tiltDeg;   // posture change between before the drop and after landing
  uint32_t airMs;  // how long it was weightless before the impact
};

class FallDetector {
 public:
  static constexpr float FREEFALL_G = 0.60f;
  static constexpr float IMPACT_G = 1.8f;
  static constexpr float HARD_IMPACT_G = 3.0f;
  static constexpr float TILT_DELTA_MIN = 40.0f;
  static constexpr uint32_t IMPACT_WINDOW_MS = 1200;
  static constexpr uint32_t SETTLE_MS = 250;
  static constexpr uint32_t COOLDOWN_MS = 5000;

  /** What just happened, for the serial log: 0 nothing, 1 weightless, 2 impact */
  uint8_t lastStep = 0;

  FallEvent update(uint32_t now, float ax, float ay, float az) {
    FallEvent none = {false, 0, 0, 0};
    lastStep = 0;
    const float g = norm(ax, ay, az);

    // Unsigned subtraction keeps working when millis() wraps after ~49 days
    if (hasFallen && now - lastFall < COOLDOWN_MS) return none;

    if (!inAir && !landing) {
      if (g < FREEFALL_G) {
        inAir = true;
        airAt = now;
        peakG = 0;
        preX = uprightX;
        preY = uprightY;
        preZ = uprightZ;
        lastStep = 1;
      } else if (g > 0.7f) {
        // Gravity while it's still being held or worn, to compare with after landing
        uprightX = ax;
        uprightY = ay;
        uprightZ = az;
      }
      return none;
    }

    if (inAir) {
      if (g > peakG) peakG = g;
      if (g > IMPACT_G && now - airAt <= IMPACT_WINDOW_MS) {
        inAir = false;
        landing = true;
        impactAt = now;
        airMs = now - airAt;
        lastStep = 2;
      } else if (now - airAt > IMPACT_WINDOW_MS) {
        inAir = false;  // a fast gesture, not a drop
      }
      return none;
    }

    // Landing: keep the hardest bounce, then judge once it has settled
    if (g > peakG) peakG = g;
    if (now - impactAt < SETTLE_MS) return none;
    landing = false;
    const float tilt = angleBetween(preX, preY, preZ, ax, ay, az);
    if (tilt < TILT_DELTA_MIN && peakG < HARD_IMPACT_G) return none;

    hasFallen = true;
    lastFall = now;
    FallEvent fall = {true, peakG, tilt, airMs};
    return fall;
  }

 private:
  bool inAir = false;
  bool landing = false;
  bool hasFallen = false;
  uint32_t airAt = 0;
  uint32_t impactAt = 0;
  uint32_t lastFall = 0;
  uint32_t airMs = 0;
  float peakG = 0;
  float uprightX = 0, uprightY = 0, uprightZ = 1;
  float preX = 0, preY = 0, preZ = 1;

  static float norm(float x, float y, float z) { return sqrtf(x * x + y * y + z * z); }

  /** Angle in degrees between two gravity directions */
  static float angleBetween(float ax, float ay, float az, float bx, float by, float bz) {
    const float na = norm(ax, ay, az);
    const float nb = norm(bx, by, bz);
    if (na < 0.3f || nb < 0.3f) return 0;
    float c = (ax * bx + ay * by + az * bz) / (na * nb);
    if (c > 1.0f) c = 1.0f;
    if (c < -1.0f) c = -1.0f;
    return acosApprox(c) * 57.29578f;
  }

  /**
   * acos(x) in radians, within ~0.004° (Abramowitz & Stegun 4.4.45). Used instead
   * of acosf, which the UNO Q build failed to link (it pulls in C library code
   * the board doesn't provide). sqrtf links fine.
   */
  static float acosApprox(float x) {
    const bool negative = x < 0;
    if (negative) x = -x;
    float r = -0.0187293f;
    r = r * x + 0.0742610f;
    r = r * x - 0.2121144f;
    r = r * x + 1.5707288f;
    r = r * sqrtf(1.0f - x);
    return negative ? 3.14159265f - r : r;
  }
};
