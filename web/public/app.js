const els = {
  deviceSelect: document.getElementById("device-select"),
  refresh: document.getElementById("refresh"),
  logout: document.getElementById("logout"),
  auth: document.getElementById("auth"),
  keyInput: document.getElementById("key-input"),
  keySave: document.getElementById("key-save"),
  last: document.getElementById("kpi-last"),
  firmware: document.getElementById("kpi-firmware"),
  posture: document.getElementById("kpi-posture"),
  tilt: document.getElementById("kpi-tilt"),
  activity: document.getElementById("kpi-activity"),
  falls: document.getElementById("kpi-falls"),
  fallSub: document.getElementById("kpi-fall-sub"),
  chartSvm: document.getElementById("chart-svm"),
  chartTilt: document.getElementById("chart-tilt"),
  eventsBody: document.getElementById("events-body"),
  exportLink: document.getElementById("export"),
  detail: document.getElementById("detail"),
  detailTitle: document.getElementById("detail-title"),
  detailBody: document.getElementById("detail-body"),
  detailClose: document.getElementById("detail-close"),
  status: document.getElementById("status"),
  toast: document.getElementById("toast"),
};

const state = {
  key: localStorage.getItem("steady:key") || "",
  device: localStorage.getItem("steady:device") || "",
  timer: null,
  events: [],
};

const POLL_MS = 3000;

// ----------------------------------------------------------------- utilities
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function ago(ms) {
  if (!ms) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

let toastTimer = null;
function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle("error", isError);
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 3800);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "x-view-key": state.key, ...(options.headers || {}) },
  });
  if (response.status === 401) {
    showAuth(true);
    throw new Error("unauthorized");
  }
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.json();
}

function showAuth(visible) {
  els.auth.classList.toggle("hidden", !visible);
  if (visible) els.keyInput.focus();
}

// -------------------------------------------------------------------- charts
const COLORS = { accent: "#35d0a5", danger: "#ff6b6b", blue: "#6aa9ff", warn: "#f7b955", grid: "rgba(255,255,255,0.08)", text: "#8fa3b6" };

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(300, canvas.getBoundingClientRect().width || 320);
  const height = Number(canvas.dataset.height || canvas.getAttribute("height") || 220);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function drawChart(canvas, { values, yMin, yMax, hlines = [], color = COLORS.accent, fill = true, xLabels = [] }) {
  const { ctx, width, height } = setupCanvas(canvas);
  const pad = { l: 46, r: 14, t: 12, b: 20 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;

  ctx.clearRect(0, 0, width, height);
  ctx.font = "11px ui-monospace, Menlo, monospace";
  ctx.fillStyle = COLORS.text;
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;

  for (let i = 0; i <= 4; i += 1) {
    const y = pad.t + (plotH * i) / 4;
    const label = yMax - ((yMax - yMin) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
    ctx.fillText(label.toFixed(yMax - yMin <= 6 ? 1 : 0), 8, y + 4);
  }

  for (const line of hlines) {
    if (line.value < yMin || line.value > yMax) continue;
    const y = pad.t + plotH - plotH * ((line.value - yMin) / (yMax - yMin));
    ctx.strokeStyle = line.color;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const points = values.filter((v) => Number.isFinite(v));
  if (points.length < 2) {
    ctx.fillStyle = COLORS.text;
    ctx.fillText("waiting for data…", pad.l + 10, pad.t + plotH / 2);
    ctx.strokeStyle = COLORS.grid;
    return;
  }

  const xFor = (i) => pad.l + (plotW * i) / (points.length - 1);
  const yFor = (v) => pad.t + plotH - plotH * ((Math.min(yMax, Math.max(yMin, v)) - yMin) / (yMax - yMin));

  ctx.beginPath();
  ctx.moveTo(xFor(0), yFor(points[0]));
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(xFor(i), yFor(points[i]));

  if (fill) {
    const gradient = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
    gradient.addColorStop(0, `${color}44`);
    gradient.addColorStop(1, `${color}00`);
    ctx.save();
    ctx.lineTo(xFor(points.length - 1), pad.t + plotH);
    ctx.lineTo(pad.l, pad.t + plotH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(xFor(0), yFor(points[0]));
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(xFor(i), yFor(points[i]));
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.grid;

  for (const label of xLabels) {
    ctx.fillStyle = COLORS.text;
    const x = pad.l + (plotW * label.index) / Math.max(1, points.length - 1);
    const text = String(label.text);
    const width = ctx.measureText(text).width;
    ctx.fillText(text, Math.min(pad.l + plotW - width, Math.max(pad.l, x - width / 2)), height - 4);
  }
}

// --------------------------------------------------------------- render: KPI
function postureLabel(tilt) {
  if (!Number.isFinite(tilt)) return "—";
  if (tilt < 35) return "Upright";
  if (tilt < 65) return "Reclining";
  return "Lying";
}

function renderSummary(data) {
  const latest = data.latest;
  els.last.textContent = latest ? ago(latest.ts) : "no data";
  els.firmware.textContent = data.device_row
    ? `firmware ${data.device_row.firmware || "unknown"} · seen ${ago(data.device_row.last_seen)}`
    : "device not registered yet";

  els.posture.textContent = latest ? postureLabel(latest.tilt) : "—";
  els.tilt.textContent = latest ? `${latest.tilt.toFixed(0)}° from vertical · |a| ${latest.svm.toFixed(2)} g` : "";

  els.activity.textContent = Number.isFinite(data.activity_index) ? data.activity_index.toFixed(3) : "—";

  const events = data.events || {};
  els.falls.textContent = `${events.confirmed || 0} / ${events.total || 0}`;
  els.fallSub.textContent = `${events.false_alarms || 0} marked false alarm · window ${data.window_hours} h`;

  document.getElementById("kpis")?.classList.toggle(
    "fresh",
    Boolean(latest && Date.now() - latest.ts < 15000),
  );
}

function renderSeries(data) {
  const points = data.points || [];
  const svm = points.map((p) => Number(p.svm));
  const tilt = points.map((p) => Number(p.tilt));
  const xLabels = points.length
    ? [
        { index: 0, text: clockTime(points[0].bucket) },
        { index: points.length - 1, text: clockTime(points[points.length - 1].bucket) },
      ]
    : [];

  drawChart(els.chartSvm, {
    values: svm,
    yMin: 0,
    yMax: Math.max(4, Math.ceil(Math.max(...svm.filter(Number.isFinite), 2.5) + 0.5)),
    hlines: [
      { value: 2.5, color: COLORS.danger },
      { value: 0.5, color: COLORS.blue },
    ],
    color: COLORS.accent,
    xLabels,
  });

  drawChart(els.chartTilt, {
    values: tilt,
    yMin: 0,
    yMax: 180,
    hlines: [{ value: 90, color: COLORS.warn }],
    color: COLORS.warn,
    xLabels,
  });
}

// -------------------------------------------------------------- render: list
function verdictBadge(event) {
  const verdict = event.verdict || "unknown";
  const label =
    verdict === "fall" ? "fall" : verdict === "near-fall" ? "near-fall" : verdict === "not-fall" ? "not a fall" : "unanalysed";
  const cls = verdict === "fall" ? "fall" : verdict === "near-fall" ? "near" : verdict === "not-fall" ? "none" : "unknown";
  return `<span class="badge ${cls}">${label}</span>`;
}

function reviewLabel(event) {
  if (!event.reviewed_label || event.reviewed_label === "pending") return `<span class="muted">pending</span>`;
  const cls = event.reviewed_label === "fall" ? "fall" : event.reviewed_label === "false-alarm" ? "ok" : "near";
  return `<span class="badge ${cls}">${escapeHtml(event.reviewed_label)}</span>`;
}

function renderEvents(data) {
  state.events = data.events || [];
  if (!state.events.length) {
    els.eventsBody.innerHTML = `<tr><td colspan="7" class="muted">No fall candidates yet.</td></tr>`;
    return;
  }
  els.eventsBody.innerHTML = state.events
    .map(
      (event) => `
      <tr data-id="${event.id}">
        <td>${new Date(event.ts).toLocaleString()}</td>
        <td>${event.confidence >= 70 ? `<span class="badge fall">fall</span>` : `<span class="badge none">no alert</span>`}</td>
        <td>${verdictBadge(event)}</td>
        <td>${Number(event.peak_g || 0).toFixed(2)} g</td>
        <td>${Number(event.tilt_delta || 0).toFixed(0)}°</td>
        <td>${event.confidence}%</td>
        <td>${reviewLabel(event)}</td>
      </tr>`,
    )
    .join("");

  for (const row of els.eventsBody.querySelectorAll("tr[data-id]")) {
    row.addEventListener("click", () => openEvent(Number(row.dataset.id)));
  }
}

// ------------------------------------------------------------ render: detail
function decodeEventWaveform(waveform) {
  if (!waveform || !Array.isArray(waveform.samples)) return { rate: 200, svm: [], tilt: [] };
  const rate = Number(waveform.rate_hz) || 200;
  const raw = waveform.samples;
  const svm = [];
  const tilt = [];
  for (let i = 0; i + 5 < raw.length; i += 6) {
    const ax = raw[i] / 1000;
    const ay = raw[i + 1] / 1000;
    const az = raw[i + 2] / 1000;
    const magnitude = Math.hypot(ax, ay, az);
    svm.push(magnitude);
    tilt.push(magnitude > 1e-6 ? (Math.acos(Math.min(1, Math.max(-1, az / magnitude))) * 180) / Math.PI : null);
  }
  return { rate, svm, tilt };
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

async function openEvent(id) {
  try {
    const { event } = await api(`/api/v1/events/${id}`);
    const analysis = event.analysis || {};
    const summary = analysis.summary || {};
    const waveform = decodeEventWaveform(event.waveform);
    const agreement =
      analysis.agreement === "agree"
        ? `<span class="badge ok">device &amp; server agree</span>`
        : analysis.agreement === "device-only"
          ? `<span class="badge fall">device only</span>`
          : analysis.agreement === "server-only"
            ? `<span class="badge near">server only</span>`
            : `<span class="badge none">no waveform</span>`;

    els.detailTitle.textContent = `Fall candidate · ${new Date(event.ts).toLocaleString()}`;
    els.detailBody.innerHTML = `
      <div class="detail-grid">
        <div>
          <div class="chips">
            <span class="chip ${analysis.evidence?.freefall ? "on" : ""}">free fall ${summary.freefallMs ?? 0} ms</span>
            <span class="chip ${analysis.evidence?.impact ? "on" : ""}">impact ${summary.impactPeakG ?? 0} g</span>
            <span class="chip ${analysis.evidence?.posture ? "on" : ""}">posture Δ ${summary.tiltDeltaDeg ?? 0}°</span>
            <span class="chip ${analysis.evidence?.still ? "on" : ""}">still ${summary.postStdG ?? 0} g</span>
          </div>
          <div class="metrics">
            ${metric("Device verdict", `${event.confidence}%`)}
            ${metric("Server score", `${analysis.serverScore ?? "—"}`)}
            ${metric("Severity", analysis.severity || "—")}
            ${metric("Window", `${summary.durationS ?? "—"} s @ ${summary.rateHz ?? "—"} Hz`)}
            ${metric("Posture before", `${summary.tiltBeforeDeg ?? "—"}°`)}
            ${metric("Posture after", `${summary.tiltAfterDeg ?? "—"}°`)}
          </div>
          <div class="review-row">
            ${agreement}
            <button class="btn small" data-review="fall" type="button">Real fall</button>
            <button class="btn small" data-review="false-alarm" type="button">False alarm</button>
            <button class="btn small ghost" data-review="near-fall" type="button">Near fall</button>
          </div>
        </div>
        <div>
          <h3>Uploaded waveform</h3>
          <canvas id="detail-chart" height="200" data-height="200"></canvas>
        </div>
      </div>
      <h3 style="margin-top:16px">How the analysis reads it</h3>
      <ul class="notes">
        ${(analysis.notes || []).map((note) => `<li>${escapeHtml(note)}</li>`).join("")}
      </ul>
      ${
        event.reviewed_label && event.reviewed_label !== "pending"
          ? `<p class="muted" style="margin-top:10px">Reviewed: <strong>${escapeHtml(event.reviewed_label)}</strong> · ${ago(event.reviewed_at)}${
              event.reviewed_note ? ` · ${escapeHtml(event.reviewed_note)}` : ""
            }</p>`
          : ""
      }
    `;

    els.detail.classList.remove("hidden");
    drawChart(document.getElementById("detail-chart"), {
      values: waveform.svm,
      yMin: 0,
      yMax: Math.max(4, Math.ceil(Math.max(...waveform.svm, 2.5) + 0.5)),
      hlines: [
        { value: 2.5, color: COLORS.danger },
        { value: 0.5, color: COLORS.blue },
      ],
      color: COLORS.accent,
      fill: false,
      xLabels: [
        { index: 0, text: "−2 s" },
        { index: Math.floor(waveform.svm.length / 2), text: "0" },
        { index: waveform.svm.length - 1, text: "+1 s" },
      ],
    });

    for (const button of els.detailBody.querySelectorAll("[data-review]")) {
      button.addEventListener("click", async () => {
        try {
          await api(`/api/v1/events/${id}/review`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ label: button.dataset.review }),
          });
          toast(`Marked as ${button.dataset.review}`);
          await refresh();
          await openEvent(id);
        } catch (err) {
          toast(`Review failed: ${err.message}`, true);
        }
      });
    }
    els.detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    toast(`Could not load event: ${err.message}`, true);
  }
}

// -------------------------------------------------------------------- loading
async function loadDevices() {
  const data = await api("/api/v1/devices");
  const devices = data.devices || [];
  els.deviceSelect.innerHTML = devices.length
    ? devices
        .map(
          (device) =>
            `<option value="${escapeHtml(device.id)}">${escapeHtml(device.id)}${device.falls_24h ? ` · ${device.falls_24h} alerts` : ""}</option>`,
        )
        .join("")
    : `<option value="">no devices yet</option>`;

  if (!devices.some((device) => device.id === state.device)) {
    state.device = devices[0]?.id || "";
  }
  if (state.device) {
    els.deviceSelect.value = state.device;
    localStorage.setItem("steady:device", state.device);
  }
}

async function refresh() {
  if (!state.key) {
    showAuth(true);
    return;
  }
  if (!state.device) {
    try {
      await loadDevices();
    } catch (err) {
      els.status.textContent = `error: ${err.message}`;
      return;
    }
  }
  if (!state.device) {
    els.status.textContent = "waiting for the first device to post data";
    return;
  }

  try {
    const query = `device=${encodeURIComponent(state.device)}`;
    const [summary, series, events] = await Promise.all([
      api(`/api/v1/summary?${query}&hours=24`),
      api(`/api/v1/series?${query}&minutes=15&bucket=1000`),
      api(`/api/v1/events?${query}&limit=50`),
    ]);
    showAuth(false);
    renderSummary(summary);
    renderSeries(series);
    renderEvents(events);
    els.exportLink.href = `/api/v1/export?${query}&hours=24&key=${encodeURIComponent(state.key)}`;
    els.status.textContent = `updated ${clockTime(Date.now())} · polling every ${POLL_MS / 1000}s`;
  } catch (err) {
    els.status.textContent = `error: ${err.message}`;
    if (err.message !== "unauthorized") toast(err.message, true);
  }
}

function startPolling() {
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (!document.hidden) refresh();
  }, POLL_MS);
}

// ---------------------------------------------------------------------- boot
els.keySave.addEventListener("click", async () => {
  const key = els.keyInput.value.trim();
  if (!key) return;
  state.key = key;
  localStorage.setItem("steady:key", key);
  els.keyInput.value = "";
  await loadDevices().catch(() => {});
  await refresh();
});

els.keyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") els.keySave.click();
});

els.refresh.addEventListener("click", () => refresh());

els.logout.addEventListener("click", () => {
  state.key = "";
  localStorage.removeItem("steady:key");
  showAuth(true);
  toast("View key cleared");
});

els.deviceSelect.addEventListener("change", () => {
  state.device = els.deviceSelect.value;
  localStorage.setItem("steady:device", state.device);
  refresh();
});

els.detailClose.addEventListener("click", () => els.detail.classList.add("hidden"));

window.addEventListener("resize", () => {
  refresh().catch(() => {});
});

if (!state.key) {
  showAuth(true);
} else {
  loadDevices().catch(() => {});
  refresh();
  startPolling();
}
