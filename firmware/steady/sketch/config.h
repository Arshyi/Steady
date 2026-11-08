// Steady — build-time configuration for the UNO Q (STM32U585) firmware.
//
// Everything here is a compile-time constant so the RTOS side never allocates
// or branches on configuration at runtime.
#pragma once

#define STEADY_FW_VERSION "1.0.0"

// ---------------------------------------------------------------- sensor bus
// MPU6050 addresses: 0x68 when AD0 is tied low, 0x69 when tied high.
#define STEADY_I2C_ADDRESS 0x68
#define STEADY_I2C_CLOCK_HZ 400000

// Set to 1 to probe only the Qwiic bus (Wire1) and skip the header bus (Wire).
// The default (0) auto-detects: header bus first, then Qwiic.
#define STEADY_FORCE_QWIIC 0

// ----------------------------------------------------------------- sampling
#define STEADY_SAMPLE_HZ 200
#define STEADY_SAMPLE_PERIOD_MS (1000 / STEADY_SAMPLE_HZ)
#define STEADY_TELEMETRY_HZ 10
#define STEADY_TELEMETRY_EVERY_N (STEADY_SAMPLE_HZ / STEADY_TELEMETRY_HZ)

// ------------------------------------------------------------ sensor ranges
// Impact transients in a real fall routinely exceed 2 g, and the MPU6050 rails
// at full scale, so +/-8 g is the smallest range with useful headroom.
// That still resolves 1 g with ~4 LSB per milli-g.
#define STEADY_ACCEL_FSR_G 8
#define STEADY_GYRO_FSR_DPS 2000
// 1 kHz internal rate -> DLPF at 44 Hz keeps everything below the 100 Hz
// Nyquist limit of a 200 Hz sampler while suppressing I2C aliasing.
#define STEADY_DLPF_CFG 3

// -------------------------------------------------------------- event window
// The MCU keeps a rolling 3 s window in RAM. When a fall is confirmed the tail
// of that window (2 s before + 1 s after impact) is uploaded for the website's
// analysis, so the site sees exactly what the detector saw.
#define STEADY_WINDOW_PRE_MS 2000
#define STEADY_WINDOW_POST_MS 1000
#define STEADY_WINDOW_CAPACITY 640
#define STEADY_WINDOW_SAMPLES                                  \
  ((STEADY_WINDOW_PRE_MS + STEADY_WINDOW_POST_MS) * STEADY_SAMPLE_HZ / 1000)

// Samples per Bridge RPC reply. The Bridge link caps MCU->router messages at
// 256 bytes, so a chunk carries 18 packed samples (18 * 12 B = 216 B).
#define STEADY_CHUNK_SAMPLES 18

// ------------------------------------------------------------------- queues
#define STEADY_SAMPLE_QUEUE_LEN 96   // 480 ms of slack at 200 Hz
#define STEADY_TELEMETRY_QUEUE_LEN 16
