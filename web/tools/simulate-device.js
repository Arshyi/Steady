#!/usr/bin/env node
/**
 * Posts realistic Steady traffic to a running dashboard, so the site can be
 * developed and demonstrated without a board.
 *
 *   node tools/simulate-device.js --url http://127.0.0.1:8787 \
 *     --token dev-token --device steady-001 --minutes 30 --fall
 *
 * It backfills 10 Hz telemetry (matching what the firmware publishes), then
 * uploads one fall event with a 3 s waveform packed exactly like the MCU does.
 */

const RATE_HZ = 10;
const WAVE_RATE = 200;

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return true;
  return value;
};

const baseUrl = String(arg("url", "http://127.0.0.1:8787")).replace(/\/$/, "");
const token = String(arg("token", process.env.STEADY_TOKEN || "dev-token"));
const device = String(arg("device", "steady-001"));
const minutes = Number(arg("minutes", 30));
const withFall = Boolean(arg("fall", false));
const endpoint = `${baseUrl}/api/v1/ingest`;

let seed = Number(arg("seed", 987654321));
function noise(scale) {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (((seed >>> 8) & 0xffff) / 32768 - 1) * scale;
}

function telemetryAt(tSec) {
  // Sleep/wake cycles: active blocks alternate with calm blocks.
  const cycle = Math.sin((2 * Math.PI * tSec) / 90);
  const active = cycle > 0 ? cycle : 0;
  const ax = 0.35 * active * Math.sin(2 * Math.PI * 1.7 * tSec) + noise(0.02);
  const ay = 0.25 * active * Math.sin(2 * Math.PI * 1.7 * tSec + 1.1) + noise(0.02);
  const az = 1 + 0.5 * active * Math.sin(2 * Math.PI * 3.4 * tSec) + noise(0.02);
  const roll = 12 * active * Math.sin(2 * Math.PI * 0.12 * tSec) + noise(2);
  const pitch = -8 * active * Math.cos(2 * Math.PI * 0.09 * tSec) + noise(2);

  return {
    ax: +ax.toFixed(3),
    ay: +ay.toFixed(3),
    az: +az.toFixed(3),
    gx: +(20 * active * Math.sin(2 * Math.PI * 1.7 * tSec) + noise(3)).toFixed(1),
    gy: +noise(6).toFixed(1),
    gz: +noise(6).toFixed(1),
    roll: +roll.toFixed(1),
    pitch: +pitch.toFixed(1),
    tilt: +Math.abs(pitch * 0.6).toFixed(1),
    svm: +Math.hypot(ax, ay, az).toFixed(3),
    state: 0,
  };
}

function waveform() {
  const samples = [];
  const push = (ax, ay, az, gx = 0, gy = 0, gz = 0) =>
    samples.push(
      Math.round(ax * 1000),
      Math.round(ay * 1000),
      Math.round(az * 1000),
      Math.round(gx * 10),
      Math.round(gy * 10),
      Math.round(gz * 10),
    );

  for (let i = 0; i < 2 * WAVE_RATE; i += 1) {
    const t = i / WAVE_RATE;
    push(0.3 * Math.sin(2 * Math.PI * 1.8 * t) + noise(0.05), 0.2 * Math.sin(2 * Math.PI * 1.8 * t + 1), 1 + noise(0.05), 15, noise(5), noise(5));
  }
  for (let i = 0; i < 0.25 * WAVE_RATE; i += 1) push(noise(0.05), noise(0.05), 0.1 + noise(0.05), noise(20), noise(20), noise(20));
  for (let i = 0; i < 0.1 * WAVE_RATE; i += 1) {
    const level = 6 * (1 - (0.55 * i) / (0.1 * WAVE_RATE));
    push(noise(0.4), level * 0.9, level * 0.35, noise(120), noise(120), noise(120));
  }
  for (let i = 0; i < 1.0 * WAVE_RATE; i += 1) push(noise(0.02), 1 + noise(0.03), 0.1 + noise(0.02), noise(8), noise(8), noise(8));

  return {
    rate_hz: WAVE_RATE,
    units: { accel: "mg", gyro: "0.1 dps" },
    samples,
  };
}

async function post(payload) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-device-id": device,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ingest failed: HTTP ${response.status} ${text}`);
  }
  return JSON.parse(text);
}

async function main() {
  const now = Date.now();
  const total = Math.max(1, Math.round(minutes * 60 * RATE_HZ));
  const start = now - minutes * 60 * 1000;

  console.log(`[sim] ${device} → ${endpoint}`);
  console.log(`[sim] backfilling ${minutes} min of telemetry (${total} samples)`);

  const batchSize = 200;
  let sent = 0;
  for (let i = 0; i < total; i += batchSize) {
    const samples = [];
    for (let j = i; j < Math.min(total, i + batchSize); j += 1) {
      const ts = start + Math.round((j * 1000) / RATE_HZ);
      samples.push({ ts, ...telemetryAt((j / RATE_HZ) % 900) });
    }
    await post({ device, firmware: "1.0.0-sim", samples });
    sent += samples.length;
    process.stdout.write(`\r[sim] samples sent: ${sent}/${total}`);
  }
  process.stdout.write("\n");

  if (withFall) {
    const event = {
      uid: `${device}-sim-${now}`,
      ts: now - 45 * 1000,
      device_ts: 123456,
      duration_ms: 1450,
      peak_g: 6.02,
      min_g: 0.11,
      tilt_before: 6.4,
      tilt_after: 88.1,
      tilt_delta: 81.7,
      confidence: 95,
      flags: 15,
      rate_hz: WAVE_RATE,
      waveform: waveform(),
    };
    const result = await post({ device, firmware: "1.0.0-sim", events: [event] });
    console.log(`[sim] fall event stored: ${JSON.stringify(result.stored)}`);
  }

  const health = await fetch(`${baseUrl}/api/v1/health`).then((r) => r.json());
  console.log(`[sim] done · health: ${JSON.stringify(health)}`);
}

main().catch((err) => {
  console.error(`[sim] ${err.message}`);
  process.exit(1);
});
