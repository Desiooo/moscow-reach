// Строит пешеходный граф улиц и маску препятствий (вода, железная дорога) из moscow.pmtiles.
// usage: node scripts/build-streets.mjs <moscow.pmtiles> <outDir>
import fs from 'node:fs';
import zlib from 'node:zlib';
import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader as Pbf } from 'pbf';

const [file, outDir] = process.argv.slice(2);
const BBOX = { minLon: 36.8, maxLon: 38.05, minLat: 55.1, maxLat: 56.05 }; // как в build-network.mjs
const Z = 15, EXT = 4096, WORLD = 2 ** Z * EXT;
const R = 6378137, LAT0 = 55.75, CELL = 30; // та же сетка, что в engine.js
const rad = Math.PI / 180;

const fh = fs.openSync(file, 'r');
const p = new PMTiles({ getKey: () => file, getBytes: async (off, len) => { const b = Buffer.alloc(len); fs.readSync(fh, b, 0, len, off); return { data: b.buffer.slice(b.byteOffset, b.byteOffset + len) }; } });

const tileX = (lon) => Math.floor(((lon + 180) / 360) * 2 ** Z);
const tileY = (lat) => Math.floor(((1 - Math.log(Math.tan(lat * rad) + 1 / Math.cos(lat * rad)) / Math.PI) / 2) * 2 ** Z);
const x0 = tileX(BBOX.minLon), x1 = tileX(BBOX.maxLon), y0 = tileY(BBOX.maxLat), y1 = tileY(BBOX.minLat);
console.log('tiles', x1 - x0 + 1, 'x', y1 - y0 + 1);

// ---- сетка растра (как в engine.js)
const mercX = (lon) => R * lon * rad, mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (lat * rad) / 2));
const CS = CELL / Math.cos(LAT0 * rad);
const mx0 = mercX(BBOX.minLon), my0 = mercY(BBOX.minLat);
const GW = Math.ceil((mercX(BBOX.maxLon) - mx0) / CS), GH = Math.ceil((mercY(BBOX.maxLat) - my0) / CS);
const mask = new Uint8Array(GW * GH); // 1 = препятствие
// глобальные единицы z15 → ячейки сетки
const gridX = (gx) => ((gx / WORLD) * 2 * Math.PI * R - Math.PI * R - mx0) / CS;
const gridY = (gy) => (Math.PI * R - (gy / WORLD) * 2 * Math.PI * R - my0) / CS;
const unLon = (gx) => (gx / WORLD) * 360 - 180;
const unLat = (gy) => { const n = Math.PI * (1 - (2 * gy) / WORLD); return (Math.atan(Math.sinh(n)) * 180) / Math.PI; };

// ---- клип отрезка по [0,EXT]²
function clipSeg(ax, ay, bx, by) {
  let t0 = 0, t1 = 1; const dx = bx - ax, dy = by - ay;
  for (const [pp, q] of [[-dx, ax], [dx, EXT - ax], [-dy, ay], [dy, EXT - ay]]) {
    if (pp === 0) { if (q < 0) return null; continue; }
    const r = q / pp;
    if (pp < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [Math.round(ax + t0 * dx), Math.round(ay + t0 * dy), Math.round(ax + t1 * dx), Math.round(ay + t1 * dy)];
}

// ---- граф
const nodeId = new Map(); const nx = [], ny = []; // глобальные целые координаты
const key = (gx, gy) => gx * 134217728 + gy;
function node(gx, gy) { const k = key(gx, gy); let id = nodeId.get(k); if (id === undefined) { id = nx.length; nodeId.set(k, id); nx.push(gx); ny.push(gy); } return id; }
const edges = []; // пары [a,b]
const boundary = new Map(); // «линия границы» → [{pos, id}] для склейки соседних тайлов

const WALK_NOT = new Set(['highway', 'rail', 'ferry']);
function walkable(props) {
  const k = props.kind, d = props.kind_detail || '';
  if (WALK_NOT.has(k)) return false;
  if (k === 'path') return true;
  if (props.is_tunnel || /tunnel/.test(d)) return false; // автомобильные туннели; пешеходные — только path
  if ((k === 'major_road' || k === 'medium_road') && /_link$/.test(d)) return false;
  return true;
}

function fillPolygon(rings, tx, ty) { // чётно-нечётная заливка в маску
  const pts = rings.map((r) => r.map((q) => [gridX(tx * EXT + q.x), gridY(ty * EXT + q.y)]));
  let ymin = Infinity, ymax = -Infinity;
  for (const r of pts) for (const q of r) { ymin = Math.min(ymin, q[1]); ymax = Math.max(ymax, q[1]); }
  for (let y = Math.max(0, Math.floor(ymin)); y <= Math.min(GH - 1, Math.floor(ymax)); y++) {
    const yc = y + 0.5, xs = [];
    for (const r of pts) for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.max(0, Math.ceil(xs[i] - 0.5)); x <= Math.min(GW - 1, Math.floor(xs[i + 1] - 0.5)); x++) mask[y * GW + x] = 1;
  }
}
function drawLine(rings, tx, ty) {
  for (const r of rings) for (let i = 0; i + 1 < r.length; i++) {
    const ax = gridX(tx * EXT + r[i].x), ay = gridY(ty * EXT + r[i].y), bx = gridX(tx * EXT + r[i + 1].x), by = gridY(ty * EXT + r[i + 1].y);
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 3));
    for (let s = 0; s <= n; s++) {
      const x = Math.floor(ax + ((bx - ax) * s) / n), y = Math.floor(ay + ((by - ay) * s) / n);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < GW && yy < GH) mask[yy * GW + xx] = 1; }
    }
  }
}

// ---- граница Москвы (relation 102269) → грубая маска с отступом, чтобы не тянуть область
const MARGIN_M = Number(process.env.MARGIN_M || 2500), CC = 150; // ячейка грубой маски, м
const cw = Math.ceil((GW * CELL) / CC), ch = Math.ceil((GH * CELL) / CC), city = new Uint8Array(cw * ch);
{
  const rel = JSON.parse(fs.readFileSync(process.env.BOUNDARY || 'raw/boundary.json', 'utf8')).elements[0];
  const ways = rel.members.filter((m) => m.type === 'way' && m.role === 'outer' && m.geometry).map((m) => m.geometry.map((q) => [q.lon, q.lat]));
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  const rings = [];
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
    rings.push(ring);
  }
  console.log('boundary rings', rings.length, rings.map((r) => r.length));
  // заливка (чётно-нечётная) в грубую сетку
  const pts = rings.map((r) => r.map(([lon, lat]) => [((mercX(lon) - mx0) / CS) * CELL / CC, ((mercY(lat) - my0) / CS) * CELL / CC]));
  for (let y = 0; y < ch; y++) {
    const yc = y + 0.5, xs = [];
    for (const r of pts) for (let i = 0; i < r.length - 1; i++) { const a = r[i], b = r[i + 1]; if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0])); }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.max(0, Math.ceil(xs[i] - 0.5)); x <= Math.min(cw - 1, Math.floor(xs[i + 1] - 0.5)); x++) city[y * cw + x] = 1;
  }
  // отступ: квадратный максимум-фильтр
  const rr = Math.round(MARGIN_M / CC), tmp = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { let v = 0; for (let k = Math.max(0, x - rr); k <= Math.min(cw - 1, x + rr) && !v; k++) v = city[y * cw + k]; tmp[y * cw + x] = v; }
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { let v = 0; for (let k = Math.max(0, y - rr); k <= Math.min(ch - 1, y + rr) && !v; k++) v = tmp[k * cw + x]; city[y * cw + x] = v; }
  let c = 0; for (const v of city) c += v; console.log('city cells', c, '≈ km²', ((c * CC * CC) / 1e6).toFixed(0));
}
const inCity = (gx, gy) => { const x = Math.floor((gridX(gx) * CELL) / CC), y = Math.floor((gridY(gy) * CELL) / CC); return x >= 0 && y >= 0 && x < cw && y < ch && city[y * cw + x] === 1; };

const waterKinds = {}; let kept = 0, total = 0, tilesDone = 0;
for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
  const t = await p.getZxy(Z, tx, ty); if (!t) continue;
  const vt = new VectorTile(new Pbf(t.data));
  tilesDone++;
  const roads = vt.layers.roads;
  if (roads) for (let i = 0; i < roads.length; i++) {
    const f = roads.feature(i); if (f.type !== 2) continue;
    const props = f.properties; total++;
    if (props.kind === 'rail' && !props.is_tunnel && !/subway|tunnel|tram|monorail|funicular/.test(props.kind_detail || '')) drawLine(f.loadGeometry(), tx, ty);
    if (!walkable(props)) continue;
    kept++;
    for (const line of f.loadGeometry()) {
      let prev = null;
      for (let j = 0; j + 1 < line.length; j++) {
        const c = clipSeg(line[j].x, line[j].y, line[j + 1].x, line[j + 1].y); if (!c) continue;
        const a = node(tx * EXT + c[0], ty * EXT + c[1]), b = node(tx * EXT + c[2], ty * EXT + c[3]);
        if (a !== b) edges.push(a, b);
        for (const [id, lx, ly] of [[a, c[0], c[1]], [b, c[2], c[3]]]) {
          for (const [axis, coord, pos] of [['x', lx, ly], ['y', ly, lx]]) {
            if (coord === 0 || coord === EXT) {
              const gline = axis + ':' + (axis === 'x' ? tx * EXT + coord : ty * EXT + coord);
              let arr = boundary.get(gline); if (!arr) boundary.set(gline, (arr = []));
              arr.push([axis === 'x' ? ty * EXT + pos : tx * EXT + pos, id]);
            }
          }
        }
      }
    }
  }
  const water = vt.layers.water;
  if (water) for (let i = 0; i < water.length; i++) {
    const f = water.feature(i); const k = f.properties.kind;
    waterKinds[k + '|' + f.type] = (waterKinds[k + '|' + f.type] || 0) + 1;
    if (f.type === 3 && /^(water|lake|river|reservoir|ocean|riverbank|bay|basin|canal|stream|pond|dock)$/.test(k || 'water')) fillPolygon(f.loadGeometry(), tx, ty);
  }
  if (tilesDone % 2000 === 0) console.log('tiles', tilesDone, 'nodes', nx.length, 'edges', edges.length / 2);
}
console.log('water kinds', waterKinds);
console.log('roads total', total, 'walkable', kept, 'nodes', nx.length, 'edges', edges.length / 2);

// ---- склейка узлов на границах тайлов (допуск 3 единицы ≈ 0.5 м)
const parent = Int32Array.from({ length: nx.length }, (_, i) => i);
const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
let merged = 0;
for (const arr of boundary.values()) {
  arr.sort((a, b) => a[0] - b[0]);
  for (let i = 0; i + 1 < arr.length; i++) if (arr[i + 1][0] - arr[i][0] <= 3) { const a = find(arr[i][1]), b = find(arr[i + 1][1]); if (a !== b) { parent[b] = a; merged++; } }
}
console.log('welded', merged);

// ---- список смежности по представителям
const idx = new Int32Array(nx.length).fill(-1); const rx = [], ry = [];
for (let i = 0; i < nx.length; i++) { const r = find(i); if (idx[r] < 0) { idx[r] = rx.length; rx.push(nx[r]); ry.push(ny[r]); } }
const inside = new Uint8Array(rx.length); for (let i = 0; i < rx.length; i++) inside[i] = inCity(rx[i], ry[i]) ? 1 : 0;
const adj = Array.from({ length: rx.length }, () => new Set());
for (let i = 0; i < edges.length; i += 2) { const a = idx[find(edges[i])], b = idx[find(edges[i + 1])]; if (a !== b && inside[a] && inside[b]) { adj[a].add(b); adj[b].add(a); } }

// ---- починка Т-образных стыков: тупики, лежащие у чужого отрезка (≤ 2.5 м), подключаем к нему
{
  const TJ = 2.5 / (((2 * Math.PI * R) / WORLD) * Math.cos(LAT0 * Math.PI / 180)), CSZ = 64;
  const grid = new Map(); const ckey = (cx, cy) => cx * 1000003 + cy;
  for (let a = 0; a < rx.length; a++) for (const b of adj[a]) if (a < b) {
    const cx0 = Math.floor(Math.min(rx[a], rx[b]) / CSZ), cx1 = Math.floor(Math.max(rx[a], rx[b]) / CSZ), cy0 = Math.floor(Math.min(ry[a], ry[b]) / CSZ), cy1 = Math.floor(Math.max(ry[a], ry[b]) / CSZ);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 400) continue;
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) { const k = ckey(cx, cy); let arr = grid.get(k); if (!arr) grid.set(k, (arr = [])); arr.push(a, b); }
  }
  let fixed = 0, dead = 0;
  for (let d = 0; d < rx.length; d++) {
    if (adj[d].size !== 1) continue; dead++;
    const cx = Math.floor(rx[d] / CSZ), cy = Math.floor(ry[d] / CSZ); let best = TJ, ba = -1, bb = -1;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const arr = grid.get(ckey(cx + dx, cy + dy)); if (!arr) continue;
      for (let i = 0; i < arr.length; i += 2) {
        const a = arr[i], b = arr[i + 1]; if (a === d || b === d || adj[d].has(a) || adj[d].has(b)) continue;
        const ex = rx[b] - rx[a], ey = ry[b] - ry[a], L2 = ex * ex + ey * ey || 1;
        let t = ((rx[d] - rx[a]) * ex + (ry[d] - ry[a]) * ey) / L2; t = Math.max(0, Math.min(1, t));
        const dist = Math.hypot(rx[a] + t * ex - rx[d], ry[a] + t * ey - ry[d]);
        if (dist < best) { best = dist; ba = a; bb = t > 0 && t < 1 ? b : -1; if (t <= 0) { bb = -1; } else if (t >= 1) { ba = b; bb = -1; } }
      }
    }
    if (ba >= 0) { adj[d].add(ba); adj[ba].add(d); if (bb >= 0) { adj[d].add(bb); adj[bb].add(d); } fixed++; }
  }
  console.log('dead ends', dead, 'reconnected', fixed);
}

// ---- упрощение: цепочки степени-2 по Дугласу–Пекеру (допуск ≈ 3 м)
const mPerUnit = ((2 * Math.PI * R) / WORLD) * Math.cos(LAT0 * rad);
const TOL = Number(process.env.DP_M || 4) / mPerUnit;
const keep = new Uint8Array(rx.length);
for (let i = 0; i < rx.length; i++) if (adj[i].size !== 2 && adj[i].size > 0) keep[i] = 1;
function dp(chain, lo, hi) {
  let md = 0, mi = -1; const ax = rx[chain[lo]], ay = ry[chain[lo]], bx = rx[chain[hi]], by = ry[chain[hi]];
  const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
  for (let i = lo + 1; i < hi; i++) { const d = Math.abs((rx[chain[i]] - ax) * dy - (ry[chain[i]] - ay) * dx) / L; if (d > md) { md = d; mi = i; } }
  if (md > TOL && mi > 0) { keep[chain[mi]] = 1; dp(chain, lo, mi); dp(chain, mi, hi); }
}
const visitedEdge = new Set(); const ek = (a, b) => (a < b ? a * 67108864 + b : b * 67108864 + a);
for (let s = 0; s < rx.length; s++) {
  if (!keep[s]) continue;
  for (const nb of adj[s]) {
    if (visitedEdge.has(ek(s, nb))) continue;
    const chain = [s]; let prev = s, cur = nb;
    visitedEdge.add(ek(prev, cur));
    while (!keep[cur]) { chain.push(cur); const nxt = [...adj[cur]].find((q) => q !== prev) ?? prev; prev = cur; cur = nxt; visitedEdge.add(ek(prev, cur)); if (chain.length > 100000) break; }
    chain.push(cur);
    if (chain.length > 2) dp(chain, 0, chain.length - 1);
  }
}
// циклы из одних степени-2 узлов (редкость) — оставим как есть, пометив каждый 5-й
for (let i = 0; i < rx.length; i++) if (!keep[i] && adj[i].size === 2 && i % 5 === 0 && ![...adj[i]].some((q) => keep[q])) keep[i] = 1;

// финальные рёбра между сохранёнными узлами
const fid = new Int32Array(rx.length).fill(-1); let N = 0;
for (let i = 0; i < rx.length; i++) if (keep[i]) fid[i] = N++;
const fadj = Array.from({ length: N }, () => new Set());
const seen = new Set();
for (let s = 0; s < rx.length; s++) {
  if (!keep[s]) continue;
  for (const nb of adj[s]) {
    let prev = s, cur = nb, guard = 0;
    while (!keep[cur] && guard++ < 100000) { const nxt = [...adj[cur]].find((q) => q !== prev); if (nxt === undefined) { cur = -1; break; } prev = cur; cur = nxt; }
    if (cur < 0 || fid[cur] < 0 || cur === s) continue;
    fadj[fid[s]].add(fid[cur]); fadj[fid[cur]].add(fid[s]);
  }
}
const lonI = new Int32Array(N), latI = new Int32Array(N);
for (let i = 0; i < rx.length; i++) if (keep[i]) { lonI[fid[i]] = Math.round((unLon(rx[i]) - 36) * 1e6); latI[fid[i]] = Math.round((unLat(ry[i]) - 55) * 1e6); }
const offs = new Uint32Array(N + 1); for (let i = 0; i < N; i++) offs[i + 1] = offs[i] + fadj[i].size;
const adjArr = new Uint32Array(offs[N]); for (let i = 0; i < N; i++) { let k = offs[i]; for (const q of fadj[i]) adjArr[k++] = q; }
console.log('final nodes', N, 'directed edges', adjArr.length);

// ---- связность: оставляем только наибольшую компоненту
const comp = new Int32Array(N).fill(-1); let best = 0, bestId = -1, cid = 0;
for (let s0 = 0; s0 < N; s0++) { if (comp[s0] >= 0) continue; let size = 0; const st = [s0]; comp[s0] = cid; while (st.length) { const u = st.pop(); size++; for (let e = offs[u]; e < offs[u + 1]; e++) { const v = adjArr[e]; if (comp[v] < 0) { comp[v] = cid; st.push(v); } } } if (size > best) { best = size; bestId = cid; } cid++; }
console.log('components', cid, 'largest', best, `(${((best / N) * 100).toFixed(1)}%)`);
const nid = new Int32Array(N).fill(-1); let M = 0; for (let i = 0; i < N; i++) if (comp[i] === bestId) nid[i] = M++;
const mLon = new Int32Array(M), mLat = new Int32Array(M), fdeg = new Uint8Array(M); const fwd = [];
for (let i = 0; i < N; i++) {
  if (nid[i] < 0) continue; const u = nid[i]; mLon[u] = lonI[i]; mLat[u] = latI[i];
  const nb = []; for (let e = offs[i]; e < offs[i + 1]; e++) { const v = nid[adjArr[e]]; if (v > u) nb.push(v); }
  nb.sort((a, b) => a - b); fdeg[u] = nb.length; for (const v of nb) fwd.push(v - u);
}
if (fdeg.some((d) => d > 255)) throw new Error('degree overflow');
console.log('kept nodes', M, 'undirected edges', fwd.length);

// ---- запись: разности (gzip хорошо сжимает мелкие числа)
const zz = (v) => (v << 1) ^ (v >> 31);
const dLon = new Int32Array(M), dLat = new Int32Array(M);
for (let i = 0; i < M; i++) { dLon[i] = zz(mLon[i] - (i ? mLon[i - 1] : 0)); dLat[i] = zz(mLat[i] - (i ? mLat[i - 1] : 0)); }
fs.mkdirSync(outDir, { recursive: true });
const header = Int32Array.from([0x53545232, M, fwd.length, GW, GH, CELL]);
const fwdArr = Int32Array.from(fwd);
// байтовые плоскости: сначала все младшие байты, потом следующие — так gzip работает лучше
const planes = (a) => { const o = Buffer.alloc(a.length * 4); for (let k = 0; k < 4; k++) for (let i = 0; i < a.length; i++) o[k * a.length + i] = (a[i] >>> (8 * k)) & 255; return o; };
const parts = [Buffer.from(header.buffer), planes(dLon), planes(dLat), Buffer.from(fdeg), planes(fwdArr)];
fs.writeFileSync(`${outDir}/streets.bin.gz`, zlib.gzipSync(Buffer.concat(parts), { level: 9 }));
const bits = new Uint8Array(Math.ceil((GW * GH) / 8)); for (let i = 0; i < mask.length; i++) if (mask[i]) bits[i >> 3] |= 1 << (i & 7);
fs.writeFileSync(`${outDir}/barrier.bin.gz`, zlib.gzipSync(Buffer.from(bits), { level: 9 }));
let blocked = 0; for (const v of mask) blocked += v;
console.log('grid', GW, 'x', GH, 'blocked cells', blocked, 'files', fs.statSync(`${outDir}/streets.bin.gz`).size, fs.statSync(`${outDir}/barrier.bin.gz`).size);
