import "./style.css";

const app = document.querySelector("#app");
app.innerHTML = `
<header><a class="brand" href="#"><span class="orb"></span>OPEN BALL VERIFIER</a><span class="case">CASE 001 · FIFA CABLE CLAIM</span></header>
<main>
  <section class="hero"><div><p class="kicker">INDEPENDENT VIDEO FORENSICS</p><h1>Did the ball<br><em>change course?</em></h1><p class="lede">Scrub every frame. Inspect the pixels. Correct the tracker. The forecast only sees the past.</p></div><div class="verdict"><span class="vlabel">CURRENT READ</span><strong id="verdictText">No large sustained deflection</strong><div class="prob"><span id="probBar"></span></div><div class="probcopy"><b id="probValue">—</b><span>screen-space model support</span></div><small id="verdictCaveat">Loading observations…</small></div></section>
  <section class="workspace">
    <div class="stageCard"><div class="stageTop"><div><b>FRAME <span id="frameNo">20</span></b><span id="timecode">00:00.000</span></div><div id="confidence" class="badge">LOADING</div></div>
      <div id="stage" class="stage"><canvas id="canvas" width="960" height="540"></canvas><div class="loading">Loading evidence…</div></div>
      <input id="scrubber" type="range" min="20" max="216" value="20" step="1" aria-label="Frame scrubber">
      <div class="transport"><button id="prev" aria-label="Previous frame">←</button><button id="play" class="primary">▶ PLAY</button><button id="next" aria-label="Next frame">→</button><span>Drag the ring to correct · arrow keys step</span></div>
    </div>
    <aside><div class="panel"><h2>Layers</h2><label><input type="checkbox" data-layer="observed" checked><i class="cyan"></i>Observed history</label><label><input type="checkbox" data-layer="prediction" checked><i class="magenta"></i>Causal prediction</label><label><input type="checkbox" data-layer="corridor" checked><i class="corridor"></i>Uncertainty corridor</label><label><input type="checkbox" data-layer="marker" checked><i class="green"></i>Current ball</label></div>
      <div class="panel"><h2>Pixel inspector</h2><canvas id="zoom" width="280" height="180"></canvas><p>12× nearest-neighbor crop. Crosshair is the editable coordinate.</p></div>
      <div class="panel metrics"><h2>Frame evidence</h2><div><span>One-step miss</span><b id="miss">—</b></div><div><span>Track confidence</span><b id="confMetric">—</b></div><div><span>Uncertainty</span><b id="uncertainty">—</b></div><div><span>Edit state</span><b id="editState">Original</b></div></div>
    </aside>
  </section>
  <section class="tools"><div><p class="kicker">HUMAN-IN-THE-LOOP</p><h2>Your correction changes the forecast.</h2><p>Click or drag the ball marker. Predictions are refit immediately from accepted observations strictly before the displayed frame—never from the future.</p></div><div class="actions"><button id="reset">Reset annotations</button><button id="export" class="primary">Export annotations ↓</button><label class="import">Import JSON<input id="importFile" type="file" accept="application/json"></label></div></section>
  <section class="method"><div><p class="kicker">WHAT THIS CAN SAY</p><h2>Evidence, not omniscience.</h2></div><div class="methodGrid"><article><b>01</b><h3>Causal forecast</h3><p>A weighted local quadratic uses up to 32 accepted prior positions. The current and future frames are excluded.</p></article><article><b>02</b><h3>Editable evidence</h3><p>Ambiguous machine observations stay visible. Human corrections are local, reversible and exportable.</p></article><article><b>03</b><h3>Honest limit</h3><p>This is a 2-D screen-space test from one moving, uncalibrated camera—not a unique 3-D reconstruction of drag, spin, wind and camera pose.</p></article></div></section>
  <section class="downloads"><h2>Audit the audit</h2><div><a href="/data/track-estimates.json">Tracked coordinates ↗</a><a href="/data/causal-predictions.json">Original forecasts ↗</a><a href="/assets/fit-diagnostics.png">Fit diagnostics ↗</a><a href="https://github.com/jerbotclaw-max/open-ball-verifier">Source code ↗</a></div></section>
</main><footer>OPEN BALL VERIFIER · PUBLIC EVIDENCE BUILD · JULY 2026</footer>`;

const $ = (s) => document.querySelector(s),
  canvas = $("#canvas"),
  ctx = canvas.getContext("2d"),
  zoom = $("#zoom"),
  zctx = zoom.getContext("2d");
let rows = [],
  byFrame = new Map(),
  edits = {},
  frame = 20,
  playing = false,
  timer = null,
  dragging = false,
  image = new Image();
const layers = {
  observed: true,
  prediction: true,
  corridor: true,
  marker: true,
};
const ambiguous = new Set([
  58, 69, 70, 73, 74, 98, 103, 104, 105, 106, 107, 117, 125, 126, 127, 128, 129,
  137, 141, 142,
]);

async function init() {
  const data = await fetch("/data/track-estimates.json").then((r) => r.json());
  rows = data.rows;
  rows.forEach((r) => byFrame.set(r.frame, r));
  const saved = localStorage.getItem("ball-verifier-edits");
  if (saved)
    try {
      edits = JSON.parse(saved);
    } catch {}
  $("#scrubber").max = rows.at(-1).frame;
  document.querySelector(".loading").remove();
  await setFrame(rows[0].frame);
  updateVerdict();
  const preload = () =>
    rows.forEach((r) => {
      const i = new Image();
      i.src = `/frames/${String(r.frame - 19).padStart(3, "0")}.jpg`;
    });
  ("requestIdleCallback" in window ? requestIdleCallback : setTimeout)(preload);
}
const pos = (f) =>
  edits[f] || (byFrame.get(f) && [byFrame.get(f).x, byFrame.get(f).y]);
function accepted(f) {
  return byFrame.has(f) && !ambiguous.has(f);
}
function solve3(A, b) {
  for (let i = 0; i < 3; i++) {
    let m = i;
    for (let j = i + 1; j < 3; j++)
      if (Math.abs(A[j][i]) > Math.abs(A[m][i])) m = j;
    [A[i], A[m]] = [A[m], A[i]];
    [b[i], b[m]] = [b[m], b[i]];
    let q = A[i][i] || 1e-9;
    for (let j = i; j < 3; j++) A[i][j] /= q;
    b[i] /= q;
    for (let k = 0; k < 3; k++)
      if (k !== i) {
        q = A[k][i];
        for (let j = i; j < 3; j++) A[k][j] -= q * A[i][j];
        b[k] -= q * b[i];
      }
  }
  return b;
}
function fitAt(f) {
  const pts = rows
    .filter((r) => r.frame < f && accepted(r.frame) && pos(r.frame))
    .slice(-32);
  if (pts.length < 6) return null;
  const f0 = pts.at(-1).frame;
  const coeff = (axis) => {
    let A = Array.from({ length: 3 }, () => [0, 0, 0]),
      b = [0, 0, 0];
    pts.forEach((r, i) => {
      let t = r.frame - f0,
        w = 0.25 + (0.75 * (i + 1)) / pts.length,
        v = pos(r.frame)[axis],
        p = [1, t, t * t];
      for (let j = 0; j < 3; j++) {
        b[j] += w * p[j] * v;
        for (let k = 0; k < 3; k++) A[j][k] += w * p[j] * p[k];
      }
    });
    return solve3(A, b);
  };
  const cx = coeff(0),
    cy = coeff(1),
    evalAt = (n) => {
      let t = n - f0;
      return [
        cx[0] + cx[1] * t + cx[2] * t * t,
        cy[0] + cy[1] * t + cy[2] * t * t,
      ];
    };
  const residuals = pts
      .map((r) =>
        Math.hypot(
          pos(r.frame)[0] - evalAt(r.frame)[0],
          pos(r.frame)[1] - evalAt(r.frame)[1],
        ),
      )
      .sort((a, b) => a - b),
    sigma = Math.max(1.5, residuals[Math.floor(residuals.length * 0.68)] || 2);
  return {
    points: Array.from({ length: 24 }, (_, i) => ({
      frame: f + i,
      xy: evalAt(f + i),
      radius: sigma * (1.6 + 0.13 * i + 0.012 * i * i),
    })),
    sigma,
    pred: evalAt(f),
  };
}
function loadImage(f) {
  return new Promise((resolve, reject) => {
    image = new Image();
    image.onload = resolve;
    image.onerror = reject;
    image.src = `/frames/${String(f - 19).padStart(3, "0")}.jpg`;
  });
}
async function setFrame(f) {
  frame = Math.max(20, Math.min(216, +f));
  $("#scrubber").value = frame;
  $("#frameNo").textContent = frame;
  $("#timecode").textContent =
    `00:${String(Math.floor((frame - 20) / 30)).padStart(2, "0")}.${String(Math.round((((frame - 20) % 30) / 30) * 1000)).padStart(3, "0")}`;
  await loadImage(frame);
  draw();
  updateStats();
}
function path(points, color, width = 3, dashed = false) {
  if (points.length < 2) return;
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dashed ? [9, 7] : []);
  ctx.stroke();
  ctx.setLineDash([]);
}
function draw() {
  ctx.clearRect(0, 0, 960, 540);
  ctx.drawImage(image, 0, 0);
  let fit = fitAt(frame);
  if (fit && layers.corridor) {
    ctx.beginPath();
    fit.points.forEach((p, i) => {
      let [x, y] = p.xy,
        r = p.radius;
      i ? ctx.lineTo(x, y - r) : ctx.moveTo(x, y - r);
    });
    [...fit.points]
      .reverse()
      .forEach((p) => ctx.lineTo(p.xy[0], p.xy[1] + p.radius));
    ctx.closePath();
    ctx.fillStyle = "rgba(255,65,211,.14)";
    ctx.fill();
  }
  if (layers.observed)
    path(
      rows
        .filter((r) => r.frame <= frame && accepted(r.frame))
        .map((r) => pos(r.frame)),
      "#45e8ff",
      3,
    );
  if (fit && layers.prediction)
    path(
      fit.points.map((p) => p.xy),
      "#ff41d3",
      3,
      true,
    );
  let p = pos(frame),
    r = byFrame.get(frame);
  if (p && layers.marker) {
    ctx.beginPath();
    ctx.arc(...p, 10, 0, Math.PI * 2);
    ctx.strokeStyle = ambiguous.has(frame) ? "#ff625e" : "#9aff65";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p[0] - 15, p[1]);
    ctx.lineTo(p[0] + 15, p[1]);
    ctx.moveTo(p[0], p[1] - 15);
    ctx.lineTo(p[0], p[1] + 15);
    ctx.strokeStyle = "rgba(255,255,255,.75)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  drawZoom(p, fit);
}
function drawZoom(p, fit) {
  zctx.imageSmoothingEnabled = false;
  zctx.fillStyle = "#000";
  zctx.fillRect(0, 0, 280, 180);
  if (!p) return;
  let sw = 36,
    sh = 23;
  zctx.drawImage(image, p[0] - sw / 2, p[1] - sh / 2, sw, sh, 0, 0, 280, 180);
  zctx.strokeStyle = "#9aff65";
  zctx.lineWidth = 1;
  zctx.beginPath();
  zctx.moveTo(140, 0);
  zctx.lineTo(140, 180);
  zctx.moveTo(0, 90);
  zctx.lineTo(280, 90);
  zctx.stroke();
  if (fit) {
    let dx = ((fit.pred[0] - p[0]) * 280) / sw,
      dy = ((fit.pred[1] - p[1]) * 180) / sh;
    zctx.strokeStyle = "#ff41d3";
    zctx.strokeRect(136 + dx, 86 + dy, 8, 8);
  }
}
function updateStats() {
  let r = byFrame.get(frame),
    fit = fitAt(frame),
    p = pos(frame),
    err = fit && p ? Math.hypot(p[0] - fit.pred[0], p[1] - fit.pred[1]) : null,
    id = ambiguous.has(frame) ? "AMBIGUOUS" : r.identity.toUpperCase();
  $("#confidence").textContent = id;
  $("#confidence").className = "badge " + id.toLowerCase();
  $("#miss").textContent = err ? err.toFixed(1) + " px" : "—";
  $("#confMetric").textContent = id;
  $("#uncertainty").textContent = (r.uncertainty_px || 0).toFixed(1) + " px";
  $("#editState").textContent = edits[frame] ? "Corrected" : "Original";
  updateVerdict();
}
function updateVerdict() {
  if (!rows.length) return;
  let zs = [];
  rows.forEach((r) => {
    if (!accepted(r.frame) || r.frame < 30) return;
    let fit = fitAt(r.frame),
      p = pos(r.frame);
    if (fit && p)
      zs.push(Math.hypot(p[0] - fit.pred[0], p[1] - fit.pred[1]) / fit.sigma);
  });
  let high = zs.filter((z) => z > 3).length,
    score = Math.max(52, Math.min(94, Math.round(88 - high * 2.4)));
  $("#probValue").textContent = score + "%";
  $("#probBar").style.width = score + "%";
  $("#verdictText").textContent =
    score > 70
      ? "No large sustained deflection"
      : "Trajectory anomaly needs review";
  $("#verdictCaveat").textContent =
    `Heuristic support from ${zs.length} causal one-step comparisons—not a calibrated probability of physical contact.`;
}
function pointerPos(e) {
  let b = canvas.getBoundingClientRect();
  return [
    ((e.clientX - b.left) * 960) / b.width,
    ((e.clientY - b.top) * 540) / b.height,
  ];
}
canvas.addEventListener("pointerdown", (e) => {
  let p = pos(frame),
    q = pointerPos(e);
  if (p && Math.hypot(p[0] - q[0], p[1] - q[1]) < 35) {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  edits[frame] = pointerPos(e);
  save();
  draw();
  updateStats();
});
canvas.addEventListener("pointerup", () => (dragging = false));
canvas.addEventListener("dblclick", (e) => {
  edits[frame] = pointerPos(e);
  save();
  draw();
  updateStats();
});
function save() {
  localStorage.setItem("ball-verifier-edits", JSON.stringify(edits));
}
$("#scrubber").oninput = (e) => setFrame(e.target.value);
$("#prev").onclick = () => setFrame(frame - 1);
$("#next").onclick = () => setFrame(frame + 1);
async function tick() {
  if (!playing) return;
  await setFrame(frame >= 216 ? 20 : frame + 1);
  timer = setTimeout(tick, 1000 / 30);
}
$("#play").onclick = () => {
  playing = !playing;
  $("#play").textContent = playing ? "❚❚ PAUSE" : "▶ PLAY";
  clearTimeout(timer);
  if (playing) tick();
};
document.querySelectorAll("[data-layer]").forEach(
  (x) =>
    (x.onchange = () => {
      layers[x.dataset.layer] = x.checked;
      draw();
    }),
);
$("#reset").onclick = () => {
  if (confirm("Reset every manual correction?")) {
    edits = {};
    save();
    draw();
    updateStats();
  }
};
$("#export").onclick = () => {
  let blob = new Blob(
      [
        JSON.stringify(
          {
            schema: "open-ball-verifier-annotations-v1",
            exported: new Date().toISOString(),
            edits,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
    a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ball-verifier-annotations.json";
  a.click();
  URL.revokeObjectURL(a.href);
};
$("#importFile").onchange = async (e) => {
  let d = JSON.parse(await e.target.files[0].text());
  edits = d.edits || {};
  save();
  draw();
  updateStats();
};
window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") setFrame(frame - 1);
  if (e.key === "ArrowRight") setFrame(frame + 1);
  if (e.key === " ") {
    e.preventDefault();
    $("#play").click();
  }
});
init();
