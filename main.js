import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Reach, CELL, parseStreets } from "./engine.js";
import { PAL, VIR, lerpPal, makeScale, fmtKm, MEANS } from "./scale.js";
import { createDistricts } from "./districts.js";
import { createPopulation } from "./population.js";

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron"; // бесплатная векторная карта, без ключей
const BASE = import.meta.env.BASE_URL;
const CENTER = [37.6208, 55.7539]; // Красная площадь

maplibregl.setWorkerUrl(`${location.origin}${BASE}maplibre/maplibre-gl-worker.mjs`);

// ---------- состояние (с восстановлением из адреса) ----------
const GROUPS = [
  { name: "Метро", modes: [0] },
  { name: "МЦК", modes: [1] },
  { name: "МЦД", modes: [2] },
  { name: "Трамвай и троллейбус", modes: [3, 4] },
  { name: "Автобус", modes: [5] },
];
const PACES = [
  { name: "Спокойно · 4 км/ч", kmh: 4 },
  { name: "Обычно · 5 км/ч", kmh: 5 },
  { name: "Быстро · 6 км/ч", kmh: 6 },
];
const q = new URLSearchParams(location.search);
const state = {
  lon: 37.6176, lat: 55.7558,
  minutes: 30,
  transit: true,
  groups: GROUPS.map(() => true),
  pace: 1,
  view: "zone", // zone | remote | access | districts | pop
  ps: 2, // сглаживание населения
  aT: 60,
  mean: "arith", // середина шкалы: arith | geo | quad
  dMetric: "acc", dSel: null,
};
try {
  const o = q.get("o")?.split(",").map(Number);
  if (o && o.length === 2 && o.every(Number.isFinite)) [state.lat, state.lon] = o;
  if (q.has("t")) { const t = Number(q.get("t")); if (t >= 5 && t <= 120) state.minutes = Math.round(t / 5) * 5; }
  if (q.get("w") === "1") state.transit = false;
  const m = q.get("m"); if (m && /^[01]{5}$/.test(m)) state.groups = [...m].map((c) => c === "1");
  if (q.has("p")) { const p = Number(q.get("p")); if (p >= 0 && p < PACES.length) state.pace = p; }
  if (["remote", "access", "districts", "pop"].includes(q.get("v"))) state.view = q.get("v");
  if (q.has("ps")) { const ps = Number(q.get("ps")); if (ps >= 0 && ps <= 3) state.ps = ps; }
  if (["arith", "geo", "quad"].includes(q.get("sk"))) state.mean = q.get("sk");
  if (q.get("dm")) state.dMetric = q.get("dm");
  if (q.has("d")) { const d = Number(q.get("d")); if (Number.isFinite(d)) state.dSel = d; }
  if (q.has("a")) { const a = Number(q.get("a")); if (a >= 10 && a <= 120) state.aT = Math.round(a / 10) * 10; }
} catch {}

const style = await (await fetch(STYLE_URL)).json();
for (const l of style.layers) { // подписи только по-русски, где есть перевод
  if (l.type === "symbol" && l.layout?.["text-field"]) l.layout["text-field"] = ["coalesce", ["get", "name:ru"], ["get", "name"]];
}
const map = new maplibregl.Map({
  container: "map",
  center: [state.lon, state.lat],
  zoom: 10.5,
  maxBounds: [36.5, 54.9, 38.8, 56.6],
  style,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
map.on("error", (e) => console.warn("map error:", e.error?.message || e.message));
if (import.meta.env.DEV) window.__map = map;

// ---------- вспомогательное ----------
const $ = (id) => document.getElementById(id);
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} ч ${Math.round(m % 60)} мин` : `${Math.round(m)} мин`);

function mkChip(parent, label, pressed, onClick) {
  const b = document.createElement("button");
  b.className = "chip"; b.textContent = label; b.setAttribute("aria-pressed", pressed);
  b.onclick = () => onClick(b);
  parent.appendChild(b);
  return b;
}

function bandStep(minutes) { for (const s of [5, 10, 15, 20, 30]) if (minutes / s <= 6) return s; return 30; }

/**
 * Полосы по времени → ImageData. src — Float32Array sw×sh (секунды, y вверх), cols — цвета полос.
 * Время интерполируем билинейно (SS× разрешение), границы полос и край — тёмной тонкой линией.
 */
function bandImage(ctx2, src, sw, sh, budget, stepSec, cols, SS) {
  const OW = sw * SS, OH = sh * SS, nb = cols.length, cap = budget * 1.6;
  const tv = (x, y) => { const t = src[y * sw + x]; return t < cap ? t : cap; };
  const bands = new Int8Array(OW * OH);
  for (let oy = 0; oy < OH; oy++) {
    const g = Math.min(sh - 1.001, Math.max(0, (oy + 0.5) / SS - 0.5)), yy = Math.floor(g), fy = g - yy;
    for (let ox = 0; ox < OW; ox++) {
      const h = Math.min(sw - 1.001, Math.max(0, (ox + 0.5) / SS - 0.5)), xx = Math.floor(h), fx = h - xx;
      const t = (tv(xx, yy) * (1 - fx) + tv(xx + 1, yy) * fx) * (1 - fy) + (tv(xx, yy + 1) * (1 - fx) + tv(xx + 1, yy + 1) * fx) * fy;
      bands[oy * OW + ox] = t <= budget ? Math.min(nb - 1, Math.floor(t / stepSec)) : -1;
    }
  }
  const img = ctx2.createImageData(OW, OH), d = img.data;
  for (let y = 0; y < OH; y++) {
    const row = (OH - 1 - y) * OW;
    for (let x = 0; x < OW; x++) {
      const idx = y * OW + x, bnd = bands[idx];
      if (bnd < 0) continue;
      const o = (row + x) * 4, c = cols[bnd];
      const edge = (x + 1 < OW && bands[idx + 1] !== bnd) || (y + 1 < OH && bands[idx + OW] !== bnd) || (x > 0 && bands[idx - 1] < 0) || (y > 0 && bands[idx - OW] < 0);
      const k = edge ? 0.6 : 1;
      d[o] = c[0] * k; d[o + 1] = c[1] * k; d[o + 2] = c[2] * k; d[o + 3] = edge ? 200 : 150;
    }
  }
  return img;
}

// ---------- два холста: зона и «тепловая» карта ----------
function makeCanvas() { const c = document.createElement("canvas"); c.width = 1; c.height = 1; return { canvas: c, ctx: c.getContext("2d"), last: null }; }
const zoneCv = makeCanvas(), heatCv = makeCanvas();
function pushImage(cv, sourceId, coords) {
  cv.canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    map.getSource(sourceId).updateImage({ url, coordinates: coords });
    if (cv.last) { const old = cv.last; setTimeout(() => URL.revokeObjectURL(old), 2000); }
    cv.last = url;
  });
}

let reach = null, pin = null, centerMarker = null, worker = null, stations = [], dist = null, popMod = null, popGrid = null;
let needRun = true, timer = 0;

// ---------- UI: вкладки, переключатели ----------
GROUPS.forEach((g, i) => mkChip($("chips"), g.name, state.groups[i], (b) => {
  state.groups[i] = !state.groups[i]; b.setAttribute("aria-pressed", state.groups[i]); paramsChanged();
}));
const paceBtns = PACES.map((p, i) => mkChip($("pace"), p.name, i === state.pace, () => {
  state.pace = i; paceBtns.forEach((b, j) => b.setAttribute("aria-pressed", j === i)); paramsChanged();
}));
$("bWalk").onclick = () => { state.transit = false; applyView(); paramsChanged(); };
$("bTransit").onclick = () => { state.transit = true; applyView(); paramsChanged(); };
$("slider").value = state.minutes;
$("slider").oninput = () => { state.minutes = Number($("slider").value); changed(false); };
$("aSlider").value = state.aT;
$("aSlider").oninput = () => { state.aT = Number($("aSlider").value); renderAccess(); syncUrl(); };
for (const b of document.querySelectorAll("#tabs button")) b.onclick = () => setView(b.dataset.v);
const scaleBtns = MEANS.map((m) => mkChip($("scaleChips"), m.name, m.id === state.mean, () => {
  state.mean = m.id; scaleBtns.forEach((b, j) => b.setAttribute("aria-pressed", MEANS[j].id === state.mean));
  if (state.view === "access") renderAccess(); else if (state.view === "districts") dist?.render(); else if (state.view === "pop") popMod?.render();
  syncUrl();
}));

function paramsChanged() { // поменялись транспорт/темп
  if (state.view === "zone") changed(true);
  else if (state.view === "remote") { needRun = true; loadRemote(); }
}

function applyView() {
  const v = state.view;
  for (const b of document.querySelectorAll("#tabs button")) b.setAttribute("aria-pressed", b.dataset.v === v);
  $("bWalk").setAttribute("aria-pressed", !state.transit);
  $("bTransit").setAttribute("aria-pressed", state.transit);
  $("vZone").hidden = v !== "zone"; $("vRemote").hidden = v !== "remote"; $("vAccess").hidden = v !== "access";
  $("vDistricts").hidden = v !== "districts"; $("districtsStats").hidden = v !== "districts";
  $("vPop").hidden = v !== "pop"; $("popStats").hidden = v !== "pop";
  $("scaleBox").hidden = !(v === "access" || v === "districts" || v === "pop");
  $("zoneStats").hidden = v !== "zone"; $("remoteStats").hidden = v !== "remote"; $("accessStats").hidden = v !== "access";
  $("transitOpts").hidden = !((v === "zone" && state.transit) || v === "remote");
  $("paceBox").hidden = v === "access" || v === "districts" || v === "pop";
  $("hintZone").hidden = v !== "zone";
  $("tip").style.display = "none";
  if (map.getLayer("reach")) {
    map.setLayoutProperty("reach", "visibility", v === "zone" ? "visible" : "none");
    map.setLayoutProperty("heat", "visibility", v === "remote" || v === "access" || v === "pop" ? "visible" : "none");
  }
  if (pin) pin.getElement().style.display = v === "zone" ? "" : "none";
  if (centerMarker) centerMarker.getElement().style.display = v === "remote" ? "" : "none";
  map.getCanvas().style.cursor = v === "zone" ? "crosshair" : "";
}

function setView(v) {
  state.view = v; applyView(); syncUrl();
  if (!reach) return;
  if (v !== "districts") dist?.hide();
  if (v === "zone") changed(false);
  else if (v === "remote") loadRemote();
  else if (v === "access") loadAccess();
  else if (v === "districts") dist?.show();
  else popMod?.render();
}

// ---------- режим «Зона» ----------
function changed(rerun) {
  if (rerun) needRun = true;
  clearTimeout(timer);
  timer = setTimeout(update, 30);
}

const scratch = { buf: null };
function popInZone(best, budget, bb) { // сумма жителей по ячейкам зоны (население ячейки 120 м делим на 16 ячеек по 30 м)
  const { W } = reach, { w, r, a } = popGrid, k = 1 / (r * r);
  if (popGrid.mosTotal == null) { let t = 0; for (let Y = 0; Y < popGrid.h; Y++) for (let X = 0; X < w; X++) if (reach.mos[Math.min(reach.H - 1, Y * r + 2) * W + Math.min(W - 1, X * r + 2)]) t += a[Y * w + X]; popGrid.mosTotal = t; }
  let total = 0, mos = 0;
  if (bb) for (let y = bb.y0; y < bb.y1; y++) for (let x = bb.x0, i = y * W + x; x < bb.x1; x++, i++) if (best[i] <= budget) { const p = a[Math.floor(y / r) * w + Math.floor(x / r)] * k; total += p; if (reach.mos[i]) mos += p; }
  return { total, mos, mosTotal: popGrid.mosTotal };
}
function update() {
  if (!reach || state.view !== "zone") return;
  const t0 = performance.now();
  const minutes = state.minutes;
  $("mins").textContent = minutes;
  const budget = minutes * 60;
  const modes = [false, false, false, false, false, false];
  if (state.transit) GROUPS.forEach((g, i) => state.groups[i] && g.modes.forEach((m) => (modes[m] = true)));
  const walkMs = (PACES[state.pace].kmh * 1000) / 3600;
  if (needRun) {
    const ok = reach.run(state.lon, state.lat, { walkMs, modes, maxSec: 120 * 60 }, 0);
    needRun = false;
    if (!ok) { $("area").textContent = "Рядом со стартом нет улиц — выберите точку в городе"; return; }
    scheduleCurves(modes, walkMs);
  }
  const best = reach.raster(budget, 0);
  const { W } = reach;
  const step = bandStep(minutes), stepSec = step * 60;
  const nb = Math.ceil(minutes / step);
  const cols = Array.from({ length: nb }, (_, i) => lerpPal(PAL, nb === 1 ? 0 : i / (nb - 1)));
  $("legend").innerHTML = cols.map((c) => `<i style="background:rgb(${c})"></i>`).join("");
  $("legendEnd").textContent = `${minutes} мин (деления по ${step} мин)`;
  const bb = reach.bbox;
  if (!bb) {
    $("area").innerHTML = "Площадь: <b>0 км²</b>"; map.getSource("reach").updateImage({ url: BLANK, coordinates: reach.corners });
    return;
  }
  // рисуем только прямоугольник с зоной, в двойном разрешении (если влезает в ~16 млн пикселей)
  const x0 = Math.max(0, bb.x0 - 2), x1 = Math.min(reach.W, bb.x1 + 2), y0 = Math.max(0, bb.y0 - 2), y1 = Math.min(reach.H, bb.y1 + 2);
  const cw = x1 - x0, ch = y1 - y0;
  if (!scratch.buf || scratch.buf.length < cw * ch) scratch.buf = new Float32Array(cw * ch);
  const sub = scratch.buf.subarray(0, cw * ch);
  let cells = 0;
  for (let y = 0; y < ch; y++) {
    const row = (y0 + y) * W + x0; sub.set(best.subarray(row, row + cw), y * cw);
  }
  for (let i = 0; i < sub.length; i++) if (sub[i] <= budget) cells++;
  const SS = cw * ch * 4 <= 16e6 ? 2 : 1;
  if (zoneCv.canvas.width !== cw * SS || zoneCv.canvas.height !== ch * SS) { zoneCv.canvas.width = cw * SS; zoneCv.canvas.height = ch * SS; }
  zoneCv.ctx.putImageData(bandImage(zoneCv.ctx, sub, cw, ch, budget, stepSec, cols, SS), 0, 0);
  pushImage(zoneCv, "reach", reach.cornersFor(x0, y0, x1, y1));

  const km2 = (cells * CELL * CELL) / 1e6;
  $("area").innerHTML = `Площадь: <b>${fmtKm(km2)} км²</b>`;
  // быстрая статистика
  const h = reach.histogram(best, budget, 1);
  $("tShare").textContent = h.mosKm2 ? `${Math.min(100, (h.mosCum[1] / h.mosKm2) * 100).toFixed(h.mosCum[1] / h.mosKm2 < 0.1 ? 1 : 0)}%`.replace(".", ",") : "—";
  const sc = reach.countStops(budget, 0);
  $("tStations").textContent = `${sc.stations}`; $("tHubs").textContent = sc.hubs.toLocaleString("ru");
  const pz = popInZone(best, budget, bb);
  $("tPop").textContent = pz.total >= 1e6 ? `${(pz.total / 1e6).toFixed(1).replace(".", ",")} млн` : `${Math.round(pz.total / 1e3)} тыс.`;
  $("tPopShare").textContent = pz.mosTotal ? `${Math.round((pz.mos / pz.mosTotal) * 100)}%` : "—";
  drawZoneChart();
  syncUrl();
  if (import.meta.env.DEV) console.log(`update ${Math.round(performance.now() - t0)} мс, ${cells} ячеек`);
}

// ---- график площади по времени (считается в фоне)
let curves = null, curveKey = "", curveId = 0, curveTimer = 0;
function scheduleCurves(modes, walkMs) {
  const key = [state.lon.toFixed(5), state.lat.toFixed(5), state.pace, modes.join("")].join("|");
  if (key === curveKey) return;
  curveKey = key; curves = null;
  $("zoneBusy").textContent = "Считаю график…";
  drawZoneChart();
  clearTimeout(curveTimer);
  curveTimer = setTimeout(() => { worker?.postMessage({ type: "curves", id: ++curveId, lon: state.lon, lat: state.lat, walkMs, modes }); }, 500);
}

const interp = (arr, minutes) => { // arr[k] — значение при (k+1)·5 мин
  if (!arr) return null;
  const x = minutes / 5, k = Math.floor(x), f = x - k;
  const a = k === 0 ? 0 : arr[k - 1], b = arr[Math.min(arr.length - 1, k)];
  return a + (b - a) * f;
};

function drawZoneChart() {
  const svg = $("chartZone");
  if (!curves || !curves.tr) { svg.innerHTML = ""; $("tBoost").textContent = "—"; return; }
  const { tr, wk } = curves, W = 320, H = 150, L = 36, R = 8, T = 8, B = 20, pw = W - L - R, ph = H - T - B;
  const ymaxRaw = Math.max(...tr, 1), mag = 10 ** Math.floor(Math.log10(ymaxRaw)), ymax = Math.ceil(ymaxRaw / mag) * mag;
  const X = (m) => L + (m / 120) * pw, Y = (v) => T + ph - (v / ymax) * ph;
  const path = (arr) => "M" + X(0) + "," + Y(0) + arr.map((v, k) => `L${X((k + 1) * 5).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  let g = "";
  for (let i = 0; i <= 4; i++) { const v = (ymax * i) / 4; g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 4}" y="${Y(v) + 3}" text-anchor="end">${fmtKm(v)}</text>`; }
  for (const m of [0, 30, 60, 90, 120]) g += `<text x="${X(m)}" y="${H - 6}" text-anchor="middle">${m}</text>`;
  const cur = interp(tr, state.minutes);
  const mk = `<line class="mk" x1="${X(state.minutes)}" x2="${X(state.minutes)}" y1="${T}" y2="${T + ph}"/><circle class="dot" cx="${X(state.minutes)}" cy="${Y(cur)}" r="4"/>`;
  svg.innerHTML = g + (wk ? `<path class="l2" d="${path(wk)}"/>` : "") + `<path class="l1" d="${path(tr)}"/>` + mk +
    `<text x="${W - R}" y="${T + 10}" text-anchor="end">км² за N мин</text>`;
  const w = interp(wk, state.minutes);
  $("tBoost").textContent = w && w > 0.5 ? `×${(cur / w).toFixed(cur / w < 10 ? 1 : 0).replace(".", ",")}` : "—";
  $("zoneBusy").textContent = "";
}

// ---------- режим «Удалённость от центра» ----------
let remote = null, remoteKey = "", remoteId = 0;
function currentModes() {
  const modes = [false, false, false, false, false, false];
  GROUPS.forEach((g, i) => state.groups[i] && g.modes.forEach((m) => (modes[m] = true)));
  return modes;
}
function loadRemote() {
  if (!worker) return;
  const modes = currentModes(), walkMs = (PACES[state.pace].kmh * 1000) / 3600;
  const key = [state.pace, modes.join("")].join("|");
  if (remote && key === remoteKey) { renderRemote(); return; }
  remoteKey = key; remote = null;
  map.getSource("heat").updateImage({ url: BLANK, coordinates: reach.corners });
  $("remoteBusy").textContent = "Считаю маршруты от центра до всего города…";
  $("busy").style.display = "block"; $("busy").textContent = "Считаю…";
  worker.postMessage({ type: "remote", id: ++remoteId, lon: CENTER[0], lat: CENTER[1], walkMs, modes });
}
function renderRemote() {
  if (!remote || state.view !== "remote") return;
  const r = remote, w = r.x1 - r.x0, h = r.y1 - r.y0;
  const SS = w * h * 4 <= 16e6 ? 2 : 1;
  const cols = VIR; // 10 полос по 15 минут: ярко → тёмно
  heatCv.canvas.width = w * SS; heatCv.canvas.height = h * SS;
  heatCv.ctx.putImageData(bandImage(heatCv.ctx, r.data, w, h, 150 * 60, 900, cols, SS), 0, 0);
  pushImage(heatCv, "heat", reach.cornersFor(r.x0, r.y0, r.x1, r.y1));
  $("rLegend").innerHTML = cols.map((c) => `<i style="background:rgb(${c})"></i>`).join("");
  // статистика по Москве
  const cum = r.mosCum, tot = r.mosKm2;
  const at = (frac) => { // минуты, к которым охвачена доля frac территории
    for (let k = 0; k < cum.length; k++) if (cum[k] >= frac * tot) { const prev = k ? cum[k - 1] : 0; return (k + (frac * tot - prev) / (cum[k] - prev || 1)) * 15; }
    return null;
  };
  const med = at(0.5);
  $("rMedian").textContent = med == null ? "> 2,5 ч" : fmtMin(med);
  $("rFar").textContent = `${Math.round((1 - cum[3] / tot) * 100)}%`;
  // гистограмма: 10 полос по 15 минут + «дальше 2,5 ч или без дорог»
  const svg = $("chartRemote"), W = 320, H = 140, L = 6, T = 14, B = 22, pw = W - L - 6, ph = H - T - B;
  const shares = cum.map((c, k) => (c - (k ? cum[k - 1] : 0)) / tot);
  shares.push(Math.max(0, 1 - cum[cum.length - 1] / tot));
  const mx = Math.max(...shares.slice(0, -1), 0.01), bw = pw / shares.length;
  let g = "";
  shares.forEach((s, k) => {
    const last = k === shares.length - 1, hgt = Math.min(1, s / mx) * ph, x = L + k * bw;
    g += `<rect x="${x + 1}" y="${T + ph - hgt}" width="${bw - 2}" height="${hgt}" rx="2" fill="${last ? "#8a949c" : `rgb(${VIR[k]})`}"/>`;
    if (last) g += `<text x="${x + bw / 2}" y="${T + ph - hgt / 2}" text-anchor="middle" style="fill:#fff;font-weight:600">${Math.round(s * 100)}%</text>`;
    else if (s >= 0.03) g += `<text x="${x + bw / 2}" y="${T + ph - hgt - 3}" text-anchor="middle">${Math.round(s * 100)}%</text>`;
    g += `<text x="${x + bw}" y="${H - 8}" text-anchor="middle">${last ? "∞" : (k + 1) * 15}</text>`;
  });
  g += `<text x="${L}" y="${H - 8}" text-anchor="start">0</text>`;
  svg.innerHTML = g;
  $("remoteBusy").textContent = "По горизонтали — минуты пути от центра. ∞ — дольше 2,5 часов или нет улиц на карте.";
}

// ---------- режим «Доступность» ----------
let access = null, accessTried = false, vals = null;
async function loadAccess() {
  if (!access && !accessTried) {
    accessTried = true;
    $("busy").style.display = "block"; $("busy").textContent = "Загружаю данные…";
    try { access = await (await fetch(`${BASE}access.json`)).json(); }
    catch { access = null; }
    $("busy").style.display = "none";
  }
  if (!access) { $("aSummary").textContent = "Данные доступности недоступны"; return; }
  renderAccess();
}
function accessValueAt(lon, lat) { // значение из выборки в точке (билинейно), null вне покрытия
  const [cx, cy] = reach.lonLatToCell(lon, lat);
  return sampleAccess(cx, cy);
}
function sampleAccess(cx, cy) {
  const SP = access.sp, nx = vals.nx, u = cx / SP - 0.5, v = cy / SP - 0.5, i0 = Math.floor(u), j0 = Math.floor(v), fx = u - i0, fy = v - j0;
  let s = 0, wsum = 0;
  for (let dj = 0; dj <= 1; dj++) for (let di = 0; di <= 1; di++) {
    const i = i0 + di, j = j0 + dj;
    if (i < 0 || j < 0 || i >= nx || j >= vals.ny) continue;
    const val = vals.a[j * nx + i]; if (val < 0) continue;
    const w = (di ? fx : 1 - fx) * (dj ? fy : 1 - fy); s += val * w; wsum += w;
  }
  return wsum >= 0.45 ? s / wsum : null;
}
function stationNear(lon, lat) {
  let best = null, bd = 1e9;
  for (const s of stations) { const d = Math.hypot((s.lon - lon) * 62, (s.lat - lat) * 111); if (d < bd) { bd = d; best = s; } }
  return best ? { name: best.name, km: bd } : null;
}
function renderAccess() {
  if (!access || !reach || state.view !== "access") return;
  const T = state.aT, ti = T / access.step - 1, SP = access.sp;
  $("aMins").textContent = T;
  const nx = Math.ceil(reach.W / SP) + 1, ny = Math.ceil(reach.H / SP) + 1, a = new Float32Array(nx * ny).fill(-1);
  const moscow = [];
  for (const p of access.pts) { const v = p[3 + ti]; a[p[1] * nx + p[0]] = v; if (p[2]) moscow.push({ v, ix: p[0], iy: p[1] }); }
  vals = { a, nx, ny };
  const allVals = access.pts.map((p) => p[3 + ti]), mosVals = moscow.map((m) => m.v);
  const sc = makeScale(allVals, state.mean, mosVals); // от самого малого до самого большого значения, без «среза»
  const sorted = mosVals.slice().sort((x, y) => x - y);
  // картинка: грубая сетка (4 ячейки на пиксель), мягкая интерполяция между стартами; реки пустые
  const R = 4, cwid = Math.ceil(reach.W / R), chei = Math.ceil(reach.H / R);
  heatCv.canvas.width = cwid; heatCv.canvas.height = chei;
  const img = heatCv.ctx.createImageData(cwid, chei), d = img.data, { cov, barrier, W } = reach;
  for (let Y = 0; Y < chei; Y++) {
    const row = (chei - 1 - Y) * cwid;
    for (let X = 0; X < cwid; X++) {
      const cx = (X + 0.5) * R, cy = (Y + 0.5) * R, ci = Math.floor(cy) * W + Math.floor(cx);
      if (!cov[ci] || barrier[ci]) continue;
      const v = sampleAccess(cx, cy); if (v == null) continue;
      const c = lerpPal(VIR, 1 - sc.f(v)); // больше площадь → ярче
      const o = (row + X) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 175;
    }
  }
  heatCv.ctx.putImageData(img, 0, 0);
  pushImage(heatCv, "heat", reach.corners);
  $("aLegend").style.background = `linear-gradient(90deg, ${[1, 0.75, 0.5, 0.25, 0].map((x) => `rgb(${lerpPal(VIR, x)})`).join(",")})`;
  const mname = MEANS.find((x) => x.id === state.mean).short;
  $("aLo").textContent = `${fmtKm(sc.min)} км²`; $("aMid").textContent = `${mname} ${fmtKm(sc.mid)}`; $("aHi").textContent = `${fmtKm(sc.max)} км²`;
  $("scaleInfo").textContent = `Среднее по Москве: арифм. ${fmtKm(sc.arith)} · геом. ${fmtKm(sc.geo)} · квадр. ${fmtKm(sc.quad)} км²`;
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length, best = sorted[sorted.length - 1], worst = sorted[0];
  $("aSummary").innerHTML = `В среднем по Москве: <b>${fmtKm(mean)} км²</b> · от ${fmtKm(worst)} до ${fmtKm(best)}`;
  // рейтинги
  const label = (m) => {
    const [lon, lat] = reach.cornersFor((m.ix + 0.5) * SP, (m.iy + 0.5) * SP, (m.ix + 0.5) * SP, (m.iy + 0.5) * SP)[0];
    const st = stationNear(lon, lat);
    const far = st && st.km > 2.5;
    return {
      lon, lat,
      text: !st ? `${lat.toFixed(3)}, ${lon.toFixed(3)}` : far ? `в ${Math.round(st.km)} км от метро` : `у ст. ${st.name}`,
      sub: !st ? "" : far ? `ближайшая станция: ${st.name}` : `${st.km < 1 ? Math.round(st.km * 1000) + " м" : st.km.toFixed(1).replace(".", ",") + " км"} до станции`,
    };
  };
  const minReal = 0.1 * Math.PI * (0.0833 * T) ** 2; // меньше — «карман» в данных, а не настоящая изоляция
  const bySize = moscow.filter((m) => m.v >= minReal).sort((x, y) => y.v - x.v);
  const fill = (el, list) => {
    el.innerHTML = "";
    list.forEach((m, i) => {
      const lb = label(m), li = document.createElement("li");
      li.innerHTML = `<span class="n">${i + 1}</span><span class="nm">${lb.text}<small>${lb.sub}</small></span><span class="v">${fmtKm(m.v)} км²</span>`;
      li.onclick = () => { state.lon = lb.lon; state.lat = lb.lat; pin.setLngLat([lb.lon, lb.lat]); needRun = true; curveKey = ""; setView("zone"); map.flyTo({ center: [lb.lon, lb.lat], zoom: 11.5 }); };
      el.appendChild(li);
    });
  };
  fill($("rankTop"), bySize.slice(0, 5));
  fill($("rankBottom"), bySize.slice(-5).reverse());
}

// ---------- адрес, старт ----------
function syncUrl() {
  const p = new URLSearchParams();
  if (state.view !== "zone") p.set("v", state.view);
  if (state.view === "pop" && state.ps !== 2) p.set("ps", state.ps);
  if (state.mean !== "arith") p.set("sk", state.mean);
  if (state.view === "districts") { p.set("dm", state.dMetric); if (state.dSel != null) p.set("d", state.dSel); }
  p.set("o", `${state.lat.toFixed(5)},${state.lon.toFixed(5)}`);
  p.set("t", state.minutes);
  if (state.view === "access" || (state.view === "districts" && state.dMetric === "acc")) p.set("a", state.aT);
  if (!state.transit) p.set("w", 1);
  if (state.groups.some((g) => !g)) p.set("m", state.groups.map((g) => (g ? 1 : 0)).join(""));
  if (state.pace !== 1) p.set("p", state.pace);
  try { history.replaceState(null, "", "?" + p); } catch {}
}

function setOrigin(lon, lat) {
  if (state.view !== "zone" || !reach.inside(lon, lat)) return;
  state.lon = lon; state.lat = lat;
  pin.setLngLat([lon, lat]);
  changed(true);
}

map.on("load", async () => {
  $("busy").style.display = "block"; $("busy").textContent = "Загружаю сеть…";
  // Сервер может отдать файл и сжатым (GitHub Pages), и уже распакованным (dev-сервер с Content-Encoding) —
  // смотрим на первые байты: 1f 8b = gzip.
  const gunzip = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    const buf = await r.arrayBuffer();
    const head = new Uint8Array(buf, 0, 2);
    if (head[0] !== 0x1f || head[1] !== 0x8b) return buf;
    return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  };
  const [net, streetsBuf, barrierBuf, coverBuf, moscowBuf, metro, popBuf] = await Promise.all([
    fetch(`${BASE}network.json`).then((r) => r.json()),
    gunzip(`${BASE}streets.bin.gz`),
    gunzip(`${BASE}barrier.bin.gz`),
    gunzip(`${BASE}cover.bin.gz`),
    gunzip(`${BASE}moscow.bin.gz`),
    fetch(`${BASE}metro.json`).then((r) => r.json()),
    gunzip(`${BASE}pop.bin.gz`),
  ]);
  $("busy").textContent = "Строю граф улиц…";
  await new Promise((r) => setTimeout(r, 30)); // дать перерисоваться подписи
  reach = new Reach(net, parseStreets(streetsBuf), new Uint8Array(barrierBuf), coverBuf, moscowBuf);
  stations = metro.features.filter((f) => f.properties.kind === "station" && f.properties.metro === true).map((f) => ({ name: f.properties.name, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
  reach.setStations(stations.map((s) => [s.lon, s.lat]));

  { const hdr = new Int32Array(popBuf.slice(0, 12)); popGrid = { w: hdr[0], h: hdr[1], r: hdr[2], a: new Float32Array(popBuf.slice(12)) }; }

  // воркер с собственной копией движка для тяжёлых расчётов (буферы передаём ему)
  try {
    worker = new Worker(new URL("./stats-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") { worker.ready = true; return; }
      if (m.type === "curves" && m.id === curveId) { curves = m; drawZoneChart(); }
      if (m.type === "remote" && m.id === remoteId) {
        $("busy").style.display = "none";
        if (!m.ok) { $("remoteBusy").textContent = "Не удалось посчитать"; return; }
        remote = m; renderRemote();
      }
    };
    worker.postMessage({ type: "init", net, streets: streetsBuf, barrier: barrierBuf, cover: coverBuf, moscow: moscowBuf }, [streetsBuf, barrierBuf, coverBuf, moscowBuf]);
  } catch (e) { console.warn("воркер недоступен", e); }

  const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  for (const id of ["reach", "heat"]) map.addSource(id, { type: "image", url: BLANK, coordinates: reach.corners });
  map.addLayer({ id: "heat", type: "raster", source: "heat", layout: { visibility: "none" }, paint: { "raster-opacity": 1, "raster-fade-duration": 0 } }, firstSymbol);
  map.addLayer({ id: "reach", type: "raster", source: "reach", paint: { "raster-opacity": 1, "raster-fade-duration": 0 } }, firstSymbol);

  // ---- метро, МЦК и МЦД на карте
  map.addSource("metro", { type: "geojson", data: metro });
  const isLine = ["==", ["geometry-type"], "LineString"];
  const W = (a, b, c) => ["interpolate", ["linear"], ["zoom"], 9, a, 13, b, 16, c];
  map.addLayer({ id: "metro-casing", type: "line", source: "metro", filter: ["all", isLine, ["!=", ["get", "kind"], "mcd"]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#fff", "line-opacity": 0.85, "line-width": W(1.4, 3, 8) } }, firstSymbol);
  map.addLayer({ id: "mcd-lines", type: "line", source: "metro", filter: ["all", isLine, ["==", ["get", "kind"], "mcd"]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "colour"], "line-opacity": 0.75, "line-width": W(0.4, 1, 2.5) } }, firstSymbol);
  map.addLayer({ id: "metro-lines", type: "line", source: "metro", filter: ["all", isLine, ["!=", ["get", "kind"], "mcd"]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "colour"], "line-width": W(0.7, 1.8, 5) } }, firstSymbol);
  map.addLayer({ id: "metro-stations", type: "circle", source: "metro", filter: ["all", ["==", ["get", "kind"], "station"], ["==", ["get", "metro"], true]], paint: { "circle-radius": W(0.8, 2.4, 5.5), "circle-color": "#fff", "circle-stroke-width": W(0.5, 1.1, 2), "circle-stroke-color": ["case", ["==", ["get", "n"], 1], ["get", "colours"], "#2b2b2b"] } }, firstSymbol);
  map.addLayer({ id: "mcd-stations", type: "circle", minzoom: 12, source: "metro", filter: ["all", ["==", ["get", "kind"], "station"], ["==", ["get", "metro"], false]], paint: { "circle-radius": W(0.8, 1.8, 3.5), "circle-color": "#fff", "circle-stroke-width": 0.8, "circle-stroke-color": "#555" } }, firstSymbol);
  map.addLayer({ id: "metro-labels", type: "symbol", source: "metro", minzoom: 12.5, filter: ["all", ["==", ["get", "kind"], "station"], ["==", ["get", "metro"], true]], layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 12.5, 10, 16, 13], "text-offset": [0, 0.8], "text-anchor": "top", "text-optional": true }, paint: { "text-color": "#222", "text-halo-color": "#fff", "text-halo-width": 1.5 } });
  // ---- границы Москвы
  map.addSource("boundary", { type: "geojson", data: `${BASE}boundary.json` });
  map.addLayer({ id: "boundary-casing", type: "line", source: "boundary", layout: { "line-join": "round" }, paint: { "line-color": "#fff", "line-opacity": 0.8, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 14, 5] } }, firstSymbol);
  map.addLayer({ id: "boundary", type: "line", source: "boundary", layout: { "line-join": "round" }, paint: { "line-color": "#c0392b", "line-dasharray": [4, 2], "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.2, 14, 2.4] } }, firstSymbol);
  const bchip = $("chipBoundary");
  bchip.onclick = () => { const on = bchip.getAttribute("aria-pressed") !== "true"; bchip.setAttribute("aria-pressed", on); for (const id of ["boundary-casing", "boundary"]) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); };
  const METRO_LAYERS = ["metro-casing", "mcd-lines", "metro-lines", "metro-stations", "mcd-stations", "metro-labels"];
  const chip = $("chipMetro");
  chip.onclick = () => { const on = chip.getAttribute("aria-pressed") !== "true"; chip.setAttribute("aria-pressed", on); for (const id of METRO_LAYERS) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); };

  popMod = createPopulation({ map, $, state, reach, pop: popGrid, pushImage, heatCv, stationNear, getMean: () => state.mean, onChange: syncUrl });
  dist = createDistricts({ map, $, state, BASE, beforeId: "metro-casing", getMean: () => state.mean, onChange: syncUrl });

  const el = document.createElement("div"); el.className = "pin";
  pin = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([state.lon, state.lat]).addTo(map);
  pin.on("dragend", () => { const p = pin.getLngLat(); setOrigin(p.lng, p.lat); });
  const cel = document.createElement("div"); cel.className = "pin center";
  centerMarker = new maplibregl.Marker({ element: cel }).setLngLat(CENTER).addTo(map);
  map.on("click", (e) => setOrigin(e.lngLat.lng, e.lngLat.lat));
  // значение под курсором в режиме «Доступность»
  const tip = $("tip");
  map.on("mousemove", (e) => {
    if (state.view !== "access" || !vals) { tip.style.display = "none"; return; }
    const v = accessValueAt(e.lngLat.lng, e.lngLat.lat);
    if (v == null) { tip.style.display = "none"; return; }
    tip.textContent = `≈ ${fmtKm(v)} км² за ${state.aT} мин отсюда`;
    tip.style.display = "block"; tip.style.left = `${e.point.x + 14}px`; tip.style.top = `${e.point.y + 14}px`;
  });
  map.on("mouseout", () => { tip.style.display = "none"; });

  $("busy").style.display = "none";
  applyView();
  if (state.view === "zone") update(); else if (state.view === "access") loadAccess(); else if (state.view === "districts") dist.show(); else if (state.view === "pop") popMod.render(); else loadRemote(); // сообщения воркеру встают в очередь за init
});
