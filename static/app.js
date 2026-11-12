"use strict";
/* Warehouse Robot Lab: browser side.
   The browser only draws and sends button presses to the Python server.
   All learning happens in Python (agent.py / training.py). */

// ===================================================================== helpers
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const MINUS = "−";
const fmt = (v, d = 2) => (v < 0 ? MINUS : "") + Math.abs(v).toFixed(d);
const fmtSigned = (v, d = 0) => (v > 0 ? "+" : v < 0 ? MINUS : "") + Math.abs(v).toFixed(d);
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const ACTIONS = ["Up", "Down", "Left", "Right", "Pick", "Drop"];
const MOVES = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const MIN_SIZE = 4, MAX_SIZE = 12, MAX_PICKS = 8, WINDOW = 50;
const SPEEDS = {
  watch: { chunk: 1, delay: 0 },
  slow: { chunk: 4, delay: 140 },
  normal: { chunk: 20, delay: 45 },
  fast: { chunk: 150, delay: 8 },
};
const C = {};
function readColors() {
  for (const k of ["slab", "paper", "ink", "ink-2", "ink-3", "line", "line-soft", "rack",
    "rack-dark", "beam", "robot", "robot-edge", "pad", "value"]) C[k] = cssVar("--" + k);
}

// ===================================================================== state
const S = {
  presets: {}, preset: "Warehouse",
  layout: [],                 // editable grid: array of arrays of characters
  tool: "rack", tab: "build", painting: false, lastPaint: null,
  lab: null,                  // latest snapshot from the server
  training: false, speed: "normal", targetEpisodes: 0,
  hist: { xs: [], reward: [], avg: [], success: [], steps: [], okFlags: [], sumR: 0, sumS: 0 },
  layers: { heat: true, arrows: true, trail: true },
  view: { order: 0, carrying: 0 },
  robot: null, robotDraw: null, heading: [1, 0], trail: [],
  startMode: "random", chosenStart: null,
  delivery: null, playing: false,
  auto: false, stepTrail: null, stepCell: null,
};

// ===================================================================== layout
const layoutStrings = () => S.layout.map((r) => r.join(""));
const rows = () => S.layout.length;
const cols = () => S.layout[0].length;
const colName = (c) => String.fromCharCode(65 + c);
const cellCode = (r, c) => colName(c) + (r + 1);

function picksOf() {
  const out = [];
  S.layout.forEach((row, r) => row.forEach((ch, c) => { if (ch === "P") out.push([r, c]); }));
  return out;
}
function dropsOf() {
  const out = [];
  S.layout.forEach((row, r) => row.forEach((ch, c) => { if (ch === "D") out.push([r, c]); }));
  return out;
}
function reachable(a, b) {
  const seen = new Set([a.join()]), q = [a];
  while (q.length) {
    const [r, c] = q.shift();
    if (r === b[0] && c === b[1]) return true;
    for (const [dr, dc] of MOVES) {
      const nr = r + dr, nc = c + dc, k = nr + "," + nc;
      if (nr < 0 || nc < 0 || nr >= rows() || nc >= cols() || S.layout[nr][nc] === "#" || seen.has(k)) continue;
      seen.add(k); q.push([nr, nc]);
    }
  }
  return false;
}
function validateLayout() {
  const picks = picksOf(), drops = dropsOf(), items = [];
  items.push(drops.length === 1
    ? { ok: true, text: "One drop-off" }
    : { ok: false, text: drops.length ? `Only one drop-off allowed (found ${drops.length})` : "Place a drop-off" });
  items.push(picks.length >= 1 && picks.length <= MAX_PICKS
    ? { ok: true, text: `${picks.length} pick point${picks.length > 1 ? "s" : ""}` }
    : { ok: false, text: picks.length ? `Use at most ${MAX_PICKS} pick points` : "Place at least one pick point" });
  if (drops.length === 1 && picks.length) {
    const blocked = picks.map((p, i) => (reachable(p, drops[0]) ? null : `P${i + 1}`)).filter(Boolean);
    items.push(blocked.length
      ? { ok: false, text: `${blocked.join(", ")} cannot reach the drop-off` }
      : { ok: true, text: "Every pick point can reach the drop-off" });
  }
  return { ok: items.every((i) => i.ok), items };
}
const layoutDirty = () => !S.lab || layoutStrings().join("|") !== S.lab.grid.join("|");
const brainUsable = () => !!S.lab && !layoutDirty();

function setLayout(gridRows, presetName = null) {
  S.layout = gridRows.map((r) => r.split(""));
  S.preset = presetName;
  afterLayoutChange();
}
function afterLayoutChange() {
  $("#rowsOut").textContent = rows();
  $("#colsOut").textContent = cols();
  $$("#presetSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === S.preset)));
  const v = validateLayout();
  $("#layoutCheck").innerHTML = v.items.map((i) => `<li class="${i.ok ? "" : "bad"}">${i.text}</li>`).join("");
  $("#toTrain").disabled = !v.ok;
  if (layoutDirty()) { S.robot = null; S.trail = []; S.chosenStart = null; S.stepCell = null; }
  fillOrderSelects();
  refreshAll();
}
function fillOrderSelects() {
  const picks = picksOf();
  if (S.view.order >= picks.length) S.view.order = 0;
  const viewSel = $("#viewOrder");
  viewSel.innerHTML = picks.map((p, i) => `<option value="${i}">P${i + 1}</option>`).join("");
  viewSel.value = String(S.view.order);
  const orderSel = $("#orderSel"), prev = orderSel.value;
  orderSel.innerHTML = `<option value="">Random order</option>` +
    picks.map((p, i) => `<option value="${i}">P${i + 1} at ${cellCode(p[0], p[1])}</option>`).join("");
  if ([...orderSel.options].some((o) => o.value === prev)) orderSel.value = prev;
}

function paint(r, c) {
  const ch = S.layout[r][c];
  let next = ch;
  if (S.tool === "rack") next = "#";
  else if (S.tool === "floor") next = ".";
  else if (S.tool === "pick") {
    if (ch !== "P" && picksOf().length >= MAX_PICKS) { toast(`A floor can have at most ${MAX_PICKS} pick points.`, "bad"); return; }
    next = "P";
  } else if (S.tool === "drop") {
    dropsOf().forEach(([dr, dc]) => { S.layout[dr][dc] = "."; });
    next = "D";
  }
  if (next === ch && S.tool !== "drop") return;
  S.layout[r][c] = next;
  S.preset = null;
  afterLayoutChange();
}
function resize(dim, d) {
  if (S.training) return toast("Pause training before changing the floor.", "bad");
  if (dim === "rows") {
    const n = rows() + d;
    if (n < MIN_SIZE || n > MAX_SIZE) return;
    if (d > 0) S.layout.push(Array(cols()).fill(".")); else S.layout.pop();
  } else {
    const n = cols() + d;
    if (n < MIN_SIZE || n > MAX_SIZE) return;
    S.layout.forEach((row) => (d > 0 ? row.push(".") : row.pop()));
  }
  S.preset = null;
  afterLayoutChange();
}
function emptyFloor() {
  const R = rows(), Cc = cols();
  const g = Array.from({ length: R }, () => ".".repeat(Cc).split(""));
  g[0][0] = "P"; g[R - 1][Cc - 1] = "D";
  setLayout(g.map((r) => r.join("")), "Empty");
}

// ===================================================================== settings
const SETTING_IDS = ["alpha", "gamma", "epsStart", "epsEnd", "episodes", "rStep", "rBump", "rWrong", "rPick", "rDeliver"];
function readSettings() {
  const n = (id) => Number($("#" + id).value);
  return {
    grid: layoutStrings(), alpha: n("alpha"), gamma: n("gamma"),
    epsilon_start: n("epsStart"), epsilon_end: n("epsEnd"), episodes: n("episodes"),
    rewards: { step: n("rStep"), bump: n("rBump"), wrong: n("rWrong"), pick: n("rPick"), deliver: n("rDeliver") },
  };
}
function writeSettings(s) {
  $("#alpha").value = s.alpha; $("#gamma").value = s.gamma;
  $("#epsStart").value = s.epsilon_start; $("#epsEnd").value = s.epsilon_end;
  $("#episodes").value = s.episodes;
  $("#rStep").value = s.rewards.step; $("#rBump").value = s.rewards.bump; $("#rWrong").value = s.rewards.wrong;
  $("#rPick").value = s.rewards.pick; $("#rDeliver").value = s.rewards.deliver;
  updateSettingOutputs();
}
const settingsKey = (s) => JSON.stringify([s.grid, +s.alpha, +s.gamma, +s.epsilon_start, +s.epsilon_end,
  +s.episodes, ["step", "bump", "wrong", "pick", "deliver"].map((k) => +s.rewards[k])]);
const isFresh = () => !S.lab || settingsKey(readSettings()) !== settingsKey(S.lab.settings);

function updateSettingOutputs() {
  if (+$("#epsEnd").value > +$("#epsStart").value) $("#epsEnd").value = $("#epsStart").value;
  $("#alphaOut").textContent = (+$("#alpha").value).toFixed(2);
  $("#gammaOut").textContent = (+$("#gamma").value).toFixed(2);
  $("#epsOut").textContent = `${(+$("#epsStart").value).toFixed(2)} to ${(+$("#epsEnd").value).toFixed(2)}`;
  $("#episodesOut").textContent = fmtInt(+$("#episodes").value);
}

// ===================================================================== server calls
async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  };
  let res;
  try { res = await fetch(path, opts); } catch {
    throw new Error("Cannot reach the server. Is python app.py still running?");
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const d = data && data.detail;
    throw new Error(typeof d === "string" ? d : "Some settings are outside their allowed range.");
  }
  return data;
}

function applySnapshot(d) {
  S.lab = d;
  refreshAll();
}

function resetHistory() {
  S.hist = { xs: [], reward: [], avg: [], success: [], steps: [], okFlags: [], sumR: 0, sumS: 0 };
}
function addHistory(items) {
  const H = S.hist;
  for (const it of items) {
    H.xs.push(it.episode); H.reward.push(it.reward); H.okFlags.push(it.success ? 1 : 0); H.steps.push(it.steps);
    const n = H.reward.length;
    H.sumR += it.reward; H.sumS += it.success ? 1 : 0;
    if (n > WINDOW) { H.sumR -= H.reward[n - 1 - WINDOW]; H.sumS -= H.okFlags[n - 1 - WINDOW]; }
    const k = Math.min(n, WINDOW);
    H.avg.push(H.sumR / k); H.success.push((100 * H.sumS) / k);
  }
}

async function setupLab() {
  const d = await api("/api/setup", readSettings());
  resetHistory();
  S.targetEpisodes = d.planned;
  S.trail = []; S.robot = null; S.stepTrail = null; S.stepCell = null;
  applySnapshot(d);
  renderStepEmpty();
  return d;
}

// ===================================================================== floor drawing
const floor = $("#floor"), fx = floor.getContext("2d");
let G = { cell: 40, ox: 24, oy: 22, w: 0, h: 0 };
let needsDraw = true;
const requestDraw = () => { needsDraw = true; };

function measure() {
  const R = rows(), Cc = cols();
  const wrapW = $("#floorWrap").clientWidth;
  const ox = 24, oy = 22, pad = 4;
  const maxH = Math.max(300, window.innerHeight * 0.64);
  let cell = Math.floor(Math.min((wrapW - ox - pad) / Cc, (maxH - oy - pad) / R, 66));
  cell = Math.max(cell, 20);
  const w = ox + Cc * cell + pad, h = oy + R * cell + pad;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (floor.width !== Math.round(w * dpr) || floor.height !== Math.round(h * dpr)) {
    floor.width = Math.round(w * dpr); floor.height = Math.round(h * dpr);
    floor.style.width = w + "px"; floor.style.height = h + "px";
  }
  fx.setTransform(dpr, 0, 0, dpr, 0, 0);
  G = { cell, ox, oy, w, h };
}
const X = (c) => G.ox + c * G.cell;
const Y = (r) => G.oy + r * G.cell;

function stateId(r, c, order, carry) {
  return ((r * S.lab.cols + c) * S.lab.n_orders + order) * 2 + carry;
}
function qRow(r, c, order = S.view.order, carry = S.view.carrying) {
  return S.lab.q[stateId(r, c, order, carry)];
}
const visited = (row) => row.some((v) => v !== 0);
function argmax(row) {
  let b = 0;
  for (let i = 1; i < row.length; i++) if (row[i] > row[b]) b = i;
  return b;
}

function rr(x, y, w, h, rad) { fx.beginPath(); fx.roundRect(x, y, w, h, rad); }

function drawRack(x, y, s) {
  const i = Math.max(2, s * 0.08);
  rr(x + i, y + i, s - 2 * i, s - 2 * i, 3);
  fx.fillStyle = C.rack; fx.fill();
  fx.lineWidth = 1; fx.strokeStyle = C["rack-dark"]; fx.stroke();
  const bh = Math.max(2, s * 0.08);
  fx.fillStyle = C.beam;
  fx.fillRect(x + i, y + s * 0.32, s - 2 * i, bh);
  fx.fillRect(x + i, y + s * 0.6, s - 2 * i, bh);
}
function drawDrop(x, y, s) {
  const i = Math.max(1.5, s * 0.05);
  fx.save();
  rr(x + i, y + i, s - 2 * i, s - 2 * i, 4); fx.clip();
  fx.fillStyle = C.pad; fx.fillRect(x, y, s, s);
  fx.strokeStyle = C.robot; fx.lineWidth = s * 0.08;
  for (let k = -s; k < s * 2; k += s * 0.22) { fx.beginPath(); fx.moveTo(x + k, y); fx.lineTo(x + k - s, y + s); fx.stroke(); }
  const b = s * 0.17;
  fx.fillStyle = C.pad; fx.fillRect(x + b, y + b, s - 2 * b, s - 2 * b);
  fx.restore();
  // parcel icon
  const p = s * 0.18, cx = x + s / 2, cy = y + s / 2;
  fx.strokeStyle = "#fff"; fx.lineWidth = Math.max(1.4, s * 0.04);
  fx.strokeRect(cx - p, cy - p * 0.8, p * 2, p * 1.6);
  fx.beginPath(); fx.moveTo(cx - p, cy - p * 0.15); fx.lineTo(cx + p, cy - p * 0.15); fx.stroke();
}
function drawTag(x, y, s, label, active) {
  const w = s * 0.62, h = s * 0.4;
  rr(x + (s - w) / 2, y + (s - h) / 2, w, h, 4);
  fx.fillStyle = active ? C.beam : C.paper; fx.fill();
  fx.lineWidth = 1.5; fx.strokeStyle = active ? "#9d4a14" : C.ink; fx.stroke();
  fx.fillStyle = active ? "#fff" : C.ink;
  fx.font = `700 ${Math.round(s * 0.27)}px "Barlow Condensed", sans-serif`;
  fx.textAlign = "center"; fx.textBaseline = "middle";
  fx.fillText(label, x + s / 2, y + s / 2 + 1);
}
function drawArrow(x, y, s, a) {
  const [dr, dc] = MOVES[a], cx = x + s / 2, cy = y + s / 2, L = s * 0.27;
  const tx = cx + dc * L, ty = cy + dr * L, fxs = cx - dc * L * 0.7, fys = cy - dr * L * 0.7;
  fx.strokeStyle = "rgba(38,50,56,.78)"; fx.fillStyle = "rgba(38,50,56,.78)";
  fx.lineWidth = Math.max(1.5, s * 0.055); fx.lineCap = "round";
  fx.beginPath(); fx.moveTo(fxs, fys); fx.lineTo(tx - dc * s * 0.08, ty - dr * s * 0.08); fx.stroke();
  const hw = s * 0.11, hl = s * 0.15;
  fx.beginPath();
  fx.moveTo(tx, ty);
  fx.lineTo(tx - dc * hl - dr * hw, ty - dr * hl - dc * hw);
  fx.lineTo(tx - dc * hl + dr * hw, ty - dr * hl + dc * hw);
  fx.closePath(); fx.fill();
}
function drawRobot(px, py, s, carrying) {
  const cx = X(px) + s / 2, cy = Y(py) + s / 2, b = s * 0.66;
  fx.save();
  fx.shadowColor = "rgba(20,30,35,.28)"; fx.shadowBlur = s * 0.16; fx.shadowOffsetY = s * 0.05;
  rr(cx - b / 2, cy - b / 2, b, b, s * 0.15);
  fx.fillStyle = C.robot; fx.fill();
  fx.restore();
  rr(cx - b / 2, cy - b / 2, b, b, s * 0.15);
  fx.lineWidth = Math.max(1.5, s * 0.05); fx.strokeStyle = C.ink; fx.stroke();
  // front light shows which way it last moved
  const [hr, hc] = S.heading, fl = b * 0.42;
  fx.fillStyle = C.ink;
  if (hr) fx.fillRect(cx - fl / 2, cy + hr * (b / 2 - s * 0.1) - s * 0.035, fl, s * 0.07);
  else fx.fillRect(cx + hc * (b / 2 - s * 0.1) - s * 0.035, cy - fl / 2, s * 0.07, fl);
  if (carrying) {
    const p = s * 0.3;
    rr(cx - p / 2, cy - p / 2, p, p, 2);
    fx.fillStyle = "#c98a4b"; fx.fill(); fx.lineWidth = 1.5; fx.strokeStyle = "#5a3a1a"; fx.stroke();
    fx.beginPath(); fx.moveTo(cx - p / 2, cy); fx.lineTo(cx + p / 2, cy); fx.stroke();
  } else {
    rr(cx - b * 0.2, cy - b * 0.2, b * 0.4, b * 0.4, 3);
    fx.fillStyle = C.ink; fx.fill();
  }
}

function heatInfo() {
  // Max Q per floor cell for the chosen order and situation, plus the range.
  const out = new Map();
  let lo = Infinity, hi = -Infinity;
  for (let r = 0; r < rows(); r++) for (let c = 0; c < cols(); c++) {
    if (S.layout[r][c] === "#") continue;
    const row = qRow(r, c);
    if (!visited(row)) continue;
    const m = Math.max(...row);
    out.set(r * 100 + c, { max: m, best: argmax(row) });
    lo = Math.min(lo, m); hi = Math.max(hi, m);
  }
  return { cells: out, lo, hi };
}

function drawFloor() {
  measure();
  const s = G.cell, R = rows(), Cc = cols();
  fx.clearRect(0, 0, G.w, G.h);

  // coordinates, like bin locations on a real floor
  fx.fillStyle = C["ink-3"];
  fx.font = `600 ${Math.max(11, Math.min(14, s * 0.3))}px "Barlow Condensed", sans-serif`;
  fx.textAlign = "center"; fx.textBaseline = "middle";
  for (let c = 0; c < Cc; c++) fx.fillText(colName(c), X(c) + s / 2, G.oy / 2);
  for (let r = 0; r < R; r++) fx.fillText(String(r + 1), G.ox / 2 - 1, Y(r) + s / 2);

  rr(G.ox, G.oy, Cc * s, R * s, 5);
  fx.fillStyle = C.slab; fx.fill();

  const usable = brainUsable();
  const heat = usable && (S.layers.heat || S.layers.arrows) ? heatInfo() : null;

  if (heat && S.layers.heat && heat.cells.size) {
    const span = heat.hi - heat.lo || 1;
    for (const [k, v] of heat.cells) {
      const r = Math.floor(k / 100), c = k % 100;
      const t = (v.max - heat.lo) / span;
      fx.fillStyle = `rgba(15,155,132,${(0.06 + 0.74 * t * t).toFixed(3)})`;
      fx.fillRect(X(c), Y(r), s, s);
    }
  }

  // expansion joints between floor slabs
  fx.strokeStyle = "rgba(38,50,56,.09)"; fx.lineWidth = 1;
  fx.beginPath();
  for (let c = 1; c < Cc; c++) { fx.moveTo(X(c) + 0.5, G.oy); fx.lineTo(X(c) + 0.5, G.oy + R * s); }
  for (let r = 1; r < R; r++) { fx.moveTo(G.ox, Y(r) + 0.5); fx.lineTo(G.ox + Cc * s, Y(r) + 0.5); }
  fx.stroke();

  let pickNo = 0;
  for (let r = 0; r < R; r++) for (let c = 0; c < Cc; c++) {
    const ch = S.layout[r][c];
    if (ch === "#") drawRack(X(c), Y(r), s);
    else if (ch === "D") drawDrop(X(c), Y(r), s);
    else if (ch === "P") {
      const active = pickNo === S.view.order && S.view.carrying === 0;
      drawTag(X(c), Y(r), s, "P" + (pickNo + 1), active);
      pickNo++;
    }
  }

  if (heat && S.layers.arrows) {
    for (const [k, v] of heat.cells) {
      const r = Math.floor(k / 100), c = k % 100, ch = S.layout[r][c];
      if (v.best < 4 && ch === ".") drawArrow(X(c), Y(r), s, v.best);
      else if (v.best >= 4 && ch !== "." && s >= 30) {
        fx.fillStyle = ch === "D" ? "#fff" : C.ink;
        fx.font = `600 ${Math.round(s * 0.2)}px "Barlow Condensed", sans-serif`;
        fx.fillText(ACTIONS[v.best].toLowerCase(), X(c) + s / 2, Y(r) + s * 0.86);
      }
    }
  }

  if (S.layers.trail && S.trail.length > 1 && !layoutDirty()) {
    fx.strokeStyle = "rgba(201,149,0,.6)"; fx.lineWidth = Math.max(3, s * 0.1);
    fx.lineJoin = "round"; fx.lineCap = "round";
    fx.beginPath();
    S.trail.forEach(([r, c], i) => (i ? fx.lineTo : fx.moveTo).call(fx, X(c) + s / 2, Y(r) + s / 2));
    fx.stroke();
  }

  if (S.stepCell && S.tab === "inside" && !layoutDirty()) {
    const [r, c] = S.stepCell;
    rr(X(c) + 1.5, Y(r) + 1.5, s - 3, s - 3, 5);
    fx.setLineDash([5, 4]); fx.lineWidth = 2; fx.strokeStyle = C.ink; fx.stroke(); fx.setLineDash([]);
  }

  if (S.tab === "deliver" && S.startMode === "pick" && S.chosenStart && !S.playing) {
    const [r, c] = S.chosenStart;
    fx.beginPath(); fx.arc(X(c) + s / 2, Y(r) + s / 2, s * 0.36, 0, Math.PI * 2);
    fx.setLineDash([4, 4]); fx.lineWidth = 2; fx.strokeStyle = C.ink; fx.stroke(); fx.setLineDash([]);
    fx.fillStyle = C.ink; fx.font = `600 ${Math.round(s * 0.22)}px "Barlow Condensed", sans-serif`;
    fx.fillText("start", X(c) + s / 2, Y(r) + s / 2);
  }

  if (S.robot && S.robotDraw && !layoutDirty()) drawRobot(S.robotDraw.x, S.robotDraw.y, s, S.robot.carrying);
}

function placeRobot(r, c, carrying, instant = false) {
  const prev = S.robot;
  if (prev && (prev.r !== r || prev.c !== c)) S.heading = [Math.sign(r - prev.r), Math.sign(c - prev.c)];
  S.robot = { r, c, carrying: !!carrying };
  if (!S.robotDraw || instant || reduceMotion) S.robotDraw = { x: c, y: r };
  requestDraw();
}

function frame() {
  if (S.robot && S.robotDraw) {
    const dx = S.robot.c - S.robotDraw.x, dy = S.robot.r - S.robotDraw.y;
    if (Math.abs(dx) + Math.abs(dy) > 0.002) {
      S.robotDraw.x += dx * 0.32; S.robotDraw.y += dy * 0.32;
      if (Math.abs(dx) + Math.abs(dy) < 0.02) S.robotDraw = { x: S.robot.c, y: S.robot.r };
      needsDraw = true;
    }
  }
  if (needsDraw) { needsDraw = false; drawFloor(); }
  requestAnimationFrame(frame);
}

// ----- pointer: paint, choose a start, hover tooltip
function hitCell(e) {
  const rect = floor.getBoundingClientRect();
  const x = e.clientX - rect.left - G.ox, y = e.clientY - rect.top - G.oy;
  const c = Math.floor(x / G.cell), r = Math.floor(y / G.cell);
  return r >= 0 && c >= 0 && r < rows() && c < cols() ? { r, c } : null;
}
floor.addEventListener("pointerdown", (e) => {
  const cell = hitCell(e);
  if (!cell) return;
  if (S.tab === "build") {
    if (S.training) return toast("Pause training before editing the floor.", "bad");
    S.painting = true; S.lastPaint = cell.r + "," + cell.c;
    floor.setPointerCapture(e.pointerId);
    paint(cell.r, cell.c);
  } else if (S.tab === "deliver" && S.startMode === "pick" && !S.playing) {
    if (S.layout[cell.r][cell.c] === "#") return toast("The robot has to start on the floor, not on a rack.", "bad");
    S.chosenStart = [cell.r, cell.c];
    $("#startHelp").textContent = `The robot will start at ${cellCode(cell.r, cell.c)}.`;
    requestDraw();
  }
});
floor.addEventListener("pointermove", (e) => {
  const cell = hitCell(e);
  if (S.painting && cell) {
    const k = cell.r + "," + cell.c;
    if (k !== S.lastPaint) { S.lastPaint = k; paint(cell.r, cell.c); }
  }
  showTip(e, cell);
});
const endPaint = () => { S.painting = false; };
floor.addEventListener("pointerup", endPaint);
floor.addEventListener("pointercancel", endPaint);
floor.addEventListener("pointerleave", () => { $("#tip").hidden = true; });

function showTip(e, cell) {
  const tip = $("#tip");
  if (!cell || S.painting) { tip.hidden = true; return; }
  const { r, c } = cell, ch = S.layout[r][c];
  const pickIdx = picksOf().findIndex(([pr, pc]) => pr === r && pc === c);
  const kind = ch === "#" ? "Rack" : ch === "P" ? `Pick point P${pickIdx + 1}` : ch === "D" ? "Drop-off" : "Floor";
  let html = `<h4>${cellCode(r, c)}</h4><p class="sub">${kind}</p>`;
  if (ch === "#") html += `<p class="sub">The robot cannot drive here.</p>`;
  else if (!brainUsable()) html += `<p class="sub">Train the robot to see what it expects from this spot.</p>`;
  else {
    const row = qRow(r, c), o = S.view.order;
    const situation = S.view.carrying ? "carrying the item" : `heading to P${o + 1}`;
    if (!visited(row)) html += `<p class="sub">Not explored yet while ${situation}.</p>`;
    else {
      const best = argmax(row), scale = Math.max(...row.map(Math.abs), 1);
      html += `<p class="sub">Points it expects here while ${situation}:</p>`;
      html += row.map((v, a) => {
        const w = (Math.abs(v) / scale) * 50, left = v >= 0 ? 50 : 50 - w;
        return `<div class="qrow ${a === best ? "best" : ""}"><span>${ACTIONS[a]}</span>` +
          `<span class="qtrack"><span class="${v < 0 ? "neg" : ""}" style="left:${left}%;width:${w}%"></span></span>` +
          `<span class="num">${fmt(v, 1)}</span></div>`;
      }).join("");
    }
  }
  tip.innerHTML = html;
  tip.hidden = false;
  const wrap = $("#floorWrap").getBoundingClientRect();
  let x = e.clientX - wrap.left + 18, y = e.clientY - wrap.top + 16;
  if (x + 240 > wrap.width) x = e.clientX - wrap.left - 254;
  if (y + tip.offsetHeight > wrap.height + 40) y = Math.max(0, e.clientY - wrap.top - tip.offsetHeight - 12);
  tip.style.left = Math.max(0, x) + "px"; tip.style.top = y + "px";
}

// ===================================================================== charts
function niceTicks(lo, hi, count = 4) {
  const span = hi - lo || 1, raw = span / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const start = Math.floor(lo / step) * step, out = [];
  for (let v = start; v <= hi + step * 0.5; v += step) out.push(+v.toFixed(10));
  if (out[out.length - 1] < hi) out.push(out[out.length - 1] + step);
  return out;
}

class LineChart {
  constructor(canvas, opts) {
    this.cv = canvas; this.x = canvas.getContext("2d"); this.opts = opts;
    this.tip = canvas.parentElement.querySelector(".ctip");
    this.series = []; this.xs = []; this.hover = null;
    canvas.addEventListener("pointermove", (e) => { this.hover = e.offsetX; this.draw(); });
    canvas.addEventListener("pointerleave", () => { this.hover = null; this.draw(); });
  }
  set(series, xs) { this.series = series; this.xs = xs; this.draw(); }
  draw() {
    const cv = this.cv, ctx = this.x, W = cv.clientWidth, H = cv.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const n = this.xs.length, m = { l: 46, r: 10, t: 10, b: 24 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
    ctx.font = `500 12px Barlow, sans-serif`;
    if (!n) {
      ctx.fillStyle = C["ink-3"]; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("Fills in as the robot practises", W / 2, H / 2);
      this.tip.hidden = true; return;
    }
    let lo = this.opts.yMin, hi = this.opts.yMax;
    if (lo === undefined || hi === undefined) {
      let a = Infinity, b = -Infinity;
      for (const s of this.series) for (const v of s.values) { if (v < a) a = v; if (v > b) b = v; }
      if (lo === undefined) lo = a;
      if (hi === undefined) hi = b;
    }
    const ticks = niceTicks(lo, hi);
    lo = ticks[0]; hi = ticks[ticks.length - 1];
    const yOf = (v) => m.t + ph - ((v - lo) / (hi - lo || 1)) * ph;
    const xOf = (i) => m.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);

    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (const t of ticks) {
      const y = Math.round(yOf(t)) + 0.5;
      ctx.strokeStyle = t === 0 ? C.line : C["line-soft"]; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(W - m.r, y); ctx.stroke();
      ctx.fillStyle = C["ink-3"]; ctx.fillText(this.opts.yFmt(t), m.l - 6, y);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const xt = Math.min(4, n);
    for (let k = 0; k < xt; k++) {
      const i = xt === 1 ? 0 : Math.round((k / (xt - 1)) * (n - 1));
      ctx.fillText(fmtInt(this.xs[i]), Math.min(Math.max(xOf(i), m.l + 12), W - m.r - 14), H - m.b + 6);
    }

    // downsample to at most one bucket per pixel
    const B = Math.max(1, Math.min(n, Math.floor(pw)));
    for (const s of this.series) {
      const v = s.values;
      if (s.kind === "band") {
        ctx.fillStyle = s.color;
        for (let b = 0; b < B; b++) {
          const i0 = Math.floor((b * n) / B), i1 = Math.max(i0 + 1, Math.floor(((b + 1) * n) / B));
          let a = Infinity, z = -Infinity;
          for (let i = i0; i < i1; i++) { if (v[i] < a) a = v[i]; if (v[i] > z) z = v[i]; }
          const x0 = xOf(i0), y0 = yOf(z), y1 = yOf(a);
          ctx.fillRect(x0 - 0.5, y0, Math.max(1, pw / B), Math.max(1, y1 - y0));
        }
      } else {
        ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = "round";
        ctx.beginPath();
        for (let b = 0; b < B; b++) {
          const i0 = Math.floor((b * n) / B), i1 = Math.max(i0 + 1, Math.floor(((b + 1) * n) / B));
          let sum = 0; for (let i = i0; i < i1; i++) sum += v[i];
          const x = xOf(Math.round((i0 + i1 - 1) / 2)), y = yOf(sum / (i1 - i0));
          b ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
    }

    if (this.hover !== null && this.hover >= m.l - 4) {
      const i = Math.min(n - 1, Math.max(0, Math.round(((this.hover - m.l) / pw) * (n - 1))));
      const x = Math.round(xOf(i)) + 0.5;
      ctx.strokeStyle = C["ink-3"]; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, m.t + ph); ctx.stroke();
      for (const s of this.series) {
        ctx.beginPath(); ctx.arc(x, yOf(s.values[i]), 4, 0, Math.PI * 2);
        ctx.fillStyle = s.dot || s.color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = C.paper; ctx.stroke();
      }
      this.tip.innerHTML = `Order ${fmtInt(this.xs[i])}<br>` +
        this.series.map((s) => `${s.name}: <b>${this.opts.yFmt(s.values[i], true)}</b>`).join("<br>");
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = (x + 12 + tw > W ? x - tw - 12 : x + 12) + "px";
    } else this.tip.hidden = true;
  }
}

const rewardChart = new LineChart($("#rewardChart"), {
  yFmt: (v, precise) => (precise ? fmt(v, 1) : (v < 0 ? MINUS : "") + fmtInt(Math.abs(v))),
});
const successChart = new LineChart($("#successChart"), {
  yMin: 0, yMax: 100, yFmt: (v, precise) => (precise ? v.toFixed(0) : v) + "%",
});
function updateCharts() {
  const H = S.hist;
  rewardChart.set([
    { name: "This order", kind: "band", color: "rgba(134,147,154,.45)", dot: C["ink-3"], values: H.reward },
    { name: "Average of last 50", kind: "line", color: C.rack, values: H.avg },
  ], H.xs);
  successChart.set([{ name: "Delivered", kind: "line", color: C.value, values: H.success }], H.xs);
}

// ===================================================================== status, stats, captions
function updateStatus() {
  const el = $("#status");
  let state = "idle", text = "Not trained yet";
  const ep = S.lab ? S.lab.episode : 0;
  if (S.training) { state = "training"; text = `Training: ${fmtInt(ep)} orders`; }
  else if (S.playing) { state = "delivering"; text = "Delivering an order"; }
  else if (S.auto) { state = "stepping"; text = "Stepping"; }
  else if (S.lab && layoutDirty()) { state = "idle"; text = "Floor changed: train again"; }
  else if (ep > 0 && ep >= S.targetEpisodes) { state = "trained"; text = `Trained on ${fmtInt(ep)} orders`; }
  else if (ep > 0) { state = "paused"; text = `Paused at ${fmtInt(ep)} orders`; }
  el.dataset.state = state;
  el.querySelector("span").textContent = text;
}
function updateStats() {
  const H = S.hist, n = H.reward.length;
  $("#stEpisodes").textContent = fmtInt(S.lab ? S.lab.episode : 0);
  $("#stEps").textContent = Math.round(100 * (S.lab ? S.lab.epsilon : +$("#epsStart").value)) + "%";
  if (!n) { $("#stSuccess").textContent = "–"; $("#stSteps").textContent = "–"; return; }
  $("#stSuccess").textContent = Math.round(H.success[n - 1]) + "%";
  let sum = 0, k = 0;
  for (let i = Math.max(0, n - WINDOW); i < n; i++) if (H.okFlags[i]) { sum += H.steps[i]; k++; }
  $("#stSteps").textContent = k ? (sum / k).toFixed(1) : "–";
}
function updateProgress() {
  const ep = S.lab ? S.lab.episode : 0;
  const target = S.lab && !isFresh() ? S.targetEpisodes : +$("#episodes").value;
  $("#progFill").style.width = Math.min(100, (100 * ep) / (target || 1)) + "%";
  $("#progText").textContent = `${fmtInt(S.lab && !isFresh() ? ep : 0)} of ${fmtInt(target)} practice orders`;
  const btn = $("#trainBtn");
  if (S.training) btn.textContent = "Pause";
  else if (!S.lab || isFresh() || ep === 0) btn.textContent = "Start training";
  else if (ep >= S.targetEpisodes) btn.textContent = "Keep training";
  else btn.textContent = "Resume training";
}
function updateCaption() {
  let t;
  if (S.tab === "build" && !S.lab) t = "Paint racks, pick points and a drop-off. Hover any cell to see its location.";
  else if (S.lab && layoutDirty()) t = "The floor changed. Train again to see what the robot learns about it.";
  else if (S.tab === "deliver" && S.startMode === "pick" && !S.playing) t = "Click a floor cell to choose where the robot starts.";
  else if (!brainUsable() || S.lab.episode === 0 && !S.stepCell) t = "Train the robot and this floor fills with what it has learned.";
  else {
    const where = S.view.carrying ? "carrying the item to the drop-off" : `heading to pick-up P${S.view.order + 1}`;
    t = `Brighter floor means more points expected from that spot when ${where}. Hover a cell for the details.`;
  }
  $("#floorCaption").textContent = t;
}
function updateFreshNotes() {
  $("#trainFresh").hidden = !(S.lab && S.lab.episode > 0 && isFresh() && !S.training);
  $("#buildFresh").hidden = !(S.lab && layoutDirty());
}
function syncViewControls() {
  $("#viewOrder").value = String(S.view.order);
  $$(".viewpick .seg button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.carry === S.view.carrying)));
}
function refreshAll() {
  updateStatus(); updateStats(); updateProgress(); updateCaption(); updateFreshNotes(); syncViewControls();
  requestDraw();
}

// ===================================================================== training
async function toggleTraining() {
  if (S.training) { S.training = false; refreshAll(); return; }
  if (S.playing || S.auto) return toast("Wait for the robot to finish first.", "bad");
  if (!validateLayout().ok) { switchTab("build"); return toast("Fix the floor first: see the checklist in Build.", "bad"); }
  try {
    if (isFresh()) await setupLab();
    if (S.lab.episode >= S.targetEpisodes) S.targetEpisodes = S.lab.episode + Math.max(500, Math.round(S.lab.planned / 3));
    S.training = true; refreshAll();
    while (S.training && S.lab.episode < S.targetEpisodes) {
      const sp = SPEEDS[S.speed];
      const d = await api("/api/train", { episodes: Math.min(sp.chunk, S.targetEpisodes - S.lab.episode) });
      addHistory(d.history);
      S.lab = d;
      if (S.speed === "watch") await animateRoute(d.last_path);
      else {
        S.trail = d.last_path.map(([r, c]) => [r, c]);
        const [r, c, k] = d.last_path[d.last_path.length - 1];
        placeRobot(r, c, k, true);
        await sleep(sp.delay);
      }
      updateCharts(); refreshAll();
    }
    if (S.lab.episode >= S.targetEpisodes) {
      toast(`Training done: ${fmtInt(S.lab.episode)} practice orders. Open Deliver to give it a real order.`, "good");
    }
  } catch (err) { toast(err.message, "bad"); }
  S.training = false;
  refreshAll();
}
async function animateRoute(path) {
  S.trail = [];
  const steps = path.slice(0, 160);
  for (const [r, c, k] of steps) {
    if (!S.training) break;
    S.trail.push([r, c]);
    placeRobot(r, c, k, true);
    await sleep(14);
  }
  updateStats();
}
async function resetBrain() {
  S.training = false; S.auto = false; $("#autoBtn").setAttribute("aria-pressed", "false");
  if (!validateLayout().ok) return toast("Fix the floor first: see the checklist in Build.", "bad");
  try {
    await setupLab();
    updateCharts();
    toast("Brain reset. Every Q-value is back to 0.");
  } catch (err) { toast(err.message, "bad"); }
}

// ===================================================================== deliver & test
const playDelay = () => 560 - 50 * +$("#playSpeed").value;
async function deliverOrder() {
  if (!brainUsable() || S.lab.episode === 0) return toast("Train the robot on this floor first (step 2).", "bad");
  if (S.training) return toast("Pause training first.", "bad");
  const orderVal = $("#orderSel").value;
  const body = { order: orderVal === "" ? null : +orderVal };
  if (S.startMode === "pick") {
    if (!S.chosenStart) return toast("Click a floor cell to choose the start, or switch to a random spot.", "bad");
    body.start = S.chosenStart;
  }
  try {
    S.delivery = await api("/api/deliver", body);
    await playDelivery(S.delivery);
  } catch (err) { toast(err.message, "bad"); }
}
async function playDelivery(d) {
  S.playing = true;
  ["#deliverBtn", "#replayBtn", "#testBtn"].forEach((s) => ($(s).disabled = true));
  S.view.order = d.order; S.view.carrying = 0;
  $("#deliverResult").hidden = true;
  const log = $("#deliverLog");
  const eventText = { start: "start", move: "", bump: "hit a rack", wrong: "wrong place", pick: "picked up", deliver: "delivered" };
  log.innerHTML = d.frames.slice(1).map((f, i) =>
    `<li class="${f.event}" data-i="${i + 1}"><span class="n">${i + 1}</span><span>${f.action} <span class="ev">${eventText[f.event]}</span></span><span>${fmtSigned(f.reward)}</span></li>`).join("");
  S.trail = [];
  refreshAll();
  for (let i = 0; i < d.frames.length && S.playing; i++) {
    const f = d.frames[i];
    S.trail.push(f.pos);
    placeRobot(f.pos[0], f.pos[1], f.carrying, i === 0);
    if (f.carrying && !S.view.carrying) { S.view.carrying = 1; refreshAll(); }
    $$("#deliverLog li").forEach((li) => li.classList.toggle("now", +li.dataset.i === i));
    const cur = $(`#deliverLog li[data-i="${i}"]`);
    if (cur) log.scrollTop = cur.offsetTop - log.offsetTop - log.clientHeight / 2;
    await sleep(i === 0 ? 350 : playDelay());
  }
  S.playing = false;
  const res = $("#deliverResult");
  const eff = d.success ? d.best_possible / d.steps : 0;
  res.className = "result " + (d.success ? "good" : "bad");
  res.innerHTML = d.success
    ? `<strong>Delivered P${d.order + 1} in ${d.steps} moves</strong>${eff >= 0.999 ? "A perfect route: nothing shorter exists." : "A working route, but not the shortest one. More training usually fixes this."}
       <div class="meter"><div><b>${d.steps}</b>moves used</div><div><b>${d.best_possible}</b>shortest possible</div><div><b>${Math.round(eff * 100)}%</b>route efficiency</div></div>`
    : `<strong>Not delivered</strong>The robot ran out of time after ${d.steps} moves. It has not learned this situation yet: train for longer and try again.`;
  res.hidden = false;
  ["#deliverBtn", "#replayBtn", "#testBtn"].forEach((s) => ($(s).disabled = false));
  refreshAll();
}
async function testRobot() {
  if (!brainUsable() || S.lab.episode === 0) return toast("Train the robot on this floor first (step 2).", "bad");
  const btn = $("#testBtn");
  btn.disabled = true; btn.textContent = "Testing…";
  try {
    const t = await api("/api/test", {});
    const res = $("#testResult");
    const ok = Math.round(t.success_rate * 100);
    res.className = "result " + (ok >= 95 ? "good" : "bad");
    const verdict = ok === 100 && t.efficiency > 0.99 ? "Every order delivered, by the shortest route."
      : ok >= 95 ? "Nearly there. A few more practice orders should close the gap."
        : "The robot still gets lost. Train for longer or raise the number of practice orders.";
    res.innerHTML = `<strong>Delivered ${ok} of 100 orders</strong>${verdict}
      <div class="meter"><div><b>${t.avg_steps ? t.avg_steps.toFixed(1) : "–"}</b>average moves</div>
      <div><b>${t.avg_best ? t.avg_best.toFixed(1) : "–"}</b>shortest possible</div>
      <div><b>${Math.round(t.efficiency * 100)}%</b>route efficiency</div></div>`;
    res.hidden = false;
  } catch (err) { toast(err.message, "bad"); }
  btn.disabled = false; btn.textContent = "Test 100 orders";
}
async function saveBrain() {
  if (!S.lab) return toast("There is no brain to save yet. Train first.", "bad");
  try {
    const data = await api("/api/brain");
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "warehouse-brain.json" });
    a.click(); URL.revokeObjectURL(a.href);
    toast("Saved warehouse-brain.json", "good");
  } catch (err) { toast(err.message, "bad"); }
}
async function loadBrain(file) {
  if (S.training) return toast("Pause training first.", "bad");
  try {
    const json = JSON.parse(await file.text());
    const d = await api("/api/brain", json);
    S.layout = d.grid.map((r) => r.split("")); S.preset = null;
    writeSettings(d.settings);
    resetHistory(); updateCharts();
    S.targetEpisodes = Math.max(d.planned, d.episode);
    S.robot = null; S.trail = [];
    applySnapshot(d);
    afterLayoutChange();
    toast(`Loaded a brain trained on ${fmtInt(d.episode)} orders.`, "good");
  } catch (err) { toast(err instanceof SyntaxError ? "That file is not a brain file (invalid JSON)." : err.message, "bad"); }
}

// ===================================================================== look inside
function renderStepEmpty(text) {
  $("#stepCard").innerHTML = `<p class="empty">${text || "Press <b>Take one step</b>. If the robot is untrained, every number starts at 0 and you can watch the very first things it learns."}</p>`;
}
async function takeStep() {
  if (S.training || S.playing) return toast("Pause training first.", "bad");
  if (!validateLayout().ok) { switchTab("build"); return toast("Fix the floor first: see the checklist in Build.", "bad"); }
  if (isFresh()) { await setupLab(); updateCharts(); toast("Started a fresh brain: every Q-value is 0."); }
  const d = await api("/api/step", {});
  S.lab.q[d.state] = d.q_after.map((v) => Math.round(v * 100) / 100);
  S.view.order = d.order; S.view.carrying = d.before.carrying ? 1 : 0;
  if (!S.stepTrail) { S.stepTrail = [d.before.pos]; placeRobot(d.before.pos[0], d.before.pos[1], d.before.carrying, true); }
  S.stepTrail.push(d.after.pos);
  S.trail = S.stepTrail;
  S.stepCell = d.before.pos;
  placeRobot(d.after.pos[0], d.after.pos[1], d.after.carrying);
  renderStep(d);
  if (d.finished) S.stepTrail = null;
  refreshAll();
}
function renderStep(d) {
  const [br, bc] = d.before.pos, [ar, ac] = d.after.pos;
  const situation = d.before.carrying ? "carrying the item to the drop-off" : `heading to pick-up <b>P${d.order + 1}</b>`;
  const decision = d.how === "explore"
    ? `<span class="pill explore">Explored</span> a random action. Right now ${Math.round(d.epsilon * 100)}% of moves are random.`
    : `<span class="pill exploit">Used its brain</span> the action with the highest Q-value.`;
  const result = {
    move: `moved to ${cellCode(ar, ac)}`, bump: "hit a rack or wall and stayed put",
    wrong: d.action === "Pick" ? "there is nothing to pick up here" : "it cannot drop the item here",
    pick: "picked up the item", deliver: "delivered the order",
  }[d.event];
  const reason = {
    move: "each move costs time", bump: "move cost plus the bump penalty", wrong: "move cost plus the wrong-place penalty",
    pick: "move cost plus the pick-up reward", deliver: "move cost plus the delivery reward",
  }[d.event];
  const a = d.alpha, g = d.gamma;
  const scale = Math.max(1, ...d.q_before.map(Math.abs), ...d.q_after.map(Math.abs));
  const bar = (v) => { const w = (Math.abs(v) / scale) * 50; return { left: v >= 0 ? 50 : 50 - w, w }; };
  const bars = d.q_after.map((v, i) => {
    const changed = i === d.action_index, nb = bar(v), ob = bar(d.q_before[i]);
    return `<div class="row ${changed ? "changed" : ""}"><span>${ACTIONS[i]}</span>
      <span class="track"><span class="zero"></span>
        ${changed && Math.abs(v - d.q_before[i]) > scale * 0.04 ? `<span class="ghost" style="left:${ob.left}%;width:${Math.max(ob.w, 0.5)}%"></span>` : ""}
        <span class="b ${v < 0 ? "neg" : ""}" style="left:${nb.left}%;width:${nb.w}%"></span></span>
      <span class="num">${changed ? `${fmt(d.q_before[i])} to <b>${fmt(v)}</b>` : fmt(v)}</span></div>`;
  }).join("");
  const nextText = d.done
    ? "The order is complete, so there is no next value: best next Q counts as 0."
    : `Best next Q (${fmt(d.best_next)}) is the most the robot currently expects from ${cellCode(ar, ac)}.`;
  $("#stepCard").innerHTML = `
    <div class="sc-rows">
      <span class="k">Situation</span><span>At <b>${cellCode(br, bc)}</b>, ${situation}</span>
      <span class="k">Decision</span><span>${decision}</span>
      <span class="k">Action</span><span><b>${d.action}</b>: ${result}</span>
      <span class="k">Reward</span><span><b>${fmtSigned(d.reward)}</b> points (${reason})</span>
    </div>
    <p class="formula">new Q = old Q + α × (reward + γ × best next Q − old Q)</p>
    <p class="formula"><span class="t-new">${fmt(d.q_new)}</span> = <span class="t-o">${fmt(d.q_old)}</span> + ${a} × (<span class="t-r">${fmtSigned(d.reward)}</span> + ${g} × <span class="t-n">${fmt(d.best_next)}</span> − <span class="t-o">${fmt(d.q_old)}</span>)</p>
    <p class="why">${nextText} The target is ${fmt(d.target)}, which is ${fmt(Math.abs(d.td_error))} ${d.td_error >= 0 ? "more" : "less"} than the old Q, so the robot moves its estimate ${d.td_error >= 0 ? "up" : "down"} by α × ${fmt(d.td_error)} = ${fmt(a * d.td_error)}.</p>
    <p class="qtitle">Its brain at ${cellCode(br, bc)} for this situation</p>
    <div class="qbars">${bars}</div>
    ${d.finished ? `<p class="note" style="margin:12px 0 0">${d.done ? "Order delivered" : "Out of time"} after ${d.steps} moves. The next step starts a new order.</p>` : ""}`;
}
async function toggleAuto() {
  if (S.auto) { S.auto = false; $("#autoBtn").setAttribute("aria-pressed", "false"); refreshAll(); return; }
  if (S.training || S.playing) return toast("Pause training first.", "bad");
  S.auto = true; $("#autoBtn").setAttribute("aria-pressed", "true"); refreshAll();
  try {
    while (S.auto && S.tab === "inside") { await takeStep(); await sleep(reduceMotion ? 900 : 520); }
  } catch (err) { toast(err.message, "bad"); }
  S.auto = false; $("#autoBtn").setAttribute("aria-pressed", "false"); refreshAll();
}
async function newStepOrder() {
  if (!S.lab) return renderStepEmpty();
  await api("/api/step/reset", {});
  S.stepTrail = null; S.trail = []; S.robot = null; S.stepCell = null;
  renderStepEmpty("New order ready. Press <b>Take one step</b>.");
  refreshAll();
}

// ===================================================================== tabs, toasts, wiring
function switchTab(name) {
  S.tab = name;
  $$(".tabs [role=tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  $$(".tab-body").forEach((p) => (p.hidden = p.id !== "tab-" + name));
  floor.classList.toggle("painting", name === "build");
  floor.classList.toggle("choosing", name === "deliver" && S.startMode === "pick");
  if (name !== "inside" && S.auto) { S.auto = false; $("#autoBtn").setAttribute("aria-pressed", "false"); }
  refreshAll();
}
function toast(msg, kind = "") {
  const el = Object.assign(document.createElement("div"), { className: "toast " + kind, textContent: msg });
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function wire() {
  $$(".tabs [role=tab]").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  $$(".tool").forEach((b) => b.addEventListener("click", () => {
    S.tool = b.dataset.tool;
    $$(".tool").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
  }));
  $$("[data-size]").forEach((b) => b.addEventListener("click", () => resize(b.dataset.size, +b.dataset.d)));
  $("#toTrain").addEventListener("click", () => switchTab("train"));

  $$(".chip").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.layer; S.layers[k] = !S.layers[k];
    b.setAttribute("aria-pressed", String(S.layers[k])); requestDraw();
  }));
  $("#viewOrder").addEventListener("change", (e) => { S.view.order = +e.target.value; refreshAll(); });
  $$(".viewpick .seg button").forEach((b) => b.addEventListener("click", () => { S.view.carrying = +b.dataset.carry; refreshAll(); }));

  SETTING_IDS.forEach((id) => $("#" + id).addEventListener("input", () => { updateSettingOutputs(); refreshAll(); }));
  $$("#speedSeg button").forEach((b) => b.addEventListener("click", () => {
    S.speed = b.dataset.speed;
    $$("#speedSeg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
  $("#trainBtn").addEventListener("click", toggleTraining);
  $("#resetBtn").addEventListener("click", resetBrain);

  $$("#startSeg button").forEach((b) => b.addEventListener("click", () => {
    S.startMode = b.dataset.start;
    $$("#startSeg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    $("#startHelp").hidden = S.startMode !== "pick";
    floor.classList.toggle("choosing", S.startMode === "pick");
    refreshAll();
  }));
  $("#deliverBtn").addEventListener("click", deliverOrder);
  $("#replayBtn").addEventListener("click", () => S.delivery && playDelivery(S.delivery));
  $("#testBtn").addEventListener("click", testRobot);
  $("#saveBtn").addEventListener("click", saveBrain);
  $("#loadInput").addEventListener("change", (e) => { if (e.target.files[0]) loadBrain(e.target.files[0]); e.target.value = ""; });

  $("#stepBtn").addEventListener("click", () => takeStep().catch((err) => toast(err.message, "bad")));
  $("#autoBtn").addEventListener("click", toggleAuto);
  $("#newOrderBtn").addEventListener("click", () => newStepOrder().catch((err) => toast(err.message, "bad")));

  $("#helpBtn").addEventListener("click", () => $("#help").showModal());
  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName);
    if (e.code === "Space" && !typing && S.tab === "train" && !$("#help").open) { e.preventDefault(); toggleTraining(); }
  });
  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { requestDraw(); updateCharts(); }, 80); });
}

async function init() {
  readColors();
  wire();
  updateSettingOutputs();
  try {
    const p = await api("/api/presets");
    S.presets = p.presets;
    const sizes = Object.fromEntries(Object.entries(p.presets).map(([k, g]) => [k, `${g.length}×${g[0].length}`]));
    $("#presetSeg").innerHTML = Object.keys(p.presets).map((k) =>
      `<button data-preset="${k}" aria-pressed="false">${k} <span style="opacity:.6">${sizes[k]}</span></button>`).join("") +
      `<button data-preset="Empty" aria-pressed="false">Empty floor</button>`;
    $$("#presetSeg button").forEach((b) => b.addEventListener("click", () => {
      if (S.training) return toast("Pause training before changing the floor.", "bad");
      b.dataset.preset === "Empty" ? emptyFloor() : setLayout(S.presets[b.dataset.preset], b.dataset.preset);
    }));
    const st = await api("/api/state");
    if (st.ready) {
      S.layout = st.grid.map((r) => r.split(""));
      writeSettings(st.settings);
      S.targetEpisodes = Math.max(st.planned, st.episode);
      resetHistory(); addHistory(st.history || []);
      applySnapshot(st);
      afterLayoutChange();
      if (st.episode > 0) toast(`Picked up where you left off: ${fmtInt(st.episode)} practice orders.`);
    } else setLayout(S.presets.Warehouse, "Warehouse");
  } catch (err) {
    setLayout(["P.....", ".##.#.", ".##.#P", "......", ".#..#.", ".#.D.."], null);
    toast(err.message, "bad");
  }
  updateCharts();
  requestAnimationFrame(frame);
  if (document.fonts) document.fonts.ready.then(() => { requestDraw(); updateCharts(); });
  try {
    if (!localStorage.getItem("wrl-seen-help")) { $("#help").showModal(); localStorage.setItem("wrl-seen-help", "1"); }
  } catch { /* storage may be blocked; that's fine */ }
}
init();
