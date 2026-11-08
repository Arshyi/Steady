#include "fall_detector.h"

#include <math.h>

namespace {
float clamp01(float v) { return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v); }
}  // namespace

void FallDetector::configure(const FallConfig& config) {
  cfg_ = config;
  reset();
}

void FallDetector::reset() {
  phase_ = FallPhase::Monitoring;
  saw_freefall_ = false;
  freefall_start_ms_ = 0;
  impact_ms_ = 0;
  refractory_until_ms_ = 0;
  min_g_ = 0.0f;
  peak_g_ = 0.0f;
  tilt_before_ = 0.0f;
  clearMotionRing();
  for (uint16_t i = 0; i < kMotionWindow; ++i) {
    tilt_history_[i] = 0.0f;
  }
  tilt_count_ = 0;
  tilt_index_ = 0;
}

void FallDetector::clearMotionRing() {
  motion_count_ = 0;
  motion_index_ = 0;
}

float FallDetector::motionStd() const {
  if (motion_count_ < 2) {
    return 99.0f;
  }
  float sum = 0.0f;
  for (uint16_t i = 0; i < motion_count_; ++i) {
    sum += motion_[i];
  }
  const float mean = sum / static_cast<float>(motion_count_);
  float acc = 0.0f;
  for (uint16_t i = 0; i < motion_count_; ++i) {
    const float d = motion_[i] - mean;
    acc += d * d;
  }
  return sqrtf(acc / static_cast<float>(motion_count_));
}

// Posture from ~500 ms ago, used as the "before the fall" reference.
float FallDetector::delayedTilt() const {
  if (tilt_count_ == 0) {
    return 0.0f;
  }
  const uint16_t oldest = (tilt_index_ + kMotionWindow - tilt_count_) % kMotionWindow;
  return tilt_history_[oldest];
}

void FallDetector::beginSettling(const ImuSample& sample, float svm,
                                 bool saw_freefall) {
  phase_ = FallPhase::Settling;
  impact_ms_ = sample.t_ms;
  peak_g_ = svm;
  clearMotionRing();
  motion_[motion_index_] = svm;
  motion_index_ = static_cast<uint16_t>((motion_index_ + 1) % kMotionWindow);
  motion_count_ = 1;
  saw_freefall_ = saw_freefall;
  if (!saw_freefall) {
    // Impact-first fall: the pre-impact posture reference is now.
    tilt_before_ = delayedTilt();
    min_g_ = svm;
  }
}

bool FallDetector::update(const ImuSample& sample, float svm, float tilt_deg,
                          FallFeatures& out) {
  // Rolling tilt history is always maintained so a posture reference exists.
  tilt_history_[tilt_index_] = tilt_deg;
  tilt_index_ = static_cast<uint16_t>((tilt_index_ + 1) % kMotionWindow);
  if (tilt_count_ < kMotionWindow) {
    tilt_count_++;
  }

  bool completed = false;

  switch (phase_) {
    case FallPhase::Monitoring:
      if (svm < cfg_.freefall_g) {
        phase_ = FallPhase::FreeFall;
        freefall_start_ms_ = sample.t_ms;
        min_g_ = svm;
        peak_g_ = 0.0f;
        saw_freefall_ = true;
        tilt_before_ = delayedTilt();
      } else if (svm >= cfg_.impact_only_g) {
        beginSettling(sample, svm, false);
      }
      break;

    case FallPhase::FreeFall: {
      if (svm < min_g_) {
        min_g_ = svm;
      }
      const uint32_t elapsed = sample.t_ms - freefall_start_ms_;
      if (svm >= cfg_.impact_g) {
        // A spike right after a single dropped sample is noise, not a fall:
        // the weightless phase has to last freefall_min_ms.
        beginSettling(sample, svm, elapsed >= cfg_.freefall_min_ms);
      } else if (elapsed >= cfg_.freefall_max_ms) {
        // Weightless for too long: thrown, dropped, or the sensor came off.
        phase_ = FallPhase::Monitoring;
        saw_freefall_ = false;
        min_g_ = 0.0f;
      }
      break;
    }

    case FallPhase::Settling: {
      if (svm > peak_g_) {
        peak_g_ = svm;
      }
      motion_[motion_index_] = svm;
      motion_index_ = static_cast<uint16_t>((motion_index_ + 1) % kMotionWindow);
      if (motion_count_ < kMotionWindow) {
        motion_count_++;
      }
      if (sample.t_ms - impact_ms_ >= cfg_.settle_ms) {
        evaluate(sample, tilt_deg, out);
        completed = true;
        phase_ = FallPhase::Refractory;
        refractory_until_ms_ = sample.t_ms + cfg_.refractory_ms;
        if (out.confirmed) {
          confirmed_count_++;
        } else {
          rejected_count_++;
        }
      }
      break;
    }

    case FallPhase::Refractory:
      if (sample.t_ms >= refractory_until_ms_) {
        phase_ = FallPhase::Monitoring;
        saw_freefall_ = false;
      }
      break;
  }

  return completed;
}

void FallDetector::evaluate(const ImuSample& sample, float tilt_deg,
                            FallFeatures& out) {
  out = FallFeatures{};
  out.saw_freefall = saw_freefall_;
  out.t_impact_ms = impact_ms_;
  out.t_start_ms = saw_freefall_ ? freefall_start_ms_ : impact_ms_;
  out.t_end_ms = sample.t_ms;
  out.min_g = min_g_;
  out.peak_g = peak_g_;
  out.tilt_before = tilt_before_;
  out.tilt_after = tilt_deg;
  out.tilt_delta_deg = fabsf(tilt_deg - tilt_before_);
  out.motion_std_g = motionStd();

  out.posture_changed = out.tilt_delta_deg >= cfg_.tilt_change_deg;
  out.still = out.motion_std_g <= cfg_.still_std_g;

  // Weighted evidence: free fall 30, impact 20, posture change up to 30,
  // post-impact stillness 15, hard impact bonus 5.
  float score = 0.0f;
  if (out.saw_freefall) {
    score += 30.0f;
  }
  if (out.peak_g >= cfg_.impact_g) {
    score += 20.0f;
  }
  if (out.peak_g >= cfg_.impact_only_g) {
    score += 5.0f;
  }
  score += 30.0f * clamp01(out.tilt_delta_deg / 90.0f);
  if (out.still) {
    score += 15.0f;
  }
  if (score > 100.0f) {
    score = 100.0f;
  }
  out.confidence = static_cast<uint8_t>(score + 0.5f);

  const bool has_impact_evidence = out.saw_freefall || out.peak_g >= cfg_.impact_only_g;
  out.confirmed = out.posture_changed && out.peak_g >= cfg_.impact_g &&
                  has_impact_evidence && out.confidence >= 70;

  if (out.saw_freefall) {
    out.flags |= kFlagFreeFall;
  }
  if (out.peak_g >= cfg_.impact_g) {
    out.flags |= kFlagImpact;
  }
  if (out.posture_changed) {
    out.flags |= kFlagPostureChange;
  }
  if (out.still) {
    out.flags |= kFlagStill;
  }
}
