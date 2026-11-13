// Собирает компактную транспортную сеть из сырых выгрузок Overpass.
// usage: node scripts/build-network.mjs <rawDir> <outFile>
import fs from 'node:fs';

const [rawDir, outFile] = process.argv.slice(2);
const BBOX = { minLon: 36.8, maxLon: 38.05, minLat: 55.1, maxLat: 56.05 };
const CLUSTER_M = 35;

// режимы: 0 метро, 1 МЦК, 2 МЦД/электрички, 3 трамвай, 4 троллейбус, 5 автобус
const MODE = {
  0: { v: 15, dwell: 22, headway: 270, detour: 1.08 },
  1: { v: 14, dwell: 30, headway: 330, detour: 1.05 },
  2: { v: 16, dwell: 40, headway: 900, detour: 1.05 },
  3: { v: 5.5, dwell: 15, headway: 600, detour: 1.2 },
  4: { v: 6, dwell: 15, headway: 720, detour: 1.25 },
  5: { v: 6, dwell: 15, headway: 600, detour: 1.25 },
};

const LAT0 = 55.75;
const MLAT = 111320;
const MLON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const dist = (a, b) => Math.hypot((a.lon - b.lon) * MLON, (a.lat - b.lat) * MLAT);

function parseInterval(s) {
  if (!s) return null;
  // «10» = минуты, «00:10:00» = ч:м:с
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 60;
  const m = s.match(/^(\d+):(\d+)(?::(\d+))?$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +(m[3] || 0);
  return null;
}

const hubs = []; // {lon, lat}
const hubGrid = new Map();
const nodeToHub = new Map();
const cellKey = (x, y) => x * 100003 + y;
function hubFor(id, lon, lat) {
  if (nodeToHub.has(id)) return nodeToHub.get(id);
  const cx = Math.floor((lon * MLON) / CLUSTER_M);
  const cy = Math.floor((lat * MLAT) / CLUSTER_M);
  const p = { lon, lat };
  let best = -1, bd = CLUSTER_M;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      const arr = hubGrid.get(cellKey(cx + dx, cy + dy));
      if (!arr) continue;
      for (const h of arr) {
        const d = dist(p, hubs[h]);
        if (d < bd) { bd = d; best = h; }
      }
    }
  if (best < 0) {
    best = hubs.length;
    hubs.push(p);
    const k = cellKey(cx, cy);
    if (!hubGrid.has(k)) hubGrid.set(k, []);
    hubGrid.get(k).push(best);
  }
  nodeToHub.set(id, best);
  return best;
}

const inBox = (n) => n.lon >= BBOX.minLon && n.lon <= BBOX.maxLon && n.lat >= BBOX.minLat && n.lat <= BBOX.maxLat;

const routes = [];
const seen = new Set();
const stats = {};

for (const file of ['subway', 'train', 'tram', 'trolley', 'bus']) {
  const d = JSON.parse(fs.readFileSync(`${rawDir}/${file}.json`, 'utf8'));
  const nodes = new Map();
  for (const e of d.elements) if (e.type === 'node') nodes.set(e.id, { lon: e.lon, lat: e.lat });
  for (const r of d.elements) {
    if (r.type !== 'relation') continue;
    const t = r.tags || {};
    let mode;
    if (file === 'subway') mode = 0;
    else if (file === 'train') mode = /Центральное Кольцо|МЦК/.test(t.name || '') || (t.network === 'Московский метрополитен' && !/МЦД/.test(t.name || '')) ? 1 : 2;
    else if (file === 'tram') mode = 3;
    else if (file === 'trolley') mode = 4;
    else mode = 5;

    const nm = r.members.filter((m) => m.type === 'node');
    const stops = nm.filter((m) => m.role.startsWith('stop'));
    const use = stops.length >= 2 ? stops : nm.filter((m) => m.role.startsWith('platform'));
    const seq = [];
    for (const m of use) {
      const n = nodes.get(m.ref);
      if (!n || !inBox(n)) continue;
      const h = hubFor(m.ref, n.lon, n.lat);
      if (seq[seq.length - 1] !== h) seq.push(h);
    }
    if (seq.length < 2) continue;
    const key = mode + ':' + seq.join(',');
    if (seen.has(key)) continue;
    seen.add(key);

    const M = MODE[mode];
    const times = [];
    for (let i = 0; i + 1 < seq.length; i++) {
      const dd = dist(hubs[seq[i]], hubs[seq[i + 1]]) * M.detour;
      times.push(Math.max(20, Math.round(dd / M.v + M.dwell)));
    }
    const iv = parseInterval(t.interval) ?? parseInterval(t['interval:conditional']?.split(' @')[0]);
    const headway = iv && iv >= 60 && iv <= 3600 ? iv : M.headway;
    routes.push({ m: mode, h: headway, s: seq, t: times, n: (t.ref || t.name || '').slice(0, 12) });
    stats[mode] = (stats[mode] || 0) + 1;
  }
}

// выкинуть хабы, не использованные ни одним маршрутом, и пересобрать индексы
const used = new Set();
for (const r of routes) for (const h of r.s) used.add(h);
const remap = new Map();
const outHubs = [];
for (const h of used) { remap.set(h, outHubs.length / 2); outHubs.push(Math.round(hubs[h].lon * 1e5), Math.round(hubs[h].lat * 1e5)); }
for (const r of routes) r.s = r.s.map((h) => remap.get(h));

const out = { bbox: BBOX, hubs: outHubs, routes };
fs.writeFileSync(outFile, JSON.stringify(out));
console.log('hubs', outHubs.length / 2, 'routes', routes.length, 'by mode', stats, 'bytes', fs.statSync(outFile).size);
