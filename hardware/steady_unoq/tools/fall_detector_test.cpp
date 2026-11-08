// Laptop test for sketch/fall_detector.h. Build and run:
//   g++ -std=c++17 -O2 -o /tmp/fall_test hardware/steady_unoq/tools/fall_detector_test.cpp && /tmp/fall_test
#include <cmath>
#include <cstdio>
#include <functional>
#include "../sketch/fall_detector.h"

// Accel in g at time t (ms) for one scenario; the detector is fed every `stepMs`
using Profile = std::function<void(uint32_t t, float &ax, float &ay, float &az)>;

static bool run(const char *name, Profile p, bool expect, uint32_t stepMs = 5, uint32_t start = 100000) {
  FallDetector d;
  FallEvent hit = {false, 0, 0, 0};
  for (uint32_t t = 0; t < 6000; t += stepMs) {
    float ax, ay, az;
    p(t, ax, ay, az);
    FallEvent e = d.update(start + t, ax, ay, az);
    if (e.fired && !hit.fired) hit = e;
  }
  const bool ok = hit.fired == expect;
  printf("%s %-46s fired=%d", ok ? "PASS" : "FAIL", name, hit.fired);
  if (hit.fired) printf("  peak %.1f g, tilt %.0f deg, air %u ms", hit.peakG, hit.tiltDeg, hit.airMs);
  printf("\n");
  return ok;
}

// Upright (gravity on z) until `dropAt`, weightless for `airMs`, an impact pulse
// of `peak` g lasting ~30 ms, then resting at `tiltDeg` from upright
static Profile drop(uint32_t dropAt, uint32_t airMs, float peak, float tiltDeg) {
  return [=](uint32_t t, float &ax, float &ay, float &az) {
    const float r = tiltDeg * 3.14159265f / 180.0f;
    if (t < dropAt) { ax = 0.02f; ay = -0.01f; az = 1.0f; return; }
    if (t < dropAt + airMs) { ax = 0.05f; ay = 0.03f; az = 0.12f; return; }
    const uint32_t s = t - (dropAt + airMs);
    if (s < 30) {  // impact pulse, smoothed like the sensor's low-pass filter
      const float k = sinf(3.14159265f * s / 30.0f);
      ax = peak * k * sinf(r) * 0.7f + 0.3f * k; ay = 0.2f * k; az = peak * k * cosf(r) * 0.7f + 0.3f * k + 0.3f;
      const float n = sqrtf(ax * ax + ay * ay + az * az);
      const float want = 0.4f + (peak - 0.4f) * k;
      ax *= want / n; ay *= want / n; az *= want / n;
      return;
    }
    if (s < 150) { const float b = 1.0f + 0.4f * sinf(s / 10.0f); ax = sinf(r) * b; ay = 0; az = cosf(r) * b; return; }
    ax = sinf(r); ay = 0.0f; az = cosf(r);
  };
}

int main() {
  int bad = 0;
  bad += !run("drop onto cushion, lands on its side (2.2 g)", drop(1000, 320, 2.2f, 90), true);
  bad += !run("drop onto bed, lands tilted 60 deg (1.9 g)", drop(1000, 250, 1.9f, 60), true);
  bad += !run("hard drop onto floor, lands flat (4.5 g)", drop(1000, 320, 4.5f, 5), true);
  bad += !run("soft drop, lands flat (2.2 g, no tilt)", drop(1000, 320, 2.2f, 5), false);
  bad += !run("same side-landing drop, checked every 20 ms", drop(1000, 320, 2.2f, 90), true, 20);
  bad += !run("set down gently on its side (no weightlessness)", [](uint32_t t, float &x, float &y, float &z) {
    const float r = (t < 1000 ? 0 : t > 2000 ? 1 : (t - 1000) / 1000.0f) * 1.5708f; x = sinf(r); y = 0; z = cosf(r); }, false);
  bad += !run("walking (0.7 to 1.5 g)", [](uint32_t t, float &x, float &y, float &z) {
    x = 0.1f; y = 0; z = 1.1f + 0.4f * sinf(t / 80.0f); }, false);
  bad += !run("quick dip, no impact (a gesture)", [](uint32_t t, float &x, float &y, float &z) {
    x = 0; y = 0; z = (t > 1000 && t < 1150) ? 0.4f : 1.0f; }, false);
  bad += !run("shaking hard (0.3 to 2.4 g, no posture change)", [](uint32_t t, float &x, float &y, float &z) {
    x = 0; y = 0; z = 1.35f + 1.05f * sinf(t / 25.0f); }, false);
  bad += !run("drop just after millis() wraps around", drop(1000, 320, 2.2f, 90), true, 5, 0xFFFFFFFFu - 1500);
  printf(bad ? "\n%d FAILED\n" : "\nall passed\n", bad);
  return bad ? 1 : 0;
}
