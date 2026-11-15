// raw/boundary.json (Overpass, relation 102269) → public/boundary.json (GeoJSON, замкнутые контуры)
import fs from 'node:fs';
const [inFile, outFile] = process.argv.slice(2);
const rel = JSON.parse(fs.readFileSync(inFile, 'utf8')).elements[0];
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
// упрощение Дугласа–Пекера (~5 м) и округление
const TOL = 5 / 111000;
function dp(pts, lo, hi, keep) {
  let md = 0, mi = -1; const [ax, ay] = pts[lo], [bx, by] = pts[hi], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
  for (let i = lo + 1; i < hi; i++) { const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L; if (d > md) { md = d; mi = i; } }
  if (md > TOL && mi > 0) { keep[mi] = 1; dp(pts, lo, mi, keep); dp(pts, mi, hi, keep); }
}
const simp = rings.map((r) => { const keep = new Uint8Array(r.length); const mid = r.length >> 1; keep[0] = keep[mid] = keep[r.length - 1] = 1; dp(r, 0, mid, keep); dp(r, mid, r.length - 1, keep); return r.filter((_, i) => keep[i]).map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]); });
const closed = simp.filter((r) => same(r[0], r[r.length - 1])).length;
fs.writeFileSync(outFile, JSON.stringify({ type: 'Feature', properties: { name: 'Москва' }, geometry: { type: 'MultiLineString', coordinates: simp } }));
console.log('контуров', simp.length, 'замкнутых', closed, 'точек', simp.reduce((s, r) => s + r.length, 0), 'байт', fs.statSync(outFile).size);
