#include "orientation.h"

#include <math.h>

namespace {
constexpr float kRadToDeg = 57.29577951f;
}  // namespace

float OrientationFilter::wrap180(float deg) {
  while (deg > 180.0f) deg -= 360.0f;
  while (deg < -180.0f) deg += 360.0f;
  return deg;
}

float OrientationFilter::clampf(float v, float lo, float hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

void OrientationFilter::reset() {
  out_ = Orientation{};
  last_ms_ = 0;
  primed_ = false;
}

void OrientationFilter::update(const ImuSample& sample) {
  float dt = 1.0f / 200.0f;
  if (last_ms_ != 0 && sample.t_ms > last_ms_) {
    dt = static_cast<float>(sample.t_ms - last_ms_) / 1000.0f;
  }
  last_ms_ = sample.t_ms;
  // A stalled thread or a clock glitch must not produce a huge gyro jump.
  if (dt <= 0.0f || dt > 0.2f) {
    dt = 1.0f / 200.0f;
  }

  const float norm = svmOf(sample);
  // Only trust gravity when the reading looks like gravity: it collapses in
  // free fall and rails on impact.
  const bool accel_trusted = norm > 0.4f && norm < 2.0f;

  float roll_acc = 0.0f;
  float pitch_acc = 0.0f;
  float tilt_acc = 0.0f;
  if (accel_trusted) {
    roll_acc = atan2f(sample.ay, sample.az) * kRadToDeg;
    pitch_acc =
        atan2f(-sample.ax, sqrtf(sample.ay * sample.ay + sample.az * sample.az)) *
        kRadToDeg;
    tilt_acc = acosf(clampf(sample.az / norm, -1.0f, 1.0f)) * kRadToDeg;
  }

  // Dead reckon with the gyro, then pull towards gravity when it is believable.
  out_.roll += sample.gx * dt;
  out_.pitch += sample.gy * dt;
  out_.yaw += sample.gz * dt;

  if (!primed_) {
    if (accel_trusted) {
      out_.roll = roll_acc;
      out_.pitch = pitch_acc;
      out_.tilt = tilt_acc;
      out_.valid = true;
      primed_ = true;
    }
  } else if (accel_trusted) {
    out_.roll += (roll_acc - out_.roll) * (1.0f - kAlphaRollPitch);
    out_.pitch += (pitch_acc - out_.pitch) * (1.0f - kAlphaRollPitch);
    out_.tilt += (tilt_acc - out_.tilt) * (1.0f - kAlphaTilt);
  }

  out_.roll = wrap180(out_.roll);
  out_.pitch = wrap180(out_.pitch);
  out_.yaw = wrap180(out_.yaw);
}
