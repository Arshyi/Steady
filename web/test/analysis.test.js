import test from "node:test";
import assert from "node:assert/strict";

import {
  analyseEvent,
  classify,
  decodeWaveform,
  severityOf,
  summarizeWindow,
} from "../src/analysis.js";

const RATE = 200;

// Deterministic pseudo-noise so the tests do not flake.
let seed = 123456789;
function noise(scale) {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (((seed >>> 8) & 0xffff) / 32768 - 1) * scale;
}

const pack = (samples) => {
  const flat = [];
  for (const s of samples) {
    flat.push(
      Math.round(s.ax * 1000),
      Math.round(s.ay * 1000),
      Math.round(s.az * 1000),
      Math.round((s.gx || 0) * 10),
      Math.round((s.gy || 0) * 10),
      Math.round((s.gz || 0) * 10),
    );
  }
  return { rate_hz: RATE, samples: flat, units: { accel: "mg", gyro: "0.1 dps" } };
};

const upright = (seconds) => {
  const out = [];
  for (let i = 0; i < seconds * RATE; i += 1) {
    out.push({ ax: noise(0.02), ay: noise(0.02), az: 1 + noise(0.01) });
  }
  return out;
};

const walking = (seconds) => {
  const out = [];
  for (let i = 0; i < seconds * RATE; i += 1) {
    const t = i / RATE;
    out.push({
      ax: 0.45 * Math.sin(2 * Math.PI * 1.8 * t) + noise(0.05),
      ay: 0.3 * Math.sin(2 * Math.PI * 1.8 * t + 1.1) + noise(0.05),
      az: 1 + 0.55 * Math.sin(2 * Math.PI * 3.6 * t) + noise(0.05),
      gx: 20 * Math.sin(2 * Math.PI * 1.8 * t),
      gy: noise(8),
      gz: noise(8),
    });
  }
  return out;
};

const freefall = (seconds) => {
  const out = [];
  for (let i = 0; i < seconds * RATE; i += 1) {
    out.push({ ax: noise(0.05), ay: noise(0.05), az: 0.09 + noise(0.05) });
  }
  return out;
};

const impact = (seconds, g) => {
  const out = [];
  const n = seconds * RATE;
  for (let i = 0; i < n; i += 1) {
    const level = g * (1 - 0.55 * (i / n));
    out.push({ ax: noise(0.4), ay: level * 0.9, az: level * 0.35 });
  }
  return out;
};

const lying = (seconds, motion = 0.03) => {
  const out = [];
  for (let i = 0; i < seconds * RATE; i += 1) {
    const t = i / RATE;
    out.push({
      ax: noise(motion * 0.6),
      ay: 1 + motion * Math.sin(2 * Math.PI * 3 * t) + noise(motion * 0.5),
      az: 0.1 + noise(motion * 0.5),
    });
  }
  return out;
};

const sitDown = (seconds) => {
  const out = [];
  const n = seconds * RATE;
  for (let i = 0; i < n; i += 1) {
    const p = i / n;
    const spike = 2.8 * Math.exp(-18 * p);
    const lean = 0.42 * Math.min(1, p * 3);
    out.push({
      ax: noise(0.06),
      ay: lean + spike * 0.7,
      az: Math.sqrt(1 - lean * lean) + spike * 0.3,
    });
  }
  return out;
};

test("decodeWaveform converts milli-g and 0.1 dps into physical units", () => {
  const decoded = decodeWaveform({
    rate_hz: 100,
    samples: [1000, -500, 999, 123, -456, 78],
  });
  assert.equal(decoded.rateHz, 100);
  assert.equal(decoded.samples.length, 1);
  assert.equal(decoded.samples[0].ax, 1);
  assert.equal(decoded.samples[0].ay, -0.5);
  assert.equal(decoded.samples[0].gz, 7.8);
});

test("walking produces no fall verdict", () => {
  const decoded = decodeWaveform(pack(walking(3)));
  const summary = summarizeWindow(decoded);
  const judgement = classify(summary);

  assert.ok(summary, "summary computed");
  assert.ok(summary.impactPeakG < 2.5, `peak ${summary.impactPeakG} g should stay under the impact threshold`);
  assert.equal(summary.freefallMs, 0);
  assert.notEqual(judgement.verdict, "fall");
});

test("forward fall is classified as a fall", () => {
  const decoded = decodeWaveform(
    pack([...walking(2), ...freefall(0.25), ...impact(0.1, 6), ...lying(2)]),
  );
  const summary = summarizeWindow(decoded);
  const judgement = classify(summary);

  assert.ok(summary);
  assert.ok(summary.freefallMs >= 200, `free fall was ${summary.freefallMs} ms`);
  assert.ok(summary.impactPeakG >= 4, `impact peak ${summary.impactPeakG} g`);
  assert.ok(summary.tiltDeltaDeg >= 45, `tilt delta ${summary.tiltDeltaDeg} deg`);
  assert.equal(judgement.verdict, "fall");
  assert.ok(judgement.score >= 70, `score ${judgement.score}`);
  assert.equal(severityOf(summary, judgement.verdict), "high");
});

test("fall into bed with short free fall still counts", () => {
  const decoded = decodeWaveform(
    pack([...upright(1.5), ...freefall(0.2), ...impact(0.08, 3.1), ...lying(2, 0.12)]),
  );
  const summary = summarizeWindow(decoded);
  const judgement = classify(summary);

  assert.equal(judgement.verdict, "fall");
  assert.equal(judgement.evidence.still, false, "person kept moving after impact");
  assert.equal(severityOf(summary, judgement.verdict), "medium");
});

test("sitting down hard is not a fall", () => {
  const decoded = decodeWaveform(pack([...walking(2), ...sitDown(3)]));
  const summary = summarizeWindow(decoded);
  const judgement = classify(summary);

  assert.ok(summary.tiltDeltaDeg < 45, `tilt delta ${summary.tiltDeltaDeg}`);
  assert.notEqual(judgement.verdict, "fall");
});

test("short windows are rejected instead of guessed", () => {
  const decoded = decodeWaveform(pack(upright(0.005)));
  assert.equal(summarizeWindow(decoded), null);
  assert.equal(classify(null).verdict, "unknown");
});

test("analyseEvent reports device/server agreement both ways", () => {
  const fallWindow = pack([...walking(2), ...freefall(0.25), ...impact(0.1, 6), ...lying(2)]);

  const agreeing = analyseEvent({ waveform: fallWindow, confidence: 88 });
  assert.equal(agreeing.verdict, "fall");
  assert.equal(agreeing.agreement, "agree");
  assert.ok(agreeing.notes.length >= 3);

  const deviceOnly = analyseEvent({ waveform: pack(walking(3)), confidence: 88 });
  assert.equal(deviceOnly.verdict, "not-fall");
  assert.equal(deviceOnly.agreement, "device-only");
  assert.ok(deviceOnly.notes.some((note) => note.includes("false alarm")));

  const quiet = analyseEvent({ waveform: pack(walking(3)), confidence: 12 });
  assert.equal(quiet.agreement, "agree-not-fall");

  const noWaveform = analyseEvent({ waveform: null, confidence: 90 });
  assert.equal(noWaveform.agreement, "no-waveform");
  assert.equal(noWaveform.verdict, "unknown");
});

test("thresholds are respected when tuned stricter", () => {
  const decoded = decodeWaveform(
    pack([...walking(2), ...freefall(0.25), ...impact(0.1, 6), ...lying(2)]),
  );
  const strict = summarizeWindow(decoded, { ...{ freefallMinMs: 100, freefallG: 0.5, impactG: 2.5, impactOnlyG: 3.5, tiltChangeDeg: 120, stillStdG: 0.08 } });
  const judgement = classify(strict, { freefallMinMs: 100, freefallG: 0.5, impactG: 2.5, impactOnlyG: 3.5, tiltChangeDeg: 120, stillStdG: 0.08 });
  assert.equal(judgement.evidence.posture, false);
  assert.notEqual(judgement.verdict, "fall");
});
