// Население (GHSL GHS-POP 2020, 3″ ≈ 90 м) → сетка ячеек 120 м нашей карты: людей на ячейку.
// usage: node scripts/build-population.mjs <tile.tif> <publicDir> <outFile>
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fromFile } from 'geotiff';
import { Reach, parseStreets } from '../engine.js';

const [tif, dir, outFile] = process.argv.slice(2);
const un = (f) => { const b = zlib.gunzipSync(fs.readFileSync(`${dir}/${f}`)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const reach = new Reach(JSON.parse(fs.readFileSync(`${dir}/network.json`, 'utf8')), parseStreets(un('streets.bin.gz')), new Uint8Array(un('barrier.bin.gz')), un('cover.bin.gz'), un('moscow.bin.gz'));
const R = 4, W4 = Math.ceil(reach.W / R), H4 = Math.ceil(reach.H / R);

const img = await (await fromFile(tif)).getImage();
const [gx0, , , gy1] = img.getBoundingBox(), [rx, ry] = img.getResolution();
const b = { minLon: 36.8, maxLon: 38.05, minLat: 55.1, maxLat: 56.05 };
const px0 = Math.floor((b.minLon - gx0) / rx), px1 = Math.ceil((b.maxLon - gx0) / rx), py0 = Math.floor((gy1 - b.maxLat) / -ry), py1 = Math.ceil((gy1 - b.minLat) / -ry);
const w = px1 - px0, d = (await img.readRasters({ window: [px0, py0, px1, py1], samples: [0] }))[0];

const pop = new Float32Array(W4 * H4);
let total = 0, inGrid = 0;
for (let j = 0; j < py1 - py0; j++) for (let i = 0; i < w; i++) {
  const v = d[j * w + i]; if (!(v > 0)) continue; total += v;
  const lon = gx0 + (px0 + i + 0.5) * rx, lat = gy1 + (py0 + j + 0.5) * ry; // ry < 0
  const [cx, cy] = reach.lonLatToCell(lon, lat);
  const X = Math.floor(cx / R), Y = Math.floor(cy / R);
  if (X < 0 || Y < 0 || X >= W4 || Y >= H4) continue;
  pop[Y * W4 + X] += v; inGrid += v;
}
// сколько живёт в самой Москве (маска районов 150 м → ячейки)
let mos = 0;
for (let Y = 0; Y < H4; Y++) for (let X = 0; X < W4; X++) { const p = pop[Y * W4 + X]; if (p > 0 && reach.mos[Math.min(reach.H - 1, Y * R + 2) * reach.W + Math.min(reach.W - 1, X * R + 2)]) mos += p; }
console.log('в окне', Math.round(total), 'на сетке', Math.round(inGrid), 'в Москве', Math.round(mos), 'сетка', W4, 'x', H4);
const hdr = Buffer.from(Int32Array.from([W4, H4, R]).buffer);
fs.writeFileSync(outFile, zlib.gzipSync(Buffer.concat([hdr, Buffer.from(pop.buffer)]), { level: 9 }));
console.log('файл', fs.statSync(outFile).size, 'байт');
