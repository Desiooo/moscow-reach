// Районы Москвы: границы (GeoJSON) и статистика по каждому.
// usage: node scripts/build-districts.mjs <publicDir> <rawDir> <outFile>
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Reach, parseStreets, CELL } from '../engine.js';

const [dir, raw, outFile] = process.argv.slice(2);
const WALK = 5000 / 3600;
const CENTER = [37.6208, 55.7539];

const un = (f) => { const b = zlib.gunzipSync(fs.readFileSync(`${dir}/${f}`)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const net = JSON.parse(fs.readFileSync(`${dir}/network.json`, 'utf8'));
const metro = JSON.parse(fs.readFileSync(`${dir}/metro.json`, 'utf8'));
const access = JSON.parse(fs.readFileSync(`${dir}/access.json`, 'utf8'));
const reach = new Reach(net, parseStreets(un('streets.bin.gz')), new Uint8Array(un('barrier.bin.gz')), un('cover.bin.gz'), un('moscow.bin.gz'), un('mkad.bin.gz'));
const { W, H } = reach;
const stationsAll = metro.features.filter((f) => f.properties.kind === 'station');
const metroSt = stationsAll.filter((f) => f.properties.metro === true);
reach.setStations(metroSt.map((f) => f.geometry.coordinates));

// ---- население (people на ячейку 120 м) → на ячейку 30 м
const rawPop = (() => { const b = zlib.gunzipSync(fs.readFileSync(`${raw}/pop-ghsl.bin.gz`)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })();
const ph = new Int32Array(rawPop.slice(0, 12)), PW = ph[0], PH = ph[1], PR = ph[2];
let popArr = new Float32Array(rawPop.slice(12)); // сначала — модель GHSL; ниже подменяется калиброванной
const popAt = (x, y) => popArr[Math.floor(y / PR) * PW + Math.floor(x / PR)] / (PR * PR);

// ---- районы и округа
const rels = JSON.parse(fs.readFileSync(`${raw}/districts.json`, 'utf8')).elements;
const okrugRels = JSON.parse(fs.readFileSync(`${raw}/okrugs.json`, 'utf8')).elements;
const OK = { 'Центральный': 'ЦАО', 'Северный': 'САО', 'Северо-Восточный': 'СВАО', 'Восточный': 'ВАО', 'Юго-Восточный': 'ЮВАО', 'Южный': 'ЮАО', 'Юго-Западный': 'ЮЗАО', 'Западный': 'ЗАО', 'Северо-Западный': 'СЗАО', 'Зеленоградский': 'ЗелАО', 'Новомосковский': 'НАО', 'Троицкий': 'ТАО' };
const okrugOf = new Map();
for (const o of okrugRels) {
  const short = OK[(o.tags.name || '').replace(' административный округ', '')] || o.tags.name;
  for (const m of o.members) if (m.type === 'relation') okrugOf.set(m.ref, short);
}
const ZEL = ['Матушкино', 'Савёлки', 'Старое Крюково', 'Силино', 'Крюково'];

const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
function rings(rel) {
  const ways = rel.members.filter((m) => m.type === 'way' && m.geometry).map((m) => m.geometry.map((q) => [q.lon, q.lat]));
  const out = [];
  while (ways.length) {
    let ring = ways.pop(), grew = true;
    while (grew && !same(ring[0], ring[ring.length - 1])) {
      grew = false;
      for (let i = 0; i < ways.length; i++) {
        const w = ways[i], e = ring[ring.length - 1];
        if (same(w[0], e)) { ring = ring.concat(w.slice(1)); ways.splice(i, 1); grew = true; break; }
        if (same(w[w.length - 1], e)) { ring = ring.concat(w.slice(0, -1).reverse()); ways.splice(i, 1); grew = true; break; }
      }
    }
    if (ring.length > 3 && same(ring[0], ring[ring.length - 1])) out.push(ring);
  }
  return out;
}
const TOL = 5 / 111000;
function dp(pts, lo, hi, keep) {
  let md = 0, mi = -1; const [ax, ay] = pts[lo], [bx, by] = pts[hi], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
  for (let i = lo + 1; i < hi; i++) { const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L; if (d > md) { md = d; mi = i; } }
  if (md > TOL && mi > 0) { keep[mi] = 1; dp(pts, lo, mi, keep); dp(pts, mi, hi, keep); }
}
const simp = (r) => { const keep = new Uint8Array(r.length), mid = r.length >> 1; keep[0] = keep[mid] = keep[r.length - 1] = 1; dp(r, 0, mid, keep); dp(r, mid, r.length - 1, keep); const o = r.filter((_, i) => keep[i]).map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]); return o.length >= 4 ? o : null; };

const districts = [];
for (const rel of rels) {
  const rs = rings(rel); if (!rs.length) continue;
  const cellRings = rs.map((r) => r.map(([lo, la]) => reach.lonLatToCell(lo, la)));
  let area = 0; for (const r of cellRings) { let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; area += Math.abs(a) / 2; }
  const full = rel.tags.name || '?';
  districts.push({ rel, rings: rs, cellRings, polyArea: area, full, name: full.replace(/^район /, '').replace(/ район$/, '') });
}
districts.sort((a, b) => b.polyArea - a.polyArea); // крупные первыми, мелкие рисуются поверх (анклавы)
districts.forEach((d, i) => { d.id = i + 1; d.okrug = okrugOf.get(d.rel.id) || (ZEL.includes(d.name) ? 'ЗелАО' : '—'); });

// ---- растр районов (метки), чётно-нечётная заливка
const label = new Uint8Array(W * H);
for (const d of districts) {
  let ymin = Infinity, ymax = -Infinity;
  for (const r of d.cellRings) for (const q of r) { ymin = Math.min(ymin, q[1]); ymax = Math.max(ymax, q[1]); }
  for (let y = Math.max(0, Math.floor(ymin)); y <= Math.min(H - 1, Math.floor(ymax)); y++) {
    const yc = y + 0.5, xs = [];
    for (const r of d.cellRings) for (let i = 0; i < r.length - 1; i++) { const a = r[i], b = r[i + 1]; if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0])); }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.max(0, Math.ceil(xs[i] - 0.5)); x <= Math.min(W - 1, Math.floor(xs[i + 1] - 0.5)); x++) label[y * W + x] = d.id;
  }
}
const N = districts.length;
// ---- калибровка населения по официальным данным (Википедия, Росстат, 2025): сумма по району = официальная,
// распределение внутри района — по модели GHSL; где модель сильно промахнулась, подмешиваем длину улиц как признак застройки
{
  const normName = (t) => t.replace(/ё/g, 'е').replace(/^район /, '').replace(/ район$/, '').trim().toLowerCase();
  const wiki = new Map(fs.readFileSync(new URL('../data/wiki-districts-2025.tsv', import.meta.url), 'utf8').trim().split('\n').map((l) => { const [n, p2, a] = l.split('|'); return [normName(n), { pop: +p2, area: +a }]; }));
  for (const d of districts) d.wiki = wiki.get(normName(d.name)) || null;
  const sLen = new Float32Array(W * H);
  for (let k = 0; k < reach.eu.length; k++) {
    const u = reach.eu[k], v = reach.ev[k], mx = (reach.gx[u] + reach.gx[v]) / 2, my = (reach.gy[u] + reach.gy[v]) / 2;
    const x = Math.floor(mx), y = Math.floor(my); if (x >= 0 && y >= 0 && x < W && y < H) sLen[y * W + x] += Math.hypot(reach.gx[u] - reach.gx[v], reach.gy[u] - reach.gy[v]) * CELL;
  }
  const G = new Float64Array(N + 1), S = new Float64Array(N + 1), C = new Float64Array(N + 1);
  for (let i = 0; i < W * H; i++) { const l = label[i]; if (!l) continue; G[l] += popAt(i % W, (i / W) | 0); S[l] += sLen[i]; C[l]++; }
  const alpha = new Float64Array(N + 1), target = new Float64Array(N + 1);
  const factors = [];
  for (const d of districts) {
    const id = d.id; d.popRaw = G[id];
    if (!d.wiki) { target[id] = G[id]; alpha[id] = 1; continue; }
    target[id] = d.wiki.pop;
    const f = G[id] > 0 ? d.wiki.pop / G[id] : Infinity; factors.push([d.name, f, G[id], d.wiki.pop]);
    alpha[id] = G[id] < 1000 ? 0 : f >= 0.5 && f <= 2 ? 1 : 0.5;
    if (S[id] === 0) alpha[id] = 1;
  }
  const popNew = new Float32Array(popArr.length);
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0, l = label[i], ci = Math.floor(y / PR) * PW + Math.floor(x / PR);
    const g = popAt(x, y);
    if (!l) { popNew[ci] += g; continue; }
    const a = alpha[l], wg = G[l] > 0 ? g / G[l] : 0, ws = S[l] > 0 ? sLen[i] / S[l] : 1 / C[l];
    popNew[ci] += target[l] * (a * wg + (1 - a) * ws);
  }
  popArr = popNew;
  factors.sort((a, b) => a[1] - b[1]);
  console.log('калибровка: сумма было', Math.round(G.reduce((a, b) => a + b, 0)), 'стало', Math.round(target.reduce((a, b) => a + b, 0)));
  console.log('самые большие поправки:', factors.slice(0, 3).map((x) => `${x[0]} ×${x[1].toFixed(2)}`).join(', '), '...', factors.slice(-3).map((x) => `${x[0]} ×${x[1].toFixed(2)}`).join(', '));
  fs.writeFileSync(`${dir}/pop.bin.gz`, zlib.gzipSync(Buffer.concat([Buffer.from(Int32Array.from([PW, PH, PR]).buffer), Buffer.from(popArr.buffer)]), { level: 9 }));
}
const popRawById = {}; for (const d of districts) popRawById[d.id] = d.popRaw;
const cellKm2 = (CELL * CELL) / 1e6;
const SP = access.sp, nT = 12;

// ---- поля, общие для обоих проходов; копируем: растр движка переиспользует один буфер
const ALL = [true, true, true, true, true, true];
reach.run(CENTER[0], CENTER[1], { walkMs: WALK, modes: ALL, maxSec: 9000 }, 2);
const bestC = Float32Array.from(reach.raster(9000, 2));
reach.runSeeds(reach.stationSeeds(WALK), { walkMs: WALK, maxSec: 3600 }, 1);
const mwC = Float32Array.from(reach.raster(3600, 1));
reach.runSeeds(reach.hubSeeds(WALK), { walkMs: WALK, maxSec: 1800 }, 1);
const swC = Float32Array.from(reach.raster(1800, 1));
console.log('поля посчитаны');

const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
const BINS = 151;

/** Вся статистика районов по метке label (Uint8: id района или 0). accOff — смещение значений охвата в строке access.json. */
function aggregate(label, accOff) {
  const cnt = new Float64Array(N + 1), sx = new Float64Array(N + 1), sy = new Float64Array(N + 1), barr = new Float64Array(N + 1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const l = label[y * W + x]; if (!l) continue; cnt[l]++; sx[l] += x; sy[l] += y; if (reach.barrier[y * W + x]) barr[l]++; }
  // улицы, остановки, станции
  const streetM = new Float64Array(N + 1);
  for (let k = 0; k < reach.eu.length; k++) {
    const u = reach.eu[k], v = reach.ev[k], mx = (reach.gx[u] + reach.gx[v]) / 2, my = (reach.gy[u] + reach.gy[v]) / 2;
    const l = label[Math.floor(my) * W + Math.floor(mx)]; if (l) streetM[l] += Math.hypot(reach.gx[u] - reach.gx[v], reach.gy[u] - reach.gy[v]) * CELL;
  }
  const hubs = new Float64Array(N + 1);
  for (let h = 0; h < reach.nh; h++) { const l = label[Math.floor(reach.hy[h]) * W + Math.floor(reach.hx[h])]; if (l) hubs[l]++; }
  const stMetro = new Float64Array(N + 1), stMcd = new Float64Array(N + 1);
  for (const f of stationsAll) { const [cx, cy] = reach.lonLatToCell(...f.geometry.coordinates); const l = label[Math.floor(cy) * W + Math.floor(cx)]; if (l) (f.properties.metro ? stMetro : stMcd)[l]++; }
  // доступность: среднее по стартовым точкам внутри района
  const accSum = Array.from({ length: N + 1 }, () => new Float64Array(nT)), accN = new Float64Array(N + 1), fallback = new Uint8Array(N + 1);
  for (const p of access.pts) {
    const cx = (p[0] + 0.5) * SP, cy = (p[1] + 0.5) * SP, l = label[Math.floor(cy) * W + Math.floor(cx)]; if (!l) continue;
    accN[l]++; for (let k = 0; k < nT; k++) accSum[l][k] += p[accOff + k];
  }
  for (const d of districts) if (cnt[d.id] && accN[d.id] === 0) { // крошечный район без стартовых точек — ближайшая
    const cx = sx[d.id] / cnt[d.id], cy = sy[d.id] / cnt[d.id]; let best = null, bd = 1e18;
    for (const p of access.pts) { const dd = ((p[0] + 0.5) * SP - cx) ** 2 + ((p[1] + 0.5) * SP - cy) ** 2; if (dd < bd) { bd = dd; best = p; } }
    accN[d.id] = 1; for (let k = 0; k < nT; k++) accSum[d.id][k] = best[accOff + k]; fallback[d.id] = 1;
  }
  // время до центра
  const hist = Array.from({ length: N + 1 }, () => new Float64Array(BINS + 1));
  for (let i = 0; i < W * H; i++) { const l = label[i]; if (!l) continue; const t = bestC[i]; hist[l][t === Infinity ? BINS : Math.min(BINS, Math.floor(t / 60))]++; }
  // пешком до метро и до остановок, с весами по населению
  const metroWalk = { mean: new Float64Array(N + 1), w10: new Float64Array(N + 1), w15: new Float64Array(N + 1) };
  const popD = new Float64Array(N + 1), popM10 = new Float64Array(N + 1), popM15 = new Float64Array(N + 1), popS5 = new Float64Array(N + 1);
  const stopWalk = { mean: new Float64Array(N + 1), w5: new Float64Array(N + 1) };
  for (let i = 0; i < W * H; i++) {
    const l = label[i]; if (!l) continue; const x = i % W, y = (i / W) | 0, pp = popAt(x, y), t = mwC[i], u = swC[i];
    metroWalk.mean[l] += Math.min(1800, t === Infinity ? 1800 : t); if (t <= 600) metroWalk.w10[l]++; if (t <= 900) metroWalk.w15[l]++;
    popD[l] += pp; if (t <= 600) popM10[l] += pp; if (t <= 900) popM15[l] += pp;
    stopWalk.mean[l] += Math.min(1200, u === Infinity ? 1200 : u); if (u <= 300) { stopWalk.w5[l]++; popS5[l] += pp; }
  }
  const out = new Map();
  for (const d of districts) {
    const id = d.id, n = cnt[id]; if (!n) continue;
    const km2 = n * cellKm2, h = hist[id], pct = (f) => { let c = 0; for (let m = 0; m < BINS; m++) { c += h[m]; if (c >= f * n) return m + 0.5; } return null; };
    let sum = 0, reached = 0; for (let m = 0; m < BINS; m++) { sum += (m + 0.5) * h[m]; reached += h[m]; }
    const bands = []; for (let b = 0; b < 10; b++) { let c = 0; for (let m = b * 15; m < (b + 1) * 15; m++) c += h[m]; bands.push(r2(c / n)); } bands.push(r2(Math.max(0, 1 - bands.reduce((a, c) => a + c, 0))));
    const cx = sx[id] / n, cy = sy[id] / n, [clon, clat] = reach.cornersFor(cx, cy, cx, cy)[0];
    out.set(id, {
      c: [Math.round(clon * 1e4) / 1e4, Math.round(clat * 1e4) / 1e4],
      area: r1(km2), water: r2(barr[id] / n),
      popModel: Math.round(popRawById[id] || 0), pop: Math.round(popD[id]), dens: Math.round(popD[id] / km2), popM10: popD[id] ? r2(popM10[id] / popD[id]) : null, popM15: popD[id] ? r2(popM15[id] / popD[id]) : null, popS5: popD[id] ? r2(popS5[id] / popD[id]) : null,
      metro: stMetro[id], mcd: stMcd[id], stops: hubs[id], streetKm: r1(streetM[id] / 1000),
      acc: Array.from(accSum[id], (v) => Math.round(v / accN[id])), accN: accN[id], accFallback: fallback[id] ? 1 : 0,
      toCenter: { mean: reached ? r1(sum / reached) : null, p50: pct(0.5), p90: pct(0.9), reached: r2(reached / n), bands },
      metroWalk: { mean: r1(metroWalk.mean[id] / n / 60), w10: r2(metroWalk.w10[id] / n), w15: r2(metroWalk.w15[id] / n) },
      stopWalk: { mean: r1(stopWalk.mean[id] / n / 60), w5: r2(stopWalk.w5[id] / n) },
    });
  }
  return out;
}

// проход 1: весь район (охват — строка access.json: [ix,iy,mos,mk, A×12, K×12]); проход 2: только внутри МКАД
const labelK = new Uint8Array(W * H); for (let i = 0; i < label.length; i++) if (reach.mk[i]) labelK[i] = label[i];
const full = aggregate(label, 4), clipped = aggregate(labelK, 16);
console.log('районов', N, 'внутри МКАД есть у', clipped.size);

const features = [];
for (const d of districts) {
  const f = full.get(d.id); if (!f) continue;
  const polys = d.rings.map(simp).filter(Boolean); if (!polys.length) continue;
  const k = clipped.get(d.id) || null;
  features.push({
    type: 'Feature',
    properties: { id: d.id, name: d.name, full: d.full, okrug: d.okrug, ...f, hasK: k ? 1 : 0, k },
    geometry: { type: 'MultiPolygon', coordinates: polys.map((r) => [r]) },
  });
}
fs.writeFileSync(outFile, JSON.stringify({ type: 'FeatureCollection', features }));
console.log('районов в файле', features.length, 'байт', fs.statSync(outFile).size, 'без округа', features.filter((f) => f.properties.okrug === '—').length);
const f0 = features.find((f) => f.properties.name === 'Тверской') || features[0];
console.log(f0.properties.name, JSON.stringify({ pop: f0.properties.pop, popK: f0.properties.k?.pop, areaK: f0.properties.k?.area }));
const sol = features.find((f) => f.properties.name === 'Солнцево'); if (sol) console.log('Солнцево', sol.properties.area, '→', sol.properties.k?.area, 'жителей', sol.properties.pop, '→', sol.properties.k?.pop);
console.log('жителей внутри МКАД', features.reduce((a, f) => a + (f.properties.k?.pop || 0), 0), 'всего', features.reduce((a, f) => a + f.properties.pop, 0));
