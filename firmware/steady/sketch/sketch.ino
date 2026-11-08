// Steady — fall detection firmware for the Arduino UNO Q (STM32U585 / Zephyr).
//
// Thread map (Zephyr preemptive threads, static stacks):
//   sampler   prio 2, 200 Hz  I2C burst read -> sample queue
//   detector  prio 3, event   orientation filter + fall FSM + rolling window
//   uplink    prio 5, 10 Hz   Bridge notifications to the Linux side
//   loop      idle            hosts the Bridge provide_safe() callbacks
//
// The MCU makes the fall decision locally because the Bridge link is a
// 115200 baud serial with a 256-byte message cap: streaming 200 Hz x 6 axes
// would need ~5 kB/s and starve it. Instead the MCU sends 10 Hz telemetry plus,
// on a confirmed fall, a 3 s packed waveform that the Linux side pulls in
// chunks. The website therefore receives both the live stream and the exact
// samples behind every alert.
#include <Arduino.h>
#include <Wire.h>
#include <math.h>

#include "config.h"
#include "fall_detector.h"
#include "imu_sample.h"
#include "mpu6050.h"
#include "orientation.h"
#include "rtos.h"
#include "window_buffer.h"

#if __has_include("Arduino_RouterBridge.h")
#include "Arduino_RouterBridge.h"
#define STEADY_HAS_BRIDGE 1
#else
#define STEADY_HAS_BRIDGE 0
#endif

#if STEADY_HAS_BRIDGE
#include <vector>
#endif

// --------------------------------------------------------------------- state
struct Telemetry {
  uint32_t t_ms = 0;
  uint32_t seq = 0;
  float ax = 0, ay = 0, az = 0;
  float gx = 0, gy = 0, gz = 0;
  float roll = 0, pitch = 0, tilt = 0, svm = 0;
  uint8_t phase = 0;
};

struct EventPackage {
  bool ready = false;
  bool announced = false;
  uint32_t seq = 0;
  uint16_t count = 0;
  uint16_t rate_hz = STEADY_SAMPLE_HZ;
  FallFeatures features{};
  PackedSample samples[STEADY_WINDOW_SAMPLES]{};
};

static Mpu6050 g_imu;
static WindowBuffer g_window;
static OrientationFilter g_orientation;
static FallDetector g_detector;
static SteadyMutex g_event_lock;
static EventPackage g_event;
static SteadyQueue<ImuSample, STEADY_SAMPLE_QUEUE_LEN> g_sample_queue;
static SteadyQueue<Telemetry, STEADY_TELEMETRY_QUEUE_LEN> g_telemetry_queue;
static uint32_t g_event_seq = 0;
static uint32_t g_sample_count = 0;
static uint32_t g_bridge_drops = 0;
static uint32_t g_sensor_retries = 0;

// ---------------------------------------------------------------- sensor bus
static bool detectSensor() {
#if STEADY_FORCE_QWIIC
  return g_imu.begin(Wire);
#else
  if (g_imu.begin(Wire)) {
    return true;
  }
#if STEADY_ZEPHYR
  // UNO Q exposes the header bus through Wire and the Qwiic connector through
  // Wire1. Try both so the wiring order does not matter.
  if (g_imu.begin(Wire1)) {
    return true;
  }
#endif
  return false;
#endif
}

// -------------------------------------------------------------- notifications
static void notifyRemote(const char* method, const char* payload) {
#if STEADY_HAS_BRIDGE
  Bridge.notify(method, String(payload));
#else
  // Bench build without a Bridge: log to serial so the logic stays observable.
  Serial.print(method);
  Serial.print(' ');
  Serial.println(payload);
#endif
}

static int buildTelemetryJson(const Telemetry& t, char* buf, size_t len) {
  return snprintf(
      buf, len,
      "{\"t\":%lu,\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,"
      "\"gx\":%.1f,\"gy\":%.1f,\"gz\":%.1f,"
      "\"r\":%.1f,\"p\":%.1f,\"tl\":%.1f,\"sv\":%.3f,\"st\":%u,\"n\":%lu}",
      static_cast<unsigned long>(t.t_ms), t.ax, t.ay, t.az, t.gx, t.gy, t.gz,
      t.roll, t.pitch, t.tilt, t.svm, static_cast<unsigned>(t.phase),
      static_cast<unsigned long>(t.seq));
}

static int buildFallJson(const EventPackage& pkg, char* buf, size_t len) {
  const FallFeatures& f = pkg.features;
  return snprintf(
      buf, len,
      "{\"ev\":1,\"seq\":%lu,\"t\":%lu,\"dur\":%lu,\"pk\":%.2f,\"mn\":%.2f,"
      "\"tb\":%.1f,\"ta\":%.1f,\"dl\":%.1f,\"cf\":%u,\"fl\":%u,\"n\":%u,\"hz\":%u}",
      static_cast<unsigned long>(pkg.seq),
      static_cast<unsigned long>(f.t_impact_ms),
      static_cast<unsigned long>(f.t_end_ms - f.t_start_ms), f.peak_g, f.min_g,
      f.tilt_before, f.tilt_after, f.tilt_delta_deg,
      static_cast<unsigned>(f.confidence), static_cast<unsigned>(f.flags),
      static_cast<unsigned>(pkg.count), static_cast<unsigned>(pkg.rate_hz));
}

// ------------------------------------------------------------ per-sample work
static void processSample(const ImuSample& sample) {
  const float svm = svmOf(sample);
  g_orientation.update(sample);
  const Orientation pose = g_orientation.value();

  g_window.push(sample);

  FallFeatures features;
  if (g_detector.update(sample, svm, pose.tilt, features) && features.confirmed) {
    g_event_lock.lock();
    g_event.ready = true;
    g_event.announced = false;
    g_event.seq = ++g_event_seq;
    g_event.rate_hz = STEADY_SAMPLE_HZ;
    g_event.features = features;
    g_event.count = g_window.copyLast(g_event.samples, STEADY_WINDOW_SAMPLES);
    g_event_lock.unlock();
  }
}

static void publishTelemetry(const ImuSample& sample) {
  Telemetry t;
  t.t_ms = sample.t_ms;
  t.seq = g_sample_count;
  t.ax = sample.ax;
  t.ay = sample.ay;
  t.az = sample.az;
  t.gx = sample.gx;
  t.gy = sample.gy;
  t.gz = sample.gz;
  const Orientation pose = g_orientation.value();
  t.roll = pose.roll;
  t.pitch = pose.pitch;
  t.tilt = pose.tilt;
  t.svm = svmOf(sample);
  t.phase = static_cast<uint8_t>(g_detector.phase());
  g_telemetry_queue.push(t);
}

// Drains queued telemetry and announces any pending fall package. Safe to call
// from any single thread.
static void pumpUplink() {
  Telemetry t;
  char buf[248];
  while (g_telemetry_queue.pop(t, 0)) {
    const int n = buildTelemetryJson(t, buf, sizeof(buf));
    if (n > 0 && n < static_cast<int>(sizeof(buf)) && n < 250) {
      notifyRemote("steady_telemetry", buf);
    } else {
      g_bridge_drops++;
    }
  }

  g_event_lock.lock();
  FallFeatures pending_features;
  uint32_t pending_seq = 0;
  uint16_t pending_count = 0;
  uint16_t pending_rate = STEADY_SAMPLE_HZ;
  const bool announce = g_event.ready && !g_event.announced;
  if (announce) {
    g_event.announced = true;
    pending_features = g_event.features;
    pending_seq = g_event.seq;
    pending_count = g_event.count;
    pending_rate = g_event.rate_hz;
  }
  g_event_lock.unlock();

  if (announce) {
    EventPackage pkg;
    pkg.seq = pending_seq;
    pkg.count = pending_count;
    pkg.rate_hz = pending_rate;
    pkg.features = pending_features;
    const int n = buildFallJson(pkg, buf, sizeof(buf));
    if (n > 0 && n < static_cast<int>(sizeof(buf)) && n < 250) {
      notifyRemote("steady_fall", buf);
    } else {
      g_bridge_drops++;
    }
  }
}

// ---------------------------------------------------------------- RTOS tasks
#if STEADY_ZEPHYR
STEADY_DEFINE_STACK(g_sampler_stack, 4096);
STEADY_DEFINE_STACK(g_detector_stack, 4096);
STEADY_DEFINE_STACK(g_uplink_stack, 4096);
static SteadyThread g_sampler_thread;
static SteadyThread g_detector_thread;
static SteadyThread g_uplink_thread;

static void samplerTask(void*) {
  uint32_t next = steadyNowMs();
  uint32_t last_retry = steadyNowMs();
  while (true) {
    const uint32_t now = steadyNowMs();
    if (!g_imu.present() && now - last_retry >= 2000) {
      last_retry = now;
      g_sensor_retries++;
      detectSensor();
    }

    ImuSample sample;
    if (g_imu.present() && g_imu.read(sample, steadyNowMs())) {
      g_sample_count++;
      g_sample_queue.push(sample);
    }

    next += STEADY_SAMPLE_PERIOD_MS;
    const uint32_t after = steadyNowMs();
    const int32_t wait = static_cast<int32_t>(next - after);
    if (wait > 0) {
      steadySleepMs(static_cast<uint32_t>(wait));
    } else if (wait < -200) {
      next = after;  // resynchronise after a long stall instead of bursting
    }
  }
}

static void detectorTask(void*) {
  ImuSample sample;
  uint16_t since_telemetry = 0;
  while (true) {
    if (!g_sample_queue.pop(sample, 1000)) {
      continue;
    }
    processSample(sample);
    if (++since_telemetry >= STEADY_TELEMETRY_EVERY_N) {
      since_telemetry = 0;
      publishTelemetry(sample);
    }
  }
}

static void uplinkTask(void*) {
  while (true) {
    pumpUplink();
    steadySleepMs(20);
  }
}
#endif  // STEADY_ZEPHYR

// ------------------------------------------------------- Bridge RPC handlers
#if STEADY_HAS_BRIDGE
static String steadyStatus() {
  char buf[224];
  const int n = snprintf(
      buf, sizeof(buf),
      "{\"v\":\"%s\",\"up\":%lu,\"hz\":%d,\"sensor\":%d,\"who\":%u,\"samples\":%lu,"
      "\"err\":%lu,\"drop\":%lu,\"retry\":%lu,\"cf\":%lu,\"rj\":%lu,\"ev\":%lu,\"st\":%u}",
      STEADY_FW_VERSION, static_cast<unsigned long>(steadyNowMs()), STEADY_SAMPLE_HZ,
      g_imu.present() ? 1 : 0, static_cast<unsigned>(g_imu.whoAmI()),
      static_cast<unsigned long>(g_sample_count),
      static_cast<unsigned long>(g_imu.readErrors()),
      static_cast<unsigned long>(g_bridge_drops),
      static_cast<unsigned long>(g_sensor_retries),
      static_cast<unsigned long>(g_detector.confirmedCount()),
      static_cast<unsigned long>(g_detector.rejectedCount()),
      static_cast<unsigned long>(g_event_seq),
      static_cast<unsigned>(g_detector.phase()));
  if (n <= 0 || n >= static_cast<int>(sizeof(buf))) {
    snprintf(buf, sizeof(buf), "{\"v\":\"%s\"}", STEADY_FW_VERSION);
  }
  return String(buf);
}

static String steadyEventMeta() {
  char buf[228];
  g_event_lock.lock();
  const bool ready = g_event.ready;
  const EventPackage& pkg = g_event;
  const int n = snprintf(
      buf, sizeof(buf),
      "{\"ready\":%d,\"seq\":%lu,\"n\":%u,\"hz\":%u,\"pk\":%.2f,\"mn\":%.2f,"
      "\"tb\":%.1f,\"ta\":%.1f,\"dl\":%.1f,\"cf\":%u,\"fl\":%u,\"imp\":%lu,\"end\":%lu}",
      ready ? 1 : 0, static_cast<unsigned long>(pkg.seq),
      static_cast<unsigned>(pkg.count), static_cast<unsigned>(pkg.rate_hz),
      pkg.features.peak_g, pkg.features.min_g, pkg.features.tilt_before,
      pkg.features.tilt_after, pkg.features.tilt_delta_deg,
      static_cast<unsigned>(pkg.features.confidence),
      static_cast<unsigned>(pkg.features.flags),
      static_cast<unsigned long>(pkg.features.t_impact_ms),
      static_cast<unsigned long>(pkg.features.t_end_ms));
  g_event_lock.unlock();
  if (n <= 0 || n >= static_cast<int>(sizeof(buf))) {
    return String("{\"ready\":0}");
  }
  return String(buf);
}

// Returns the requested slice of the pending fall waveform as packed little
// endian int16 triples: ax, ay, az (milli-g), gx, gy, gz (0.1 deg/s).
static std::vector<uint8_t> steadyEventChunk(int32_t start, int32_t count) {
  std::vector<uint8_t> out;
  if (count < 1) {
    return out;
  }
  if (count > STEADY_CHUNK_SAMPLES) {
    count = STEADY_CHUNK_SAMPLES;
  }
  if (start < 0) {
    start = 0;
  }
  g_event_lock.lock();
  if (g_event.ready) {
    for (int32_t i = start; i < start + count && i < static_cast<int32_t>(g_event.count); ++i) {
      const uint8_t* raw = reinterpret_cast<const uint8_t*>(&g_event.samples[i]);
      out.insert(out.end(), raw, raw + sizeof(PackedSample));
    }
  }
  g_event_lock.unlock();
  return out;
}

static bool steadyEventAck() {
  g_event_lock.lock();
  const bool had_event = g_event.ready;
  g_event.ready = false;
  g_event.count = 0;
  g_event_lock.unlock();
  return had_event;
}

static bool steadySetThresholds(float impact_g, float tilt_deg) {
  if (impact_g < 1.5f || impact_g > 8.0f || tilt_deg < 20.0f || tilt_deg > 120.0f) {
    return false;
  }
  FallConfig cfg = g_detector.config();
  cfg.impact_g = impact_g;
  cfg.impact_only_g = impact_g + 1.0f;
  cfg.tilt_change_deg = tilt_deg;
  g_detector.configure(cfg);
  return true;
}
#endif  // STEADY_HAS_BRIDGE

// ---------------------------------------------------------------- lifecycle
void setup() {
  Serial.begin(115200);
  g_sample_queue.init();
  g_telemetry_queue.init();
  g_event_lock.init();
  g_window.clear();
  g_orientation.reset();
  g_detector.configure(FallConfig{});

  if (!detectSensor()) {
    Serial.println("[steady] MPU6050 not found on Wire or Wire1 - check SDA/SCL/3V3/GND");
  } else {
    Serial.print("[steady] MPU6050 online, WHO_AM_I=0x");
    Serial.println(g_imu.whoAmI(), HEX);
  }

#if STEADY_HAS_BRIDGE
  if (!Bridge.begin()) {
    Serial.println("[steady] Bridge unavailable - telemetry will only reach serial");
  }
  Bridge.provide_safe("steady_status", steadyStatus);
  Bridge.provide_safe("steady_event_meta", steadyEventMeta);
  Bridge.provide_safe("steady_event_chunk", steadyEventChunk);
  Bridge.provide_safe("steady_event_ack", steadyEventAck);
  Bridge.provide_safe("steady_set_thresholds", steadySetThresholds);
#endif

#if STEADY_ZEPHYR
  // The sampler must preempt everything else; the detector sits behind it so a
  // sample is never dropped while the FSM is busy.
  g_sampler_thread.start("steady_sampler", samplerTask, nullptr, 2, g_sampler_stack,
                         K_THREAD_STACK_SIZEOF(g_sampler_stack));
  g_detector_thread.start("steady_detector", detectorTask, nullptr, 3,
                          g_detector_stack, K_THREAD_STACK_SIZEOF(g_detector_stack));
  g_uplink_thread.start("steady_uplink", uplinkTask, nullptr, 5, g_uplink_stack,
                        K_THREAD_STACK_SIZEOF(g_uplink_stack));
#endif

  Serial.println("[steady] firmware ready");
}

void loop() {
#if STEADY_ZEPHYR
  // All work runs in kernel threads. The loop thread is the context Zephyr uses
  // to run the provide_safe() callbacks, so it stays free.
  steadySleepMs(50);
#else
  // Single-threaded bench build (no Zephyr): drive the same pipeline inline.
  static uint32_t next_sample = 0;
  static uint32_t next_telemetry = 0;
  static uint32_t last_retry = 0;

  const uint32_t now = steadyNowMs();
  if (!g_imu.present() && now - last_retry >= 2000) {
    last_retry = now;
    g_sensor_retries++;
    detectSensor();
  }

  if (now >= next_sample) {
    next_sample = now + STEADY_SAMPLE_PERIOD_MS;
    ImuSample sample;
    if (g_imu.present() && g_imu.read(sample, now)) {
      g_sample_count++;
      processSample(sample);
      if (now >= next_telemetry) {
        next_telemetry = now + (1000 / STEADY_TELEMETRY_HZ);
        publishTelemetry(sample);
      }
    }
  }
  pumpUplink();
#endif
}
