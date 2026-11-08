#include "mpu6050.h"

namespace {

// Register map (only what this firmware touches).
constexpr uint8_t kRegSmplrtDiv = 0x19;
constexpr uint8_t kRegConfig = 0x1A;
constexpr uint8_t kRegGyroConfig = 0x1B;
constexpr uint8_t kRegAccelConfig = 0x1C;
constexpr uint8_t kRegAccelXoutH = 0x3B;
constexpr uint8_t kRegPwrMgmt1 = 0x6B;
constexpr uint8_t kRegWhoAmI = 0x75;

constexpr uint8_t kWhoAmIMpu6050 = 0x68;

#if STEADY_ACCEL_FSR_G == 2
constexpr uint8_t kAccelFsSel = 0;
constexpr float kAccelLsbPerG = 16384.0f;
#elif STEADY_ACCEL_FSR_G == 4
constexpr uint8_t kAccelFsSel = 1;
constexpr float kAccelLsbPerG = 8192.0f;
#elif STEADY_ACCEL_FSR_G == 8
constexpr uint8_t kAccelFsSel = 2;
constexpr float kAccelLsbPerG = 4096.0f;
#elif STEADY_ACCEL_FSR_G == 16
constexpr uint8_t kAccelFsSel = 3;
constexpr float kAccelLsbPerG = 2048.0f;
#else
#error "STEADY_ACCEL_FSR_G must be 2, 4, 8 or 16"
#endif

#if STEADY_GYRO_FSR_DPS == 250
constexpr uint8_t kGyroFsSel = 0;
constexpr float kGyroLsbPerDps = 131.0f;
#elif STEADY_GYRO_FSR_DPS == 500
constexpr uint8_t kGyroFsSel = 1;
constexpr float kGyroLsbPerDps = 65.5f;
#elif STEADY_GYRO_FSR_DPS == 1000
constexpr uint8_t kGyroFsSel = 2;
constexpr float kGyroLsbPerDps = 32.8f;
#elif STEADY_GYRO_FSR_DPS == 2000
constexpr uint8_t kGyroFsSel = 3;
constexpr float kGyroLsbPerDps = 16.4f;
#else
#error "STEADY_GYRO_FSR_DPS must be 250, 500, 1000 or 2000"
#endif

inline int16_t be16(const uint8_t* p) {
  return static_cast<int16_t>((static_cast<uint16_t>(p[0]) << 8) | p[1]);
}

}  // namespace

bool Mpu6050::begin(TwoWire& bus, uint8_t address, uint32_t clock_hz) {
  bus_ = &bus;
  address_ = address;
  present_ = false;

  bus_->begin();
  bus_->setClock(clock_hz);

  if (!readReg(kRegWhoAmI, who_am_i_)) {
    return false;
  }
  if (who_am_i_ != kWhoAmIMpu6050 && who_am_i_ != 0x98 && who_am_i_ != 0x72) {
    // 0x98 / 0x72 are clones that behave like an MPU6050 for our registers.
    return false;
  }

  // Reset, then wake on the X-gyro PLL (more stable than the internal 8 MHz).
  if (!writeReg(kRegPwrMgmt1, 0x80)) return false;
  delay(100);
  if (!writeReg(kRegPwrMgmt1, 0x01)) return false;

  const uint8_t divider =
      static_cast<uint8_t>(1000 / STEADY_SAMPLE_HZ - 1);  // 1 kHz base rate
  if (!writeReg(kRegSmplrtDiv, divider)) return false;
  if (!writeReg(kRegConfig, static_cast<uint8_t>(STEADY_DLPF_CFG))) return false;
  if (!writeReg(kRegGyroConfig, static_cast<uint8_t>(kGyroFsSel << 3))) {
    return false;
  }
  if (!writeReg(kRegAccelConfig, static_cast<uint8_t>(kAccelFsSel << 3))) {
    return false;
  }

  present_ = true;
  return true;
}

bool Mpu6050::read(ImuSample& out, uint32_t t_ms) {
  if (!present_ || bus_ == nullptr) {
    return false;
  }

  uint8_t buf[14];
  if (!readBurst(kRegAccelXoutH, buf, sizeof(buf))) {
    errors_++;
    return false;
  }

  out.t_ms = t_ms;
  out.ax = be16(&buf[0]) / kAccelLsbPerG;
  out.ay = be16(&buf[2]) / kAccelLsbPerG;
  out.az = be16(&buf[4]) / kAccelLsbPerG;
  // buf[6..7] is the die temperature; not needed for fall detection.
  out.gx = be16(&buf[8]) / kGyroLsbPerDps;
  out.gy = be16(&buf[10]) / kGyroLsbPerDps;
  out.gz = be16(&buf[12]) / kGyroLsbPerDps;
  return true;
}

bool Mpu6050::writeReg(uint8_t reg, uint8_t value) {
  bus_->beginTransmission(address_);
  bus_->write(reg);
  bus_->write(value);
  return bus_->endTransmission() == 0;
}

bool Mpu6050::readReg(uint8_t reg, uint8_t& value) {
  return readBurst(reg, &value, 1);
}

bool Mpu6050::readBurst(uint8_t reg, uint8_t* buf, uint8_t len) {
  bus_->beginTransmission(address_);
  bus_->write(reg);
  if (bus_->endTransmission(false) != 0) {
    return false;
  }
  if (bus_->requestFrom(static_cast<uint8_t>(address_),
                        static_cast<uint8_t>(len)) != len) {
    return false;
  }
  for (uint8_t i = 0; i < len; ++i) {
    if (bus_->available() == 0) {
      return false;
    }
    buf[i] = static_cast<uint8_t>(bus_->read());
  }
  return true;
}
