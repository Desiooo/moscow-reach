// Вкладка «Население»: плотность населения по точкам (со сглаживанием по соседним ячейкам) и статистика по городу.
import { VIR, lerpPal, makeScale, MEANS } from "./scale.js";

const SIGMAS = [0, 1, 2, 4]; // в ячейках по 120 м
const SMOOTH_NAMES = ["без сглаживания", "слабое", "среднее", "сильное"];
const SMOOTH_HINT = ["исходные данные", "≈ 120 м", "≈ 240 м", "≈ 480 м"];
const CELL_KM2 = 0.12 * 0.12; // ячейка 120 × 120 м
const MIN_DENS = 50; // человек/км²: меньше — считаем «необитаемым» и не красим
const BANDS = [2000, 5000, 10000, 15000, 25000]; // границы плотности, чел/км²

const fmtPop = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1).replace(".", ",")} млн` : v >= 1e3 ? `${Math.round(v / 1e3)} тыс.` : `${Math.round(v)}`);
const fmtDens = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(".", ",")} тыс./км²` : `${Math.round(v)} /км²`);

function gauss(src, w, h, sigma) { // отделяемое гауссово сглаживание, сохраняет сумму (вне сетки — ноль)
  if (sigma <= 0) return src.slice();
  const r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1); let ks = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); ks += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) { const xx = x + i; if (xx >= 0 && xx < w) s += src[y * w + xx] * k[i + r]; } tmp[y * w + x] = s; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) { const yy = y + i; if (yy >= 0 && yy < h) s += tmp[yy * w + x] * k[i + r]; } out[y * w + x] = s; }
  return out;
}

export function createPopulation({ map, $, state, reach, pop, pushImage, heatCv, stationNear, getMean, getClip, onChange }) {
  const { w, h, r, a } = pop;
  let dens = null, key = -1, mosC = null, ready = false;

  // какие ячейки грубой сетки лежат в Москве
  const mos = new Uint8Array(w * h);
  for (let Y = 0; Y < h; Y++) for (let X = 0; X < w; X++) mos[Y * w + X] = reach.mos[Math.min(reach.H - 1, Y * r + 2) * reach.W + Math.min(reach.W - 1, X * r + 2)];
  mosC = mos;
  const mkC = new Uint8Array(w * h); // внутри МКАД
  for (let Y = 0; Y < h; Y++) for (let X = 0; X < w; X++) mkC[Y * w + X] = reach.mk[Math.min(reach.H - 1, Y * r + 2) * reach.W + Math.min(reach.W - 1, X * r + 2)];
  // вода: блок 4×4 исходных ячеек на половину и больше занят препятствиями (реки; единичные пути не считаем)
  const wat = new Uint8Array(w * h);
  for (let Y = 0; Y < h; Y++) for (let X = 0; X < w; X++) { let c = 0; for (let j = 0; j < r; j++) for (let i = 0; i < r; i++) { const x = X * r + i, y = Y * r + j; if (x < reach.W && y < reach.H) c += reach.barrier[y * reach.W + x]; } wat[Y * w + X] = c >= (r * r) / 2 ? 1 : 0; }

  const box = $("popSmooth");
  const btns = SIGMAS.map((_, i) => {
    const b = document.createElement("button"); b.className = "chip"; b.textContent = `${SMOOTH_NAMES[i]}`; b.title = SMOOTH_HINT[i];
    b.onclick = () => { state.ps = i; render(); onChange?.(); };
    box.appendChild(b); return b;
  });

  function compute() {
    if (key === state.ps && dens) return;
    const sm = gauss(a, w, h, SIGMAS[state.ps]);
    dens = new Float32Array(w * h); for (let i = 0; i < dens.length; i++) dens[i] = sm[i] / CELL_KM2;
    key = state.ps;
  }

  function densityAt(lon, lat) {
    if (!dens) return null;
    const [cx, cy] = reach.lonLatToCell(lon, lat), X = Math.floor(cx / r), Y = Math.floor(cy / r);
    if (X < 0 || Y < 0 || X >= w || Y >= h) return null;
    const v = dens[Y * w + X]; return v >= MIN_DENS ? v : null;
  }

  function render() {
    if (state.view !== "pop") return;
    btns.forEach((b, i) => b.setAttribute("aria-pressed", i === state.ps));
    compute();
    const vals = [], mosVals = [];
    const clip = getClip();
    for (let i = 0; i < dens.length; i++) if (dens[i] >= MIN_DENS && (!clip || mkC[i])) { vals.push(dens[i]); if (mos[i]) mosVals.push(dens[i]); }
    const sc = makeScale(vals, getMean(), mosVals.length ? mosVals : vals);
    // картинка: одна ячейка — один пиксель (реки не закрашиваем)
    heatCv.canvas.width = w; heatCv.canvas.height = h;
    const img = heatCv.ctx.createImageData(w, h), d = img.data;
    for (let Y = 0; Y < h; Y++) {
      const row = (h - 1 - Y) * w;
      for (let X = 0; X < w; X++) {
        const v = dens[Y * w + X]; if (v < MIN_DENS) continue;
        if (wat[Y * w + X] || (clip && !mkC[Y * w + X])) continue;
        const c = lerpPal(VIR, 1 - sc.f(v)), o = (row + X) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 178;
      }
    }
    heatCv.ctx.putImageData(img, 0, 0);
    pushImage(heatCv, "heat", reach.corners);
    // легенда
    $("pLegend").style.background = `linear-gradient(90deg, ${[1, 0.75, 0.5, 0.25, 0].map((x) => `rgb(${lerpPal(VIR, x)})`).join(",")})`;
    $("pLo").textContent = fmtDens(sc.min); $("pMid").textContent = `${MEANS.find((m) => m.id === getMean()).short} ${fmtDens(sc.mid)}`; $("pHi").textContent = fmtDens(sc.max);
    $("scaleInfo").textContent = `Среднее по Москве: арифм. ${fmtDens(sc.arith)} · геом. ${fmtDens(sc.geo)} · квадр. ${fmtDens(sc.quad)}`;
    stats();
  }

  function stats() {
    // итоги по Москве
    let total = 0, cells = 0, peak = 0, peakI = -1;
    const order = [];
    const clip = getClip();
    for (let i = 0; i < a.length; i++) if (mos[i] && (!clip || mkC[i])) { cells++; total += a[i]; if (a[i] > 0) order.push(i); if (dens[i] > peak) { peak = dens[i]; peakI = i; } }
    const area = cells * CELL_KM2;
    $("pTotal").textContent = fmtPop(total);
    $("pAvg").textContent = fmtDens(total / area);
    // доля территории, где живёт половина москвичей
    order.sort((x, y) => dens[y] - dens[x]);
    let acc = 0, n = 0; for (const i of order) { acc += a[i]; n++; if (acc >= total / 2) break; }
    $("pHalf").textContent = `${Math.round(((n * CELL_KM2) / area) * 100)}%`;
    $("pPeak").textContent = fmtDens(peak);
    // распределение жителей по плотности
    const share = new Float64Array(BANDS.length + 1);
    for (let i = 0; i < a.length; i++) if (mos[i] && (!clip || mkC[i]) && a[i] > 0) { let b = 0; while (b < BANDS.length && dens[i] >= BANDS[b]) b++; share[b] += a[i]; }
    const labels = ["< 2", "2–5", "5–10", "10–15", "15–25", "> 25"], W = 320, H = 130, L = 8, T = 16, B = 26, pw = W - 2 * L, ph = H - T - B, bw = pw / share.length, mx = Math.max(...share);
    let s = "";
    share.forEach((v, k) => {
      const hgt = (v / mx) * ph, x = L + k * bw, mid = k === 0 ? 1000 : k === BANDS.length ? 30000 : (BANDS[k - 1] + BANDS[k]) / 2;
      const c = lerpPal(VIR, 1 - Math.min(1, mid / 30000) ** 0.6 * 0.95);
      s += `<rect x="${x + 2}" y="${T + ph - hgt}" width="${bw - 4}" height="${hgt}" rx="2" fill="rgb(${c})"/><text x="${x + bw / 2}" y="${T + ph - hgt - 3}" text-anchor="middle">${Math.round((v / total) * 100)}%</text><text x="${x + bw / 2}" y="${H - 12}" text-anchor="middle">${labels[k]}</text>`;
    });
    s += `<text x="${W / 2}" y="${H - 1}" text-anchor="middle">плотность, тыс. человек на км²</text>`;
    $("chartPop").innerHTML = s;
    // самые плотные места (без повторов ближе 1,5 км)
    const picked = [], cand = order.slice(0, 4000);
    for (const i of cand) {
      const X = i % w, Y = (i / w) | 0;
      if (picked.some((p) => Math.hypot(p.X - X, p.Y - Y) < 12.5)) continue;
      picked.push({ X, Y, v: dens[i] }); if (picked.length === 5) break;
    }
    const ul = $("popPeaks"); ul.innerHTML = "";
    picked.forEach((p, k) => {
      const cx = (p.X + 0.5) * r, cy = (p.Y + 0.5) * r, [lon, lat] = reach.cornersFor(cx, cy, cx, cy)[0], st = stationNear(lon, lat);
      const li = document.createElement("li");
      li.innerHTML = `<span class="n">${k + 1}</span><span class="nm">${st ? `у ст. ${st.name}` : `${lat.toFixed(3)}, ${lon.toFixed(3)}`}<small>${st ? (st.km < 1 ? Math.round(st.km * 1000) + " м" : st.km.toFixed(1).replace(".", ",") + " км") + " до станции" : ""}</small></span><span class="v">${fmtDens(p.v)}</span>`;
      li.onclick = () => map.flyTo({ center: [lon, lat], zoom: 12.5 });
      ul.appendChild(li);
    });
  }

  map.on("mousemove", (e) => {
    const tip = $("tip");
    if (state.view !== "pop") return;
    const [cx, cy] = reach.lonLatToCell(e.lngLat.lng, e.lngLat.lat);
    if (getClip() && !reach.mk[Math.floor(cy) * reach.W + Math.floor(cx)]) { tip.style.display = "none"; return; }
    const v = densityAt(e.lngLat.lng, e.lngLat.lat);
    if (v == null) { tip.style.display = "none"; return; }
    tip.textContent = `≈ ${fmtDens(v)} жителей`; tip.style.display = "block"; tip.style.left = `${e.point.x + 14}px`; tip.style.top = `${e.point.y + 14}px`;
  });

  return { render, densityAt };
}
