import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Reach, CELL } from "./engine.js";

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron"; // бесплатная векторная карта, без ключей
const BASE = import.meta.env.BASE_URL;

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
};
try {
  const o = q.get("o")?.split(",").map(Number);
  if (o && o.length === 2 && o.every(Number.isFinite)) [state.lat, state.lon] = o;
  if (q.has("t")) { const t = Number(q.get("t")); if (t >= 5 && t <= 120) state.minutes = Math.round(t / 5) * 5; }
  if (q.get("w") === "1") state.transit = false;
  const m = q.get("m"); if (m && /^[01]{5}$/.test(m)) state.groups = [...m].map((c) => c === "1");
  if (q.has("p")) { const p = Number(q.get("p")); if (p >= 0 && p < PACES.length) state.pace = p; }
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

// ---------- UI ----------
const $ = (id) => document.getElementById(id);
const slider = $("slider");
slider.value = state.minutes;

function mkChip(parent, label, pressed, onClick) {
  const b = document.createElement("button");
  b.className = "chip"; b.textContent = label; b.setAttribute("aria-pressed", pressed);
  b.onclick = () => onClick(b);
  parent.appendChild(b);
  return b;
}
GROUPS.forEach((g, i) => mkChip($("chips"), g.name, state.groups[i], (b) => {
  state.groups[i] = !state.groups[i];
  b.setAttribute("aria-pressed", state.groups[i]);
  changed(true);
}));
const paceBtns = PACES.map((p, i) => mkChip($("pace"), p.name, i === state.pace, () => {
  state.pace = i; paceBtns.forEach((b, j) => b.setAttribute("aria-pressed", j === i)); changed(true);
}));
function syncSeg() {
  $("bWalk").setAttribute("aria-pressed", !state.transit);
  $("bTransit").setAttribute("aria-pressed", state.transit);
  $("transitOpts").hidden = !state.transit;
}
$("bWalk").onclick = () => { state.transit = false; syncSeg(); changed(true); };
$("bTransit").onclick = () => { state.transit = true; syncSeg(); changed(true); };
slider.oninput = () => { state.minutes = Number(slider.value); quality = 1; changed(false); };
slider.onchange = () => { quality = 2; changed(false); };
syncSeg();

// ---------- расчёт и отрисовка ----------
const PALETTE = ["#0b3c5d", "#1d6a8a", "#2fa4a0", "#8fd18a", "#f4e285"]; // близко → далеко
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const PAL = PALETTE.map(hex);

function bandStep(minutes) { // 3–6 полос
  for (const s of [5, 10, 15, 20, 30]) if (minutes / s <= 6) return s;
  return 30;
}
function colorAt(i, n) { // i-я из n полос → цвет из палитры
  const x = n === 1 ? 0 : (i / (n - 1)) * (PAL.length - 1);
  const a = Math.floor(x), b = Math.min(PAL.length - 1, a + 1), f = x - a;
  return PAL[a].map((v, k) => Math.round(v + (PAL[b][k] - v) * f));
}

let reach = null, pin = null, canvas = null, ctx = null, lastBlob = null;
let needRun = true, timer = 0, quality = 2;

function changed(rerun) {
  if (rerun) needRun = true;
  clearTimeout(timer);
  timer = setTimeout(update, 30);
}

function update() {
  if (!reach) return;
  const t0 = performance.now();
  const minutes = state.minutes;
  $("mins").textContent = minutes;
  const budget = minutes * 60;
  if (needRun) {
    const modes = [false, false, false, false, false, false];
    if (state.transit) GROUPS.forEach((g, i) => state.groups[i] && g.modes.forEach((m) => (modes[m] = true)));
    reach.run(state.lon, state.lat, { walkMs: (PACES[state.pace].kmh * 1000) / 3600, modes, maxSec: 120 * 60 });
    needRun = false;
  }
  const best = reach.raster(budget);
  const { W, H } = reach;
  const step = bandStep(minutes), stepSec = step * 60;
  const nb = Math.ceil(minutes / step);
  const cols = Array.from({ length: nb }, (_, i) => colorAt(i, nb));
  const SS = quality;
  const OW = W * SS, OH = H * SS;
  if (canvas.width !== OW || canvas.height !== OH) { canvas.width = OW; canvas.height = OH; }
  // 1) полосы на сетке SS×, время интерполируем билинейно
  const cap = budget * 2;
  const tv = (x, y) => { const t = best[y * W + x]; return t < cap ? t : cap; };
  const bands = new Int8Array(OW * OH);
  let cells = 0;
  for (let oy = 0; oy < OH; oy++) {
    const gy = Math.min(H - 1.001, Math.max(0, (oy + 0.5) / SS - 0.5)), y0 = Math.floor(gy), fy = gy - y0;
    for (let ox = 0; ox < OW; ox++) {
      const gx = Math.min(W - 1.001, Math.max(0, (ox + 0.5) / SS - 0.5)), x0 = Math.floor(gx), fx = gx - x0;
      const t = (tv(x0, y0) * (1 - fx) + tv(x0 + 1, y0) * fx) * (1 - fy) + (tv(x0, y0 + 1) * (1 - fx) + tv(x0 + 1, y0 + 1) * fx) * fy;
      const v = t <= budget ? Math.min(nb - 1, Math.floor(t / stepSec)) : -1;
      bands[oy * OW + ox] = v;
      if (v >= 0) cells++;
    }
  }
  cells /= SS * SS;
  // 2) раскраска; границы полос и внешний край — тёмной тонкой линией
  const img = ctx.createImageData(OW, OH);
  const d = img.data;
  for (let y = 0; y < OH; y++) {
    const row = (OH - 1 - y) * OW; // y вверх → строка картинки сверху
    for (let x = 0; x < OW; x++) {
      const idx = y * OW + x, bnd = bands[idx];
      if (bnd < 0) continue;
      const o = (row + x) * 4, c = cols[bnd];
      const edge = (x + 1 < OW && bands[idx + 1] !== bnd) || (y + 1 < OH && bands[idx + OW] !== bnd) || (x > 0 && bands[idx - 1] < 0) || (y > 0 && bands[idx - OW] < 0);
      const k = edge ? 0.6 : 1;
      d[o] = c[0] * k; d[o + 1] = c[1] * k; d[o + 2] = c[2] * k;
      d[o + 3] = edge ? 220 : 150;
    }
  }
  ctx.putImageData(img, 0, 0);
  const km2 = (cells * CELL * CELL) / 1e6;
  $("area").innerHTML = `Площадь: <b>${km2 < 10 ? km2.toFixed(1) : Math.round(km2).toLocaleString("ru")} км²</b>`;

  // легенда
  $("legend").innerHTML = cols.map((c) => `<i style="background:rgb(${c})"></i>`).join("");
  $("legendEnd").textContent = `${minutes} мин (деления по ${step} мин)`;

  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    map.getSource("reach").updateImage({ url, coordinates: reach.corners });
    if (lastBlob) setTimeout(() => URL.revokeObjectURL(lastBlob), 2000);
    lastBlob = url;
  });
  syncUrl();
  if (import.meta.env.DEV) console.log(`update ${Math.round(performance.now() - t0)} мс, ${cells} ячеек`);
}

function syncUrl() {
  const p = new URLSearchParams();
  p.set("o", `${state.lat.toFixed(5)},${state.lon.toFixed(5)}`);
  p.set("t", state.minutes);
  if (!state.transit) p.set("w", 1);
  if (state.groups.some((g) => !g)) p.set("m", state.groups.map((g) => (g ? 1 : 0)).join(""));
  if (state.pace !== 1) p.set("p", state.pace);
  try { history.replaceState(null, "", "?" + p); } catch {}
}

function setOrigin(lon, lat) {
  if (!reach.inside(lon, lat)) return;
  quality = 2;
  state.lon = lon; state.lat = lat;
  pin.setLngLat([lon, lat]);
  changed(true);
}

// ---------- запуск ----------
map.on("load", async () => {
  $("busy").style.display = "block"; $("busy").textContent = "Загружаю сеть…";
  const net = await (await fetch(`${BASE}network.json`)).json();
  reach = new Reach(net);
  canvas = document.createElement("canvas");
  canvas.width = reach.W * 2; canvas.height = reach.H * 2;
  ctx = canvas.getContext("2d");

  const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  map.addSource("reach", {
    type: "image",
    url: "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
    coordinates: reach.corners,
  });
  map.addLayer({ id: "reach", type: "raster", source: "reach", paint: { "raster-opacity": 1, "raster-fade-duration": 0 } }, firstSymbol);

  const el = document.createElement("div"); el.className = "pin";
  pin = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([state.lon, state.lat]).addTo(map);
  pin.on("dragend", () => { const p = pin.getLngLat(); setOrigin(p.lng, p.lat); });
  map.on("click", (e) => setOrigin(e.lngLat.lng, e.lngLat.lat));
  map.getCanvas().style.cursor = "crosshair";

  $("busy").style.display = "none";
  update();
});
