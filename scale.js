// Палитры и шкала цвета, общие для тепловой карты и районов.
export const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export const PAL = ["#0b3c5d", "#1d6a8a", "#2fa4a0", "#8fd18a", "#f4e285"].map(hex);
// viridis: ярко-жёлтый → тёмно-фиолетовый
export const VIR = ["#fde725", "#b5de2b", "#6ece58", "#35b779", "#1f9e89", "#26828e", "#31688e", "#3e4989", "#482878", "#440154"].map(hex);

export function lerpPal(pal, x) { // x ∈ [0,1]
  const p = Math.max(0, Math.min(1, x)) * (pal.length - 1), a = Math.floor(p), b = Math.min(pal.length - 1, a + 1), f = p - a;
  return pal[a].map((v, k) => Math.round(v + (pal[b][k] - v) * f));
}
export const rgbHex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

export const fmtKm = (v) => (v < 10 ? v.toFixed(1).replace(".", ",") : Math.round(v).toLocaleString("ru"));

export const MEANS = [
  { id: "arith", name: "арифметическое", short: "арифм." },
  { id: "geo", name: "геометрическое", short: "геом." },
  { id: "quad", name: "квадратическое", short: "квадр." },
];

/**
 * Шкала без «среза» на краях: минимум → 0, выбранное среднее → 0.5, максимум → 1 (кусочно-линейно),
 * так что весь диапазон данных, от самого малого до самого большого значения, окрашен.
 * vals — все значения (для min/max), meanVals — по каким считать среднее (по умолчанию те же).
 */
export function makeScale(vals, kind, meanVals = vals) {
  let min = Infinity, max = -Infinity;
  for (const v of vals) { if (v < min) min = v; if (v > max) max = v; }
  let s = 0, sq = 0, sl = 0, n = 0, np = 0;
  for (const v of meanVals) { s += v; sq += v * v; n++; if (v > 0) { sl += Math.log(v); np++; } }
  const arith = n ? s / n : min, quad = n ? Math.sqrt(sq / n) : min, geo = np ? Math.exp(sl / np) : arith;
  const mid = { arith, geo, quad }[kind] ?? arith;
  const eps = (max - min) * 1e-3 || 1e-9;
  const m = Math.min(Math.max(mid, min + eps), max - eps);
  const f = (v) => (v <= m ? 0.5 * (v - min) / (m - min) : 0.5 + 0.5 * (v - m) / (max - m));
  return { min, max, mid: m, arith, geo, quad, f: (v) => Math.max(0, Math.min(1, f(v))) };
}
