// Threshold + state-machine fall detector.
//
// The literature-standard shape: a weightless phase (free fall), then an
// impact spike, then a posture change that persists. Requiring all three is
// what separates a fall from sitting down hard or dropping the device.
//
// This file is deliberately free of Arduino and Zephyr headers so it can be
// compiled and exercised by a host test (firmware/steady/tools/host_test.cpp).
#pragma once

#include <stdint.h>

#include "imu_sample.h"

struct FallConfig {
  // Weightlessness: |a| below this for at least freefall_min_ms.
  float freefall_g = 0.50f;
  uint32_t freefall_min_ms = 100;
  uint32_t freefall_max_ms = 900;  // longer = thrown / sensor off body
  // Impact: |a| above this. impact_only_g allows an impact-first fall
  // (knees then torso, fall into bed) with no clean free-fall phase.
  float impact_g = 2.50f;
  float impact_only_g = 3.50f;
  // Post-impact stillness, measured as the standard deviation of |a|.
  float still_std_g = 0.08f;
  // Posture: how far the gravity vector has to swing to call it a fall.
  float tilt_change_deg = 45.0f;
  uint32_t settle_ms = 1000;
  uint32_t refractory_ms = 3000;
};

enum class FallPhase : uint8_t {
  Monitoring = 0,
  FreeFall = 1,
  Settling = 2,
  Refractory = 3,
};

// Bit flags describing a candidate, mirrored to the website.
enum FallFlag : uint8_t {
  kFlagFreeFall = 1 << 0,
  kFlagImpact = 1 << 1,
  kFlagPostureChange = 1 << 2,
  kFlagStill = 1 << 3,
};

struct FallFeatures {
  bool confirmed = false;
  bool saw_freefall = false;
  bool posture_changed = false;
  bool still = false;
  uint8_t confidence = 0;
  uint8_t flags = 0;
  uint32_t t_start_ms = 0;
  uint32_t t_impact_ms = 0;
  uint32_t t_end_ms = 0;
  float min_g = 0.0f;
  float peak_g = 0.0f;
  float tilt_before = 0.0f;
  float tilt_after = 0.0f;
  float tilt_delta_deg = 0.0f;
  float motion_std_g = 0.0f;
};

class FallDetector {
 public:
  void configure(const FallConfig& config);
  void reset();

  // Feed one sample. Returns true on the single sample where a candidate
  // finishes, with `out` filled in. Calls are 1:1 with samples at 200 Hz.
  bool update(const ImuSample& sample, float svm, float tilt_deg,
              FallFeatures& out);

  FallPhase phase() const { return phase_; }
  const FallConfig& config() const { return cfg_; }
  uint32_t confirmedCount() const { return confirmed_count_; }
  uint32_t rejectedCount() const { return rejected_count_; }

 private:
  void beginSettling(const ImuSample& sample, float svm, bool saw_freefall);
  void evaluate(const ImuSample& sample, float tilt_deg, FallFeatures& out);
  void clearMotionRing();
  float motionStd() const;
  float delayedTilt() const;

  static constexpr uint16_t kMotionWindow = 100;  // 500 ms at 200 Hz

  FallConfig cfg_{};
  FallPhase phase_ = FallPhase::Monitoring;

  bool saw_freefall_ = false;
  uint32_t freefall_start_ms_ = 0;
  uint32_t impact_ms_ = 0;
  uint32_t refractory_until_ms_ = 0;
  float min_g_ = 0.0f;
  float peak_g_ = 0.0f;
  float tilt_before_ = 0.0f;

  float motion_[kMotionWindow]{};
  uint16_t motion_count_ = 0;
  uint16_t motion_index_ = 0;

  float tilt_history_[kMotionWindow]{};
  uint16_t tilt_count_ = 0;
  uint16_t tilt_index_ = 0;

  uint32_t confirmed_count_ = 0;
  uint32_t rejected_count_ = 0;
};
