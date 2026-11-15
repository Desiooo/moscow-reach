// Маска «внутри МКАД»: рисуем МКАД стеной на сетке 60 м, заливаем снаружи — всё остальное внутри.
// usage: node scripts/build-mkad.mjs <raw/mkad.json> <out mkad.bin.gz>
import fs from 'node:fs';
import zlib from 'node:zlib';

const [inFile, outFile] = process.argv.slice(2);
const BBOX = { minLon: 36.8, maxLon: 38.05, minLat: 55.1, maxLat: 56.05 }; // как в остальных скриптах
const R = 6378137, LAT0 = 55.75, CELL = 30, CC = 60, rad = Math.PI / 180;
const mercX = (lon) => R * lon * rad, mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (lat * rad) / 2));
const CS = CELL / Math.cos(LAT0 * rad), mx0 = mercX(BBOX.minLon), my0 = mercY(BBOX.minLat);
const GW = Math.ceil((mercX(BBOX.maxLon) - mx0) / CS), GH = Math.ceil((mercY(BBOX.maxLat) - my0) / CS);
const cw = Math.ceil((GW * CELL) / CC), ch = Math.ceil((GH * CELL) / CC);
const toCell = (lon, lat) => [(((mercX(lon) - mx0) / CS) * CELL) / CC, (((mercY(lat) - my0) / CS) * CELL) / CC];

const wall = new Uint8Array(cw * ch);
const ways = JSON.parse(fs.readFileSync(inFile, 'utf8')).elements;
for (const w of ways) for (let i = 0; i + 1 < w.geometry.length; i++) {
  const [ax, ay] = toCell(w.geometry[i].lon, w.geometry[i].lat), [bx, by] = toCell(w.geometry[i + 1].lon, w.geometry[i + 1].lat);
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 3));
  for (let s = 0; s <= n; s++) {
    const x = Math.floor(ax + ((bx - ax) * s) / n), y = Math.floor(ay + ((by - ay) * s) / n);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < cw && yy < ch) wall[yy * cw + xx] = 1; }
  }
}
// заливка снаружи (4-связная) с границ сетки
const out = new Uint8Array(cw * ch), stack = [];
const push = (x, y) => { const i = y * cw + x; if (!wall[i] && !out[i]) { out[i] = 1; stack.push(i); } };
for (let x = 0; x < cw; x++) { push(x, 0); push(x, ch - 1); }
for (let y = 0; y < ch; y++) { push(0, y); push(cw - 1, y); }
while (stack.length) { const i = stack.pop(), x = i % cw, y = (i / cw) | 0; if (x > 0) push(x - 1, y); if (x < cw - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < ch - 1) push(x, y + 1); }
// «стены» рядом с внешней областью (тонкие съезды и внешняя кромка кольца) тоже снаружи
const inside = new Uint8Array(cw * ch);
for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
  const i = y * cw + x; if (out[i]) continue;
  const nOut = (x > 0 && out[i - 1]) || (x < cw - 1 && out[i + 1]) || (y > 0 && out[i - cw]) || (y < ch - 1 && out[i + cw]);
  inside[i] = wall[i] && nOut ? 0 : 1;
}
let n = 0; for (const v of inside) n += v;
console.log('внутри МКАД, км²:', ((n * CC * CC) / 1e6).toFixed(0), '(ожидается около 880)');
const bits = new Uint8Array(Math.ceil((cw * ch) / 8)); for (let i = 0; i < inside.length; i++) if (inside[i]) bits[i >> 3] |= 1 << (i & 7);
fs.writeFileSync(outFile, zlib.gzipSync(Buffer.concat([Buffer.from(Int32Array.from([cw, ch, CC]).buffer), Buffer.from(bits)]), { level: 9 }));
console.log('файл', fs.statSync(outFile).size, 'байт');
