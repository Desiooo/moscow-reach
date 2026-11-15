// Тепловая карта доступности: из каждой точки сетки (~1 км) считаем площадь охвата за 10…120 минут.
// usage: node scripts/build-access.mjs <publicDir> <outFile>
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Reach, parseStreets } from '../engine.js';

const SP = 32; // шаг сетки стартов, ячеек (≈ 960 м)
const WALK_MS = 5000 / 3600;
const MODES = [true, true, true, true, true, true];

function load(dir) {
  const un = (f) => { const b = zlib.gunzipSync(fs.readFileSync(`${dir}/${f}`)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const net = JSON.parse(fs.readFileSync(`${dir}/network.json`, 'utf8'));
  return new Reach(net, parseStreets(un('streets.bin.gz')), new Uint8Array(un('barrier.bin.gz')), un('cover.bin.gz'), un('moscow.bin.gz'), un('mkad.bin.gz'));
}

if (isMainThread) {
  const [dir, outFile] = process.argv.slice(2);
  const r = load(dir);
  const origins = [];
  for (let iy = 0; (iy + 0.5) * SP < r.H; iy++) for (let ix = 0; (ix + 0.5) * SP < r.W; ix++) {
    const cx = (ix + 0.5) * SP, cy = (iy + 0.5) * SP, i = Math.floor(cy) * r.W + Math.floor(cx);
    if (!r.cov[i]) continue;
    if (!r.snap(cx, cy, 16)) continue; // нужны улицы рядом
    const [lon, lat] = r.cornersFor(cx, cy, cx, cy)[0];
    origins.push({ ix, iy, lon, lat, mos: r.mos[i] ? 1 : 0, mk: r.mk[i] ? 1 : 0 });
  }
  console.log('стартов', origins.length, 'в Москве', origins.filter((o) => o.mos).length);
  const n = Math.max(1, Math.min(os.availableParallelism() - 3, 12));
  const out = new Array(origins.length);
  let next = 0, done = 0, alive = n;
  const t0 = Date.now();
  const CH = 8;
  for (let k = 0; k < n; k++) {
    const w = new Worker(new URL(import.meta.url), { workerData: { dir } });
    const feed = () => {
      if (next >= origins.length) { w.postMessage(null); return; }
      const from = next; next = Math.min(origins.length, next + CH);
      w.postMessage({ from, items: origins.slice(from, next) });
    };
    w.on('message', (m) => {
      if (m.ready) return feed();
      m.res.forEach((row, j) => { out[m.from + j] = row; });
      done += m.res.length;
      if (done % 200 < CH) console.log(`${done}/${origins.length}  ${Math.round((Date.now() - t0) / 1000)} c`);
      feed();
    });
    w.on('exit', () => { if (--alive === 0) {
      const pts = origins.map((o, i) => [o.ix, o.iy, o.mos, o.mk, ...out[i]]);
      fs.writeFileSync(outFile, JSON.stringify({ sp: SP, step: 10, nT: 12, pts }));
      console.log('готово', pts.length, 'точек,', fs.statSync(outFile).size, 'байт,', Math.round((Date.now() - t0) / 1000), 'с');
    } });
  }
} else {
  const r = load(workerData.dir);
  parentPort.postMessage({ ready: 1 });
  parentPort.on('message', (job) => {
    if (!job) { process.exit(0); return; }
    const res = job.items.map((o) => {
      if (!r.run(o.lon, o.lat, { walkMs: WALK_MS, modes: MODES, maxSec: 7200 })) return new Array(24).fill(0);
      const best = r.raster(7200);
      const h = r.histogram(best, 600, 12);
      return [...Array.from(h.cumAll.slice(1), (v) => Math.round(v)), ...Array.from(h.cumK.slice(1), (v) => Math.round(v))]; // [весь охват ×12, только внутри МКАД ×12]
    });
    parentPort.postMessage({ from: job.from, res });
  });
}
