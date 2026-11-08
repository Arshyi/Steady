// Minimal polling MPU6050 driver (accel + gyro, no DMP).
#pragma once

#include <Arduino.h>
#include <Wire.h>

#include "config.h"
#include "imu_sample.h"

class Mpu6050 {
 public:
  // Wakes the device, sets ranges and the sample-rate divider, and verifies the
  // WHO_AM_I register. Returns false if the part does not answer.
  bool begin(TwoWire& bus, uint8_t address = STEADY_I2C_ADDRESS,
             uint32_t clock_hz = STEADY_I2C_CLOCK_HZ);

  // Reads one accel+gyro burst and converts to g / deg-per-second.
  bool read(ImuSample& out, uint32_t t_ms);

  uint8_t whoAmI() const { return who_am_i_; }
  uint32_t readErrors() const { return errors_; }
  bool present() const { return present_; }

 private:
  bool writeReg(uint8_t reg, uint8_t value);
  bool readReg(uint8_t reg, uint8_t& value);
  bool readBurst(uint8_t reg, uint8_t* buf, uint8_t len);

  TwoWire* bus_ = nullptr;
  uint8_t address_ = STEADY_I2C_ADDRESS;
  uint8_t who_am_i_ = 0;
  bool present_ = false;
  uint32_t errors_ = 0;
};
