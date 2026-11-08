// Steady — thin RTOS shim.
//
// Arduino sketches on the UNO Q are built on Zephyr, so the firmware uses real
// Zephyr kernel objects: preemptive threads with static stacks, blocking
// message queues between them, and a mutex for the event package the RPC
// thread reads. When the same sketch is compiled for a board without Zephyr
// (a plain UNO/Nano used to bench-test the wiring), the shim degrades to the
// single-threaded cooperative path driven from loop().
#pragma once

#include <Arduino.h>
#include <stdint.h>
#include <string.h>

#if defined(__ZEPHYR__) && __has_include(<zephyr/kernel.h>)
#include <zephyr/kernel.h>
#define STEADY_ZEPHYR 1
#else
#define STEADY_ZEPHYR 0
#endif

#if STEADY_ZEPHYR
#define STEADY_DEFINE_STACK(name, bytes) K_THREAD_STACK_DEFINE(name, bytes)
#else
#define STEADY_DEFINE_STACK(name, bytes) static uint8_t name[(bytes)]
#endif

inline uint32_t steadyNowMs() {
#if STEADY_ZEPHYR
  return static_cast<uint32_t>(k_uptime_get());
#else
  return millis();
#endif
}

inline void steadySleepMs(uint32_t ms) {
#if STEADY_ZEPHYR
  if (ms > 0) {
    k_msleep(ms);
  }
#else
  if (ms > 0) {
    delay(ms);
  }
#endif
}

// ------------------------------------------------------------------- mutex
class SteadyMutex {
 public:
  void init() {
#if STEADY_ZEPHYR
    k_mutex_init(&handle_);
#endif
  }
  void lock() {
#if STEADY_ZEPHYR
    k_mutex_lock(&handle_, K_FOREVER);
#endif
  }
  void unlock() {
#if STEADY_ZEPHYR
    k_mutex_unlock(&handle_);
#endif
  }

 private:
#if STEADY_ZEPHYR
  struct k_mutex handle_{};
#endif
};

// ------------------------------------------------------------- sample queue
// Fixed-capacity, lock-free producer -> consumer queue. Producers never block:
// if the consumer ever falls behind the oldest sample is dropped, which is the
// correct failure mode for a real-time sampler.
template <typename T, uint16_t N>
class SteadyQueue {
 public:
  void init() {
#if STEADY_ZEPHYR
    k_msgq_init(&queue_, storage_, sizeof(T), N);
#endif
  }

  bool push(const T& value) {
#if STEADY_ZEPHYR
    int rc = k_msgq_put(&queue_, &value, K_NO_WAIT);
    if (rc == -ENOMSG) {  // full: discard the oldest entry and retry once
      T discarded;
      k_msgq_get(&queue_, &discarded, K_NO_WAIT);
      rc = k_msgq_put(&queue_, &value, K_NO_WAIT);
    }
    if (rc != 0) {
      dropped_++;
      return false;
    }
    return true;
#else
    (void)value;
    dropped_++;
    return false;
#endif
  }

  bool pop(T& out, uint32_t timeout_ms) {
#if STEADY_ZEPHYR
    return k_msgq_get(&queue_, &out, K_MSEC(timeout_ms)) == 0;
#else
    (void)out;
    (void)timeout_ms;
    return false;
#endif
  }

  uint32_t dropped() const { return dropped_; }

 private:
#if STEADY_ZEPHYR
  struct k_msgq queue_{};
  __attribute__((aligned(8))) uint8_t storage_[N * sizeof(T)]{};
#endif
  uint32_t dropped_ = 0;
};

// ------------------------------------------------------------------ thread
#if STEADY_ZEPHYR
class SteadyThread {
 public:
  using Entry = void (*)(void*);

  bool start(const char* name, Entry entry, void* arg, int priority,
             k_thread_stack_t* stack, size_t stack_bytes) {
    entry_ = entry;
    arg_ = arg;
    tid_ = k_thread_create(&handle_, stack, stack_bytes, &SteadyThread::trampoline,
                           this, nullptr, nullptr, priority, 0, K_NO_WAIT);
    if (tid_ == nullptr) {
      return false;
    }
    k_thread_name_set(tid_, name);
    return true;
  }

 private:
  static void trampoline(void* p1, void* p2, void* p3) {
    (void)p2;
    (void)p3;
    auto* self = static_cast<SteadyThread*>(p1);
    if (self->entry_ != nullptr) {
      self->entry_(self->arg_);
    }
  }

  struct k_thread handle_{};
  k_thread_t* tid_ = nullptr;
  Entry entry_ = nullptr;
  void* arg_ = nullptr;
};
#endif
