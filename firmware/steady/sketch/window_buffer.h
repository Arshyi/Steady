// Rolling window of the most recent samples, packed small enough to keep 3 s
// in RAM on the STM32 and to ship over the 256-byte Bridge link in chunks.
#pragma once

#include <stdint.h>

#include "config.h"
#include "imu_sample.h"

struct PackedSample {
  int16_t a[3];  // milli-g
  int16_t g[3];  // 0.1 deg/s
};

class WindowBuffer {
 public:
  static constexpr uint16_t kCapacity = STEADY_WINDOW_CAPACITY;

  void clear() {
    count_ = 0;
    head_ = 0;
  }

  void push(const ImuSample& sample) {
    ring_[head_] = pack(sample);
    head_ = static_cast<uint16_t>((head_ + 1) % kCapacity);
    if (count_ < kCapacity) {
      count_++;
    }
  }

  uint16_t size() const { return count_; }

  // Copies the newest `max_samples` samples into `dest` in chronological order.
  // Returns how many were written.
  uint16_t copyLast(PackedSample* dest, uint16_t max_samples) const {
    uint16_t n = count_ < max_samples ? count_ : max_samples;
    if (n == 0) {
      return 0;
    }
    const uint16_t start = static_cast<uint16_t>((head_ + kCapacity - n) % kCapacity);
    for (uint16_t i = 0; i < n; ++i) {
      dest[i] = ring_[static_cast<uint16_t>((start + i) % kCapacity)];
    }
    return n;
  }

  static PackedSample pack(const ImuSample& s) {
    PackedSample p{};
    p.a[0] = clampI16(s.ax * 1000.0f);
    p.a[1] = clampI16(s.ay * 1000.0f);
    p.a[2] = clampI16(s.az * 1000.0f);
    p.g[0] = clampI16(s.gx * 10.0f);
    p.g[1] = clampI16(s.gy * 10.0f);
    p.g[2] = clampI16(s.gz * 10.0f);
    return p;
  }

 private:
  static int16_t clampI16(float v) {
    if (v > 32767.0f) return 32767;
    if (v < -32768.0f) return -32768;
    return static_cast<int16_t>(v < 0 ? v - 0.5f : v + 0.5f);
  }

  PackedSample ring_[kCapacity]{};
  uint16_t head_ = 0;
  uint16_t count_ = 0;
};
