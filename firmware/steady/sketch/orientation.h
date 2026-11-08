// Complementary pose filter: gyro integration corrected by gravity.
//
// The MPU6050 has no magnetometer, so yaw is gyro-only and drifts. Roll, pitch
// and the tilt-from-vertical angle are gravity-referenced and stay sane over
// long runs, which is what a fall decision needs.
#pragma once

#include "imu_sample.h"

struct Orientation {
  float roll = 0.0f;   // deg, -180..180
  float pitch = 0.0f;  // deg, -180..180
  float yaw = 0.0f;    // deg, drifts
  float tilt = 0.0f;   // deg between the sensor +Z axis and gravity
  bool valid = false;
};

class OrientationFilter {
 public:
  void reset();

  void update(const ImuSample& sample);

  const Orientation& value() const { return out_; }

 private:
  static float wrap180(float deg);
  static float clampf(float v, float lo, float hi);

  // Per-sample smoothing of the gravity correction. roll/pitch are slowly
  // corrected; tilt follows faster so the post-impact posture is measured
  // within the 1 s settle window instead of lagging behind it.
  static constexpr float kAlphaRollPitch = 0.98f;
  static constexpr float kAlphaTilt = 0.90f;

  Orientation out_{};
  uint32_t last_ms_ = 0;
  bool primed_ = false;
};
