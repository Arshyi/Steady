/**
 * Steady analysis engine — pure functions, no I/O.
 *
 * The website re-derives the fall evidence from the waveform the device
 * uploaded, independently of the firmware's decision, so the dashboard can show
 * agreement/disagreement and let a human review borderline alerts. Thresholds
 * mirror firmware/steady/sketch/fall_detector.h.
 */

export const DEFAULT_THRESHOLDS = {
  freefallG: 0.5,
  freefallMinMs: 100,
  impactG: 2.5,
  impactOnlyG: 3.5,
  tiltChangeDeg: 45,
  stillStdG: 0.08,
  settleMs: 1000,
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round = (v, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

function mean(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function std(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / values.length);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Unpacks the device's flat int16 array (mg + 0.1 dps) into physical units. */
export function decodeWaveform(waveform) {
  if (!waveform || !Array.isArray(waveform.samples)) return [];
  const rateHz = Number(waveform.rate_hz) || 200;
  const out = [];
  const raw = waveform.samples;
  for (let i = 0; i + 5 < raw.length; i += 6) {
    out.push({
      ax: raw[i] / 1000,
      ay: raw[i + 1] / 1000,
      az: raw[i + 2] / 1000,
      gx: raw[i + 3] / 10,
      gy: raw[i + 4] / 10,
      gz: raw[i + 5] / 10,
    });
  }
  return { rateHz, samples: out };
}

const svmOf = (s) => Math.hypot(s.ax, s.ay, s.az);

/** Angle between the sensor +Z axis and gravity: 0 = upright, 90 = lying. */
const tiltOf = (s) => {
  const norm = svmOf(s);
  if (norm < 1e-6) return null;
  return (Math.acos(clamp(s.az / norm, -1, 1)) * 180) / Math.PI;
};

function longestRunMs(flags, rateHz) {
  let best = 0;
  let run = 0;
  for (const flag of flags) {
    if (flag) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return (best / rateHz) * 1000;
}

/**
 * Feature extraction over one fall window (2 s before + 1 s after impact).
 * Returns null when the window is too short to judge.
 */
export function summarizeWindow(decoded, thresholds = DEFAULT_THRESHOLDS) {
  const { rateHz, samples } = decoded || {};
  if (!samples || samples.length < Math.max(10, rateHz * 0.02)) return null;

  const svm = samples.map(svmOf);
  const tilts = samples.map(tiltOf);
  const spanMs = (samples.length / rateHz) * 1000;

  let impactIndex = 0;
  for (let i = 1; i < svm.length; i += 1) {
    if (svm[i] > svm[impactIndex]) impactIndex = i;
  }

  const freefallMs = longestRunMs(
    svm.map((v) => v < thresholds.freefallG),
    rateHz,
  );

  const preFrom = Math.max(0, impactIndex - Math.round(rateHz * 0.8));
  const preTo = Math.max(preFrom + 1, impactIndex - Math.round(rateHz * 0.1));
  const preTilts = tilts.slice(preFrom, preTo).filter((v) => v !== null);
  const tailCount = Math.min(samples.length, Math.round(rateHz * 0.3));
  const postTilts = tilts.slice(samples.length - tailCount).filter((v) => v !== null);

  const tiltBeforeDeg = median(preTilts.length ? preTilts : tilts.filter((v) => v !== null));
  const tiltAfterDeg = median(postTilts.length ? postTilts : tilts.filter((v) => v !== null));
  const tiltDeltaDeg = Math.abs(tiltAfterDeg - tiltBeforeDeg);

  const postWindow = Math.max(2, Math.round(rateHz * 0.5));
  const postSvm = svm.slice(Math.max(impactIndex, svm.length - postWindow));

  // Longest stretch after the impact where a 200 ms sliding std stays below the
  // stillness threshold: how long the person stayed motionless.
  const stillWindow = Math.max(2, Math.round(rateHz * 0.2));
  const stillFlags = [];
  for (let i = impactIndex; i < svm.length; i += 1) {
    const from = Math.max(impactIndex, i - stillWindow);
    const slice = svm.slice(from, i + 1);
    stillFlags.push(slice.length > 2 && std(slice) <= thresholds.stillStdG);
  }

  return {
    rateHz,
    sampleCount: samples.length,
    durationS: round(spanMs / 1000, 2),
    minG: round(Math.min(...svm), 3),
    maxG: round(Math.max(...svm), 3),
    meanG: round(mean(svm), 3),
    stdG: round(std(svm), 3),
    activityIndex: round(std(svm), 3),
    freefallMs: Math.round(freefallMs),
    impactIndex,
    impactTimeS: round(impactIndex / rateHz, 2),
    impactPeakG: round(svm[impactIndex], 2),
    tiltBeforeDeg: round(tiltBeforeDeg, 1),
    tiltAfterDeg: round(tiltAfterDeg, 1),
    tiltDeltaDeg: round(tiltDeltaDeg, 1),
    postStdG: round(std(postSvm), 3),
    postMeanG: round(mean(postSvm), 3),
    stillMsAfterImpact: Math.round(longestRunMs(stillFlags, rateHz)),
  };
}

/**
 * Rule set identical in spirit to the firmware FSM: impact + posture change +
 * (weightless phase or a very hard impact), scored out of 100.
 */
export function classify(summary, thresholds = DEFAULT_THRESHOLDS) {
  if (!summary) {
    return { verdict: "unknown", score: 0, evidence: {}, notes: ["no waveform uploaded"] };
  }

  const evidence = {
    freefall: summary.freefallMs >= thresholds.freefallMinMs,
    impact: summary.impactPeakG >= thresholds.impactG,
    hardImpact: summary.impactPeakG >= thresholds.impactOnlyG,
    posture: summary.tiltDeltaDeg >= thresholds.tiltChangeDeg,
    still: summary.postStdG <= thresholds.stillStdG,
  };

  let score = 0;
  if (evidence.freefall) score += 30;
  if (evidence.impact) score += 20;
  if (evidence.hardImpact) score += 5;
  score += 30 * clamp(summary.tiltDeltaDeg / 90, 0, 1);
  if (evidence.still) score += 15;
  score = Math.round(clamp(score, 0, 100));

  const hasImpactEvidence = evidence.freefall || evidence.hardImpact;
  let verdict = "not-fall";
  if (evidence.impact && evidence.posture && hasImpactEvidence && score >= 70) {
    verdict = "fall";
  } else if ((evidence.impact || evidence.freefall) && evidence.posture) {
    verdict = "near-fall";
  }

  const notes = [];
  notes.push(
    evidence.freefall
      ? `Weightless for ${summary.freefallMs} ms (needs ${thresholds.freefallMinMs} ms).`
      : `No weightless phase (longest low-g stretch ${summary.freefallMs} ms).`,
  );
  notes.push(
    `Impact peak ${summary.impactPeakG} g (threshold ${thresholds.impactG} g).`,
  );
  notes.push(
    evidence.posture
      ? `Posture swung ${summary.tiltDeltaDeg}° (${summary.tiltBeforeDeg}° → ${summary.tiltAfterDeg}°).`
      : `Posture barely changed (${summary.tiltDeltaDeg}°, needs ${thresholds.tiltChangeDeg}°).`,
  );
  notes.push(
    evidence.still
      ? `Person motionless after impact (std ${summary.postStdG} g).`
      : `Still moving after impact (std ${summary.postStdG} g) — could be a stumble or a call for help.`,
  );

  return { verdict, score, evidence, notes };
}

export function severityOf(summary, verdict) {
  if (verdict !== "fall" || !summary) return "low";
  if (summary.impactPeakG >= 4 && summary.tiltDeltaDeg >= 60) return "high";
  return "medium";
}

/**
 * Full server-side judgement of one stored event, including whether the device
 * and the server agree.
 */
export function analyseEvent(event, thresholds = DEFAULT_THRESHOLDS) {
  const decoded = decodeWaveform(event.waveform);
  const summary = summarizeWindow(decoded, thresholds);
  const judgement = classify(summary, thresholds);
  const deviceScore = Number(event.confidence) || 0;
  const deviceSaysFall = deviceScore >= 70;

  let agreement = "no-waveform";
  if (summary) {
    if (judgement.verdict === "fall" && deviceSaysFall) agreement = "agree";
    else if (judgement.verdict === "fall") agreement = "server-only";
    else if (deviceSaysFall) agreement = "device-only";
    else agreement = "agree-not-fall";
  }

  const notes = [...judgement.notes];
  if (agreement === "device-only") {
    notes.push("Device called this a fall but the uploaded window does not support it — review for a false alarm.");
  } else if (agreement === "server-only") {
    notes.push("The uploaded window looks like a fall but the device did not confirm it — check the on-device thresholds.");
  }

  return {
    summary,
    verdict: judgement.verdict,
    serverScore: judgement.score,
    deviceScore,
    agreement,
    severity: severityOf(summary, judgement.verdict),
    evidence: judgement.evidence,
    notes,
  };
}
