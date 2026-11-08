// Portable sensor sample type shared by the driver, filters and host tests.
#pragma once

#include <math.h>
#include <stdint.h>

struct ImuSample {
  uint32_t t_ms = 0;  // MCU uptime at read time, milliseconds
  float ax = 0.0f;    // g
  float ay = 0.0f;
  float az = 0.0f;
  float gx = 0.0f;  // degrees / second
  float gy = 0.0f;
  float gz = 0.0f;
};

inline float svmOf(const ImuSample& s) {
  return sqrtf(s.ax * s.ax + s.ay * s.ay + s.az * s.az);
}
