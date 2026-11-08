#pragma once

#include <math.h>
#include <stdint.h>

// Keep the register value and conversion together: +/-2 g clips the impacts
// this detector needs to see. MPU6050 AFS_SEL=2 gives +/-8 g and 4096 LSB/g.
static constexpr uint8_t STEADY_ACCEL_CONFIG = 0x10;
static constexpr float STEADY_ACCEL_LSB_PER_G = 4096.0f;

struct FallEvent {
  float peakG = 0;
  uint32_t freefallMs = 0;
};

// A bench-testable threshold detector, not a validated medical algorithm.
// A qualified low-g interval can arm an impact only for a short, bounded time.
class SteadyFallDetector {
 public:
  static constexpr float FREEFALL_G = 0.55f;
  static constexpr uint32_t FREEFALL_MIN_MS = 100;
  static constexpr uint32_t FREEFALL_MAX_MS = 900;
  static constexpr uint32_t IMPACT_WINDOW_MS = 250;
  static constexpr float IMPACT_G = 2.6f;
  static constexpr float IMPACT_ALONE_G = 3.5f;
  static constexpr uint32_t REFRACTORY_MS = 3000;

  void resetCandidate() {
    weightless_ = false;
    armed_ = false;
    freefallMs_ = 0;
  }

  bool update(uint32_t now, float ax, float ay, float az, FallEvent& event) {
    const float g = sqrtf(ax * ax + ay * ay + az * az);
    if (!isfinite(g)) {
      resetCandidate();
      return false;
    }

    if (g < FREEFALL_G) {
      if (!weightless_) {
        weightless_ = true;
        weightlessSince_ = now;
        armed_ = false;
      }
      // Do not restart an overlong low-g interval every FREEFALL_MAX_MS.
      return false;
    }

    if (weightless_) {
      freefallMs_ = now - weightlessSince_;
      weightless_ = false;
      armed_ = freefallMs_ >= FREEFALL_MIN_MS && freefallMs_ <= FREEFALL_MAX_MS;
      recoveredAt_ = now;
    }
    if (armed_ && now - recoveredAt_ > IMPACT_WINDOW_MS) armed_ = false;

    const bool landed = armed_ && g >= IMPACT_G;
    const bool hardHit = g >= IMPACT_ALONE_G;
    if (!(landed || hardHit) || (hasFallen_ && now - lastFall_ < REFRACTORY_MS)) {
      return false;
    }

    event.peakG = g;
    event.freefallMs = armed_ ? freefallMs_ : 0;
    lastFall_ = now;
    hasFallen_ = true;
    resetCandidate();
    return true;
  }

 private:
  bool weightless_ = false;
  bool armed_ = false;
  bool hasFallen_ = false;
  uint32_t weightlessSince_ = 0;
  uint32_t recoveredAt_ = 0;
  uint32_t freefallMs_ = 0;
  uint32_t lastFall_ = 0;
};
