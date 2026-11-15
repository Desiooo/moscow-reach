// Фоновый воркер: своя копия движка для тяжёлых расчётов, чтобы страница не подвисала.
//  curves — площадь зоны по времени (с транспортом и только пешком) для точки;
//  remote — время в пути от центра до каждой точки города.
import { Reach, parseStreets } from "./engine.js";

let reach = null;
const NONE = [false, false, false, false, false, false];

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    reach = new Reach(m.net, parseStreets(m.streets), new Uint8Array(m.barrier), m.cover, m.moscow, m.mkad);
    self.postMessage({ type: "ready" });
    return;
  }
  if (!reach) return;
  reach.setClip(!!m.clip);
  if (m.type === "curves") {
    const opts = { walkMs: m.walkMs, modes: m.modes, maxSec: 7200 };
    const bin = 300, nb = 24; // 5 минут × 24 = 2 часа
    let tr = null, wk = null;
    if (reach.run(m.lon, m.lat, opts, 1)) {
      const best = reach.raster(7200, 1);
      const h = reach.histogram(best, bin, nb);
      tr = Array.from(h.cum.slice(1));
    }
    // только пешком
    if (reach.run(m.lon, m.lat, { ...opts, modes: NONE }, 1)) {
      const best = reach.raster(7200, 1);
      wk = Array.from(reach.histogram(best, bin, nb).cum.slice(1));
    }
    self.postMessage({ type: "curves", id: m.id, tr, wk });
  } else if (m.type === "remote") {
    const maxSec = 150 * 60;
    if (!reach.run(m.lon, m.lat, { walkMs: m.walkMs, modes: m.modes, maxSec }, 2)) { self.postMessage({ type: "remote", id: m.id, ok: false }); return; }
    const best = reach.raster(maxSec, 2);
    const bb = reach.bbox;
    const h = reach.histogram(best, 900, 10); // 15 минут × 10
    // вырезаем прямоугольник с данными
    const x0 = Math.max(0, bb.x0 - 1), x1 = Math.min(reach.W, bb.x1 + 1), y0 = Math.max(0, bb.y0 - 1), y1 = Math.min(reach.H, bb.y1 + 1);
    const w = x1 - x0, hh = y1 - y0, data = new Float32Array(w * hh);
    for (let y = 0; y < hh; y++) data.set(best.subarray((y0 + y) * reach.W + x0, (y0 + y) * reach.W + x1), y * w);
    self.postMessage({ type: "remote", id: m.id, ok: true, x0, y0, x1, y1, data, mosCum: Array.from(h.mosCum.slice(1)), mosKm2: h.mosKm2 }, [data.buffer]);
  }
};
