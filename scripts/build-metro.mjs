// raw/metro.json (Overpass) → public/metro.json (GeoJSON: линии с цветами и станции)
import fs from 'node:fs';
const [inFile, outFile] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const rels = d.elements.filter((e) => e.type === 'relation');
const nodes = new Map(d.elements.filter((e) => e.type === 'node').map((n) => [n.id, n]));
const r5 = (v) => Math.round(v * 1e5) / 1e5;

const kindOf = (r) => (r.tags.route === 'subway' ? (/Центральн|МЦК/.test(r.tags.name || '') || r.tags.ref === '14' ? 'mck' : 'metro') : 'mcd');
const lineName = (r) => (r.tags.name || '').split(':')[0].replace(/ \(.*\)$/, '').trim();
const rank = { mcd: 0, mck: 1, metro: 2 };

const features = [];
const seenWay = new Set();
const stations = new Map(); // имя → { pts: [[lon,lat]], colours:Set, kind }
for (const r of rels) {
  const kind = kindOf(r), colour = r.tags.colour || '#888', name = lineName(r), ref = r.tags.ref || '';
  const lines = [];
  for (const m of r.members) {
    if (m.type === 'way' && (m.role === '' || m.role === 'route') && m.geometry && !seenWay.has(m.ref)) {
      seenWay.add(m.ref);
      lines.push(m.geometry.map((p) => [r5(p.lon), r5(p.lat)]));
    }
    if (m.type === 'node' && m.role.startsWith('stop')) {
      const n = nodes.get(m.ref); if (!n?.tags?.name) continue;
      let s = stations.get(n.tags.name); if (!s) stations.set(n.tags.name, (s = { pts: [], colours: new Set(), kinds: new Set() }));
      s.pts.push([n.lon, n.lat]); s.colours.add(colour); s.kinds.add(kind);
    }
  }
  if (lines.length) features.push({ type: 'Feature', properties: { kind, colour, name, ref, rank: rank[kind] }, geometry: { type: 'MultiLineString', coordinates: lines } });
}
features.sort((a, b) => a.properties.rank - b.properties.rank);
// станции: одинаковые имена, далеко друг от друга (>1.5 км), считаем разными
let sc = 0;
for (const [name, s] of stations) {
  const clusters = [];
  for (const p of s.pts) {
    const c = clusters.find((c) => Math.hypot((c.x - p[0]) * 62000, (c.y - p[1]) * 111000) < 1500);
    if (c) { c.n++; c.x += (p[0] - c.x) / c.n; c.y += (p[1] - c.y) / c.n; } else clusters.push({ x: p[0], y: p[1], n: 1 });
  }
  for (const c of clusters) {
    const kinds = [...s.kinds];
    features.push({ type: 'Feature', properties: { kind: 'station', name, colours: [...s.colours].slice(0, 6).join(','), n: s.colours.size, metro: kinds.includes('metro') || kinds.includes('mck'), rank: 9 }, geometry: { type: 'Point', coordinates: [r5(c.x), r5(c.y)] } });
    sc++;
  }
}
fs.writeFileSync(outFile, JSON.stringify({ type: 'FeatureCollection', features }));
console.log('lines', features.filter((f) => f.geometry.type === 'MultiLineString').length, 'stations', sc, 'bytes', fs.statSync(outFile).size);
