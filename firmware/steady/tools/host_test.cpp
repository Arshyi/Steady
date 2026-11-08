// Host test for the portable parts of the firmware: orientation filter, fall
// detector state machine and the rolling window buffer.
//
// Build and run (no hardware, no Arduino toolchain needed):
//   see tools/run_host_test.sh
//
// The signals here are synthetic but physically shaped: walking (~1.8 g
// peaks), a hard sit-down (2.8 g spike, small posture change), a forward fall
// (weightless 250 ms, 6 g impact, then lying still) and a fall into bed
// (short weightless phase, 3 g impact, person still moving).
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

#include "fall_detector.h"
#include "imu_sample.h"
#include "orientation.h"
#include "window_buffer.h"

namespace {

constexpr float kPi = 3.14159265358979f;
constexpr float kDt = 1.0f / 200.0f;

struct Rng {
  uint32_t state = 0x12345678u;
  float next() {
    state = state * 1664525u + 1013904223u;
    return static_cast<float>((state >> 9) & 0x7FFF) / 16384.0f - 1.0f;
  }
  float scaled(float amplitude) { return next() * amplitude; }
};

struct Scenario {
  const char* name;
  int expected_events;
  bool expect_confirmed;  // only meaningful when expected_events > 0
};

struct Result {
  int events = 0;
  int confirmed = 0;
  FallFeatures last{};
  float final_tilt = 0.0f;
  float peak_svm = 0.0f;
};

class Rig {
 public:
  explicit Rig(uint32_t seed) : rng_{seed} {}

  void feed(float ax, float ay, float az, float gx, float gy, float gz) {
    ImuSample s;
    s.t_ms = t_;
    s.ax = ax;
    s.ay = ay;
    s.az = az;
    s.gx = gx;
    s.gy = gy;
    s.gz = gz;
    const float svm = svmOf(s);
    if (svm > result_.peak_svm) {
      result_.peak_svm = svm;
    }
    orient_.update(s);
    window_.push(s);
    FallFeatures f;
    if (detector_.update(s, svm, orient_.value().tilt, f)) {
      result_.events++;
      result_.last = f;
      if (f.confirmed) {
        result_.confirmed++;
      }
    }
    t_ += 5;
  }

  // Upright, sensor +Z against gravity, mild sway.
  void upright(float seconds, float sway_g = 0.05f) {
    const int n = static_cast<int>(seconds / kDt);
    for (int i = 0; i < n; ++i) {
      feed(rng_.scaled(sway_g), rng_.scaled(sway_g),
           1.0f + rng_.scaled(sway_g * 0.5f), rng_.scaled(3.0f),
           rng_.scaled(3.0f), rng_.scaled(3.0f));
    }
  }

  void walking(float seconds) {
    const int n = static_cast<int>(seconds / kDt);
    for (int i = 0; i < n; ++i) {
      const float phase = static_cast<float>(i) * kDt;
      const float ax = 0.45f * std::sin(2 * kPi * 1.8f * phase);
      const float ay = 0.30f * std::sin(2 * kPi * 1.8f * phase + 1.1f);
      const float az = 1.0f + 0.55f * std::sin(2 * kPi * 3.6f * phase);
      feed(ax + rng_.scaled(0.05f), ay + rng_.scaled(0.05f), az + rng_.scaled(0.05f),
           20.0f * std::sin(2 * kPi * 1.8f * phase), rng_.scaled(8.0f),
           rng_.scaled(8.0f));
    }
  }

  void freefall(float seconds, float residual_g = 0.18f) {
    const int n = static_cast<int>(seconds / kDt);
    for (int i = 0; i < n; ++i) {
      feed(rng_.scaled(residual_g), rng_.scaled(residual_g),
           residual_g * 0.5f + rng_.scaled(residual_g), rng_.scaled(25.0f),
           rng_.scaled(25.0f), rng_.scaled(25.0f));
    }
  }

  void impact(float seconds, float g) {
    const int n = static_cast<int>(seconds / kDt);
    for (int i = 0; i < n; ++i) {
      const float decay = g * (1.0f - 0.55f * static_cast<float>(i) / static_cast<float>(n));
      feed(rng_.scaled(0.4f), decay * 0.9f, decay * 0.35f, rng_.scaled(120.0f),
           rng_.scaled(120.0f), rng_.scaled(120.0f));
    }
  }

  void hardSit(float seconds) {
    const int n = static_cast<int>(seconds / kDt);
    for (int i = 0; i < n; ++i) {
      const float p = static_cast<float>(i) / static_cast<float>(n);
      const float lift = 2.8f * std::exp(-18.0f * p);
      // Torso ends up ~25 degrees forward: gravity moves to the +Y axis a bit.
      const float lean = 0.42f * std::fmin(1.0f, p * 3.0f);
      feed(rng_.scaled(0.06f), lean + lift * 0.7f,
           std::sqrt(1.0f - lean * lean) + lift * 0.3f, rng_.scaled(20.0f),
           rng_.scaled(20.0f), rng_.scaled(20.0f));
    }
  }

  // Lying on the back: gravity on +Y, sensor Z horizontal -> tilt ~90 deg.
  void lying(float seconds, float motion_g) {
    const int n = static_cast<int>(seconds / kDt);
    for (int i = 0; i < n; ++i) {
      const float p = static_cast<float>(i) * kDt;
      const float wobble = motion_g * std::sin(2 * kPi * 3.0f * p);
      feed(rng_.scaled(motion_g * 0.6f), 1.0f + wobble + rng_.scaled(motion_g * 0.5f),
           0.10f + rng_.scaled(motion_g * 0.5f), rng_.scaled(10.0f + motion_g * 40.0f),
           rng_.scaled(10.0f + motion_g * 40.0f), rng_.scaled(10.0f));
    }
  }

  void dropOnDesk(float seconds) {
    // Falls a short distance, lands flat, stays upright: no posture change.
    const int n = static_cast<int>(seconds / kDt);
    for (int i = 0; i < n; ++i) {
      const float p = static_cast<float>(i) / static_cast<float>(n);
      const float bounce = 7.0f * std::exp(-20.0f * p);
      feed(rng_.scaled(0.3f), rng_.scaled(0.3f), 1.0f + bounce, rng_.scaled(150.0f),
           rng_.scaled(150.0f), rng_.scaled(150.0f));
    }
  }

  Result finish() {
    result_.final_tilt = orient_.value().tilt;
    return result_;
  }

  const WindowBuffer& window() const { return window_; }
  FallDetector& detector() { return detector_; }

 private:
  Rng rng_;
  FallDetector detector_;
  OrientationFilter orient_;
  WindowBuffer window_;
  uint32_t t_ = 1000;  // start from a non-zero uptime
  Result result_;
};

int g_failures = 0;

void check(bool condition, const char* what) {
  if (!condition) {
    std::printf("    FAIL: %s\n", what);
    g_failures++;
  }
}

void report(const Scenario& scenario, const Result& r) {
  std::printf("  %-22s candidates=%d confirmed=%d tilt=%6.1fdeg peak=%5.2fg conf=%3u\n",
              scenario.name, r.events, r.confirmed, r.final_tilt, r.peak_svm,
              static_cast<unsigned>(r.last.confidence));
  check(r.events == scenario.expected_events, "unexpected number of candidates");
  if (scenario.expected_events > 0) {
    check(r.last.confirmed == scenario.expect_confirmed, "confirmation flag");
  }
  check(r.last.flags == r.last.flags, "flags readable");
}

void testWalking() {
  Rig rig(0xA1);
  rig.walking(10.0f);
  const Result r = rig.finish();
  report({"walking 10s", 0, false}, r);
  check(r.last.confidence == 0 || r.events == 0, "walking must not raise a candidate");
}

void testHardSit() {
  Rig rig(0xB2);
  rig.walking(2.0f);
  rig.hardSit(3.0f);
  const Result r = rig.finish();
  report({"hard sit-down", 0, false}, r);
}

void testForwardFall() {
  Rig rig(0xC3);
  rig.walking(1.5f);
  rig.freefall(0.25f);
  rig.impact(0.10f, 6.0f);
  rig.lying(2.0f, 0.03f);
  const Result r = rig.finish();
  report({"forward fall", 1, true}, r);
  check(r.last.saw_freefall, "forward fall should see free fall");
  check(r.last.tilt_delta_deg > 45.0f, "forward fall should change posture");
  check(r.last.peak_g > 4.0f, "forward fall should register a strong impact");
  check(r.last.confidence >= 70, "forward fall confidence >= 70");
  check(r.final_tilt > 60.0f, "final posture is lying (tilt > 60 deg)");
  check(rig.window().size() >= 300, "window keeps at least 1.5 s of history");
}

void testFallIntoBed() {
  Rig rig(0xD4);
  rig.upright(2.0f);
  rig.freefall(0.20f);
  rig.impact(0.08f, 3.1f);
  rig.lying(2.0f, 0.12f);  // still moving: no stillness bonus
  const Result r = rig.finish();
  report({"fall into bed", 1, true}, r);
  check(r.last.still == false, "moving after impact should not count as still");
}

void testDropOnDesk() {
  Rig rig(0xE5);
  rig.upright(1.0f);
  rig.freefall(0.30f);
  rig.dropOnDesk(2.0f);
  const Result r = rig.finish();
  report({"device dropped flat", 1, false}, r);
  check(r.last.confirmed == false, "no posture change means no fall");
}

void testLyingStill() {
  Rig rig(0xF6);
  rig.lying(8.0f, 0.02f);
  const Result r = rig.finish();
  report({"lying still 8s", 0, false}, r);
}

void testFreefallTooLong() {
  Rig rig(0x17);
  rig.upright(0.5f);
  rig.freefall(2.0f);  // thrown / sensor dropped off the body
  rig.upright(1.0f);
  const Result r = rig.finish();
  report({"free fall 2s (thrown)", 0, false}, r);
}

void testWindowPacking() {
  WindowBuffer buffer;
  buffer.clear();
  ImuSample s;
  s.t_ms = 0;
  s.ax = 1.234f;
  s.ay = -0.5f;
  s.az = 0.999f;
  s.gx = 100.0f;
  s.gy = -200.0f;
  s.gz = 12.3f;
  for (int i = 0; i < 1000; ++i) {
    s.t_ms = static_cast<uint32_t>(i * 5);
    buffer.push(s);
  }
  PackedSample out[STEADY_WINDOW_SAMPLES];
  const uint16_t n = buffer.copyLast(out, STEADY_WINDOW_SAMPLES);
  check(n == STEADY_WINDOW_SAMPLES, "copyLast returns a full window");
  check(out[n - 1].a[0] == 1234, "accel is packed as milli-g");
  check(out[n - 1].g[0] == 1000, "gyro is packed as 0.1 deg/s");
  check(out[n - 1].g[1] == -2000, "negative gyro packs correctly");
  std::printf("  %-22s n=%u last_ax=%d last_gx=%d\n", "window packing", n,
              out[n - 1].a[0], out[n - 1].g[0]);
}

void testThresholdTuning() {
  FallDetector det;
  FallConfig cfg;
  cfg.tilt_change_deg = 80.0f;  // strict posture requirement
  det.configure(cfg);
  check(det.config().tilt_change_deg == 80.0f, "configure applies thresholds");
  check(det.phase() == FallPhase::Monitoring, "reset returns to monitoring");
}

}  // namespace

int main() {
  std::printf("Steady firmware host tests\n");
  std::printf("--------------------------\n");
  testWalking();
  testHardSit();
  testForwardFall();
  testFallIntoBed();
  testDropOnDesk();
  testLyingStill();
  testFreefallTooLong();
  testWindowPacking();
  testThresholdTuning();

  if (g_failures == 0) {
    std::printf("\nALL CHECKS PASSED\n");
    return 0;
  }
  std::printf("\n%d CHECK(S) FAILED\n", g_failures);
  return 1;
}
