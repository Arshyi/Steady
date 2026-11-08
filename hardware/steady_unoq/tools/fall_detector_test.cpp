#include <assert.h>
#include <stdio.h>
#include "../sketch/fall_detector.h"

int main() {
  FallEvent event;
  {
    // Register selection and raw conversion must agree; 4 g must not clip.
    static_assert(STEADY_ACCEL_CONFIG == 0x10, "Use MPU6050 +/-8 g");
    SteadyFallDetector detector;
    const int16_t rawFourG = 16384;
    assert(detector.update(100, rawFourG / STEADY_ACCEL_LSB_PER_G, 0, 0, event));
    assert(event.peakG == 4.0f && event.freefallMs == 0);
    assert(!detector.update(200, 4, 0, 0, event));
    assert(detector.update(3100, 4, 0, 0, event));
  }
  {
    SteadyFallDetector detector;
    assert(!detector.update(1000, 0, 0, 0.1f, event));
    assert(!detector.update(1100, 0, 0, 0.1f, event));
    assert(detector.update(1120, 0, 0, 2.8f, event));
    assert(event.freefallMs == 120);
  }
  {
    // Recovering from low-g must not arm an impact minutes later.
    SteadyFallDetector detector;
    detector.update(1000, 0, 0, 0.1f, event);
    assert(!detector.update(1120, 0, 0, 1, event));
    assert(!detector.update(1400, 0, 0, 2.8f, event));
    assert(!detector.update(90000, 0, 0, 2.8f, event));
  }
  {
    // A low-g interval longer than the limit must not restart itself.
    SteadyFallDetector detector;
    for (uint32_t now = 1000; now < 2120; now += 20)
      assert(!detector.update(now, 0, 0, 0.1f, event));
    assert(!detector.update(2120, 0, 0, 2.8f, event));
  }
  {
    SteadyFallDetector detector;
    detector.update(1000, 0, 0, 0.1f, event);
    assert(!detector.update(1040, 0, 0, 2.8f, event)); // short low-g
    detector.update(2000, 0, 0, 0.1f, event);
    detector.resetCandidate(); // an I2C outage invalidates the candidate
    assert(!detector.update(2200, 0, 0, 2.8f, event));
  }
  {
    // millis() rollover must preserve timing and cooldown.
    SteadyFallDetector detector;
    detector.update(UINT32_MAX - 100, 0, 0, 0.1f, event);
    assert(detector.update(19, 0, 0, 2.8f, event));
    assert(event.freefallMs == 120);
    assert(!detector.update(100, 4, 0, 0, event));
    assert(detector.update(3019, 4, 0, 0, event));
  }
  {
    SteadyFallDetector detector;
    for (uint32_t now = 0; now < 10000; now += 20)
      assert(!detector.update(now, 0.2f, 0, 1.0f, event));
  }
  puts("Integrated UNO Q detector: 7 regression scenarios passed");
  return 0;
}
