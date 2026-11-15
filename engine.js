// Движок досягаемости: транспортная сеть + пешие участки по уличному графу.
//
// Транспорт (все времена в секундах):
//   A_h  — «вышел из транспорта на хабе h» (отсюда можно идти пешком к соседним хабам)
//   W_h  — «стою на хабе h» (отсюда можно сесть на любой маршрут, проходящий через h)
//   RN   — «еду по маршруту r, сейчас на i-й остановке»
// Пешком от старта до остановок и от остановок до конечной точки — по графу улиц (Дейкстра),
// пересадки между близкими хабами — по прямой с коэффициентом извилистости.
// Растр: время вдоль улиц + узкая «кайма» вокруг них; воду и железные дороги кайма не пересекает.

export const MODES = ['Метро', 'МЦК', 'МЦД', 'Трамвай', 'Троллейбус', 'Автобус'];
const ACCESS = [150, 90, 90, 0, 0, 0]; // спуск на платформу, секунд
const EGRESS = [60, 30, 30, 0, 0, 0]; // выход с платформы
export const CELL = 30; // метров на ячейку растра (как в scripts/build-streets.mjs)
const LAT0 = 55.75;
const R = 6378137;
const TRANSFER_M = 350; // максимальная пересадка пешком между хабами, по прямой
export const DETOUR = 1.3; // извилистость пешей пересадки относительно прямой
const FRINGE_M = 60; // насколько далеко от улицы закрашиваем (дворы, парки)
const WALK_CUT = 45 * 60; // дальше этого пешком до остановки не ищем

const rad = Math.PI / 180;
const mercX = (lon) => R * lon * rad;
const mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (lat * rad) / 2));
const unMercX = (x) => x / R / rad;
const unMercY = (y) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / rad;
const CS = CELL / Math.cos(LAT0 * rad); // размер ячейки в единицах меркатора

class Heap {
  constructor() { this.k = new Float64Array(1 << 16); this.v = new Int32Array(1 << 16); this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) {
      const k2 = new Float64Array(this.n * 2); k2.set(this.k); this.k = k2;
      const v2 = new Int32Array(this.n * 2); v2.set(this.v); this.v = v2;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() { // возвращает значение; ключ в this.topKey
    this.topKey = this.k[0];
    const val = this.v[0];
    const key = this.k[--this.n], v = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = v;
    return val;
  }
}

/** Разбор streets.bin (уже распакованный gzip) → { M, lon, lat, eu, ev, grid }. */
export function parseStreets(buf) {
  const h = new Int32Array(buf, 0, 6);
  if (h[0] !== 0x53545232) throw new Error('streets.bin: неверный формат');
  const M = h[1], E = h[2];
  let off = 24;
  const plane = (count) => {
    const u8 = new Uint8Array(buf, off, count * 4), out = new Int32Array(count);
    for (let i = 0; i < count; i++) out[i] = u8[i] | (u8[count + i] << 8) | (u8[2 * count + i] << 16) | (u8[3 * count + i] << 24);
    off += count * 4; return out;
  };
  const dLon = plane(M), dLat = plane(M);
  const fdeg = new Uint8Array(buf, off, M); off += M;
  const fwd = plane(E);
  const lon = new Float64Array(M), lat = new Float64Array(M);
  let a = 0, b = 0;
  for (let i = 0; i < M; i++) {
    a += (dLon[i] >>> 1) ^ -(dLon[i] & 1); b += (dLat[i] >>> 1) ^ -(dLat[i] & 1);
    lon[i] = 36 + a / 1e6; lat[i] = 55 + b / 1e6;
  }
  const eu = new Int32Array(E), ev = new Int32Array(E);
  let k = 0;
  for (let u = 0; u < M; u++) for (let j = 0; j < fdeg[u]; j++, k++) { eu[k] = u; ev[k] = u + fwd[k]; }
  return { M, lon, lat, eu, ev, grid: { W: h[3], H: h[4], cell: h[5] } };
}

export class Reach {
  /** net — транспортная сеть, streets — результат parseStreets, barrierBits — распакованная маска препятствий. */
  constructor(net, streets, barrierBits, coverBuf, moscowBuf) {
    const b = net.bbox;
    this.mx0 = mercX(b.minLon); this.my0 = mercY(b.minLat);
    this.W = Math.ceil((mercX(b.maxLon) - this.mx0) / CS);
    this.H = Math.ceil((mercY(b.maxLat) - this.my0) / CS);
    if (streets.grid.W !== this.W || streets.grid.H !== this.H || streets.grid.cell !== CELL) throw new Error('сетка улиц не совпадает с сетью');
    // углы картинки для maplibre: верх-лево, верх-право, низ-право, низ-лево
    const x1 = this.mx0 + this.W * CS, y1 = this.my0 + this.H * CS;
    this.corners = [
      [unMercX(this.mx0), unMercY(y1)], [unMercX(x1), unMercY(y1)],
      [unMercX(x1), unMercY(this.my0)], [unMercX(this.mx0), unMercY(this.my0)],
    ];

    // ---- улицы
    const M = (this.nn = streets.M);
    this.gx = new Float32Array(M); this.gy = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      this.gx[i] = (mercX(streets.lon[i]) - this.mx0) / CS;
      this.gy[i] = (mercY(streets.lat[i]) - this.my0) / CS;
    }
    this.eu = streets.eu; this.ev = streets.ev;
    const E = this.eu.length;
    const deg = new Int32Array(M + 1);
    for (let k = 0; k < E; k++) { deg[this.eu[k] + 1]++; deg[this.ev[k] + 1]++; }
    this.aStart = new Int32Array(M + 1);
    for (let i = 0; i < M; i++) this.aStart[i + 1] = this.aStart[i] + deg[i + 1];
    this.aTo = new Int32Array(E * 2); this.aW = new Float32Array(E * 2); // метры
    const fill = new Int32Array(M);
    for (let k = 0; k < E; k++) {
      const u = this.eu[k], v = this.ev[k];
      const m = Math.hypot(this.gx[u] - this.gx[v], this.gy[u] - this.gy[v]) * CELL;
      let p = this.aStart[u] + fill[u]++; this.aTo[p] = v; this.aW[p] = m;
      p = this.aStart[v] + fill[v]++; this.aTo[p] = u; this.aW[p] = m;
    }
    // корзины для поиска ближайших улиц
    this.BS = 4;
    this.bw = Math.ceil(this.W / this.BS); this.bh = Math.ceil(this.H / this.BS);
    const cnt = new Int32Array(this.bw * this.bh + 1);
    const bid = new Int32Array(M);
    for (let i = 0; i < M; i++) { bid[i] = Math.floor(this.gy[i] / this.BS) * this.bw + Math.floor(this.gx[i] / this.BS); cnt[bid[i] + 1]++; }
    for (let i = 0; i < cnt.length - 1; i++) cnt[i + 1] += cnt[i];
    this.bStart = cnt; this.bNodes = new Int32Array(M);
    const bf = new Int32Array(this.bw * this.bh);
    for (let i = 0; i < M; i++) this.bNodes[this.bStart[bid[i]] + bf[bid[i]]++] = i;

    // маска препятствий
    this.barrier = new Uint8Array(this.W * this.H);
    for (let i = 0; i < this.barrier.length; i++) this.barrier[i] = (barrierBits[i >> 3] >> (i & 7)) & 1;

    // покрытие улицами: грубая маска (ячейки CC метров) → по ячейкам растра. Вне покрытия улиц нет, ходим «по прямой».
    {
      const hdr = new Int32Array(coverBuf.slice(0, 12)), cw = hdr[0], CC = hdr[2], bits = new Uint8Array(coverBuf, 12);
      this.cov = new Uint8Array(this.W * this.H);
      for (let y = 0; y < this.H; y++) {
        const cy = Math.floor((y * CELL) / CC);
        for (let x = 0; x < this.W; x++) {
          const ci = cy * cw + Math.floor((x * CELL) / CC);
          this.cov[y * this.W + x] = (bits[ci >> 3] >> (ci & 7)) & 1;
        }
      }
    }

    // собственно Москва (без пригородов) — для долей и статистики
    this.mos = new Uint8Array(this.W * this.H);
    if (moscowBuf) {
      const hdr = new Int32Array(moscowBuf.slice(0, 12)), cw = hdr[0], CC = hdr[2], bits = new Uint8Array(moscowBuf, 12);
      for (let y = 0; y < this.H; y++) {
        const cy = Math.floor((y * CELL) / CC);
        for (let x = 0; x < this.W; x++) { const ci = cy * cw + Math.floor((x * CELL) / CC); this.mos[y * this.W + x] = (bits[ci >> 3] >> (ci & 7)) & 1; }
      }
    }

    // ---- транспорт: хабы
    const H = (this.nh = net.hubs.length / 2);
    this.hx = new Float32Array(H); this.hy = new Float32Array(H); // в ячейках
    for (let i = 0; i < H; i++) {
      this.hx[i] = (mercX(net.hubs[2 * i] / 1e5) - this.mx0) / CS;
      this.hy[i] = (mercY(net.hubs[2 * i + 1] / 1e5) - this.my0) / CS;
    }
    // привязка хабов к улицам: до двух узлов и расстояния до них (метры, вместе с отступом от улицы)
    this.hubN = new Int32Array(H * 2).fill(-1); this.hubM = new Float32Array(H * 2);
    for (let h = 0; h < H; h++) {
      const s = this.snap(this.hx[h], this.hy[h]);
      if (s) { this.hubN[2 * h] = s[0]; this.hubM[2 * h] = s[1]; if (s[2] >= 0) { this.hubN[2 * h + 1] = s[2]; this.hubM[2 * h + 1] = s[3]; } }
    }

    // маршрутные узлы
    let total = 0;
    for (const r of net.routes) total += r.s.length;
    this.nrn = total;
    this.rnHub = new Int32Array(total);
    this.rnCost = new Float32Array(total); // время до следующей остановки, -1 у последней
    this.rnMode = new Uint8Array(total);
    this.rnWait = new Float32Array(total);
    const hubCount = new Int32Array(H + 1);
    let k = 0;
    for (const r of net.routes) {
      for (let i = 0; i < r.s.length; i++, k++) {
        this.rnHub[k] = r.s[i];
        this.rnCost[k] = i + 1 < r.s.length ? r.t[i] : -1;
        this.rnMode[k] = r.m;
        this.rnWait[k] = r.h / 2 + ACCESS[r.m];
        hubCount[r.s[i] + 1]++;
      }
    }
    this.hubStart = new Int32Array(H + 1);
    for (let i = 0; i < H; i++) this.hubStart[i + 1] = this.hubStart[i] + hubCount[i + 1];
    this.hubRn = new Int32Array(total);
    const hf = new Int32Array(H);
    for (let kk = 0; kk < total; kk++) {
      const h = this.rnHub[kk];
      this.hubRn[this.hubStart[h] + hf[h]++] = kk;
    }

    // пешие пересадки между хабами
    const bs = TRANSFER_M / CELL;
    const buckets = new Map();
    const key = (x, y) => x * 65536 + y;
    for (let i = 0; i < H; i++) {
      const kb = key(Math.floor(this.hx[i] / bs), Math.floor(this.hy[i] / bs));
      let a = buckets.get(kb); if (!a) buckets.set(kb, (a = []));
      a.push(i);
    }
    const nbStart = new Int32Array(H + 1);
    const nbList = [], nbDist = [];
    for (let i = 0; i < H; i++) {
      const bx = Math.floor(this.hx[i] / bs), by = Math.floor(this.hy[i] / bs);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const a = buckets.get(key(bx + dx, by + dy));
        if (!a) continue;
        for (const j of a) {
          if (j === i) continue;
          const d = Math.hypot(this.hx[i] - this.hx[j], this.hy[i] - this.hy[j]) * CELL;
          if (d <= TRANSFER_M) { nbList.push(j); nbDist.push(d); }
        }
      }
      nbStart[i + 1] = nbList.length;
    }
    this.nbStart = nbStart;
    this.nbList = Int32Array.from(nbList);
    this.nbDist = Float32Array.from(nbDist);
    this.heap = new Heap();
    this.dist1 = new Float64Array(M);
    // слоты расчёта: 0 — основной, 1 — сравнение «только пешком», 2 — удалённость от центра
    this.states = [0, 1, 2].map(() => ({ dist: new Float64Array(M), last: null }));
    this.stations = [];
  }

  lonLatToCell(lon, lat) {
    return [(mercX(lon) - this.mx0) / CS, (mercY(lat) - this.my0) / CS];
  }

  inside(lon, lat) {
    const [x, y] = this.lonLatToCell(lon, lat);
    return x >= 0 && y >= 0 && x < this.W && y < this.H;
  }

  /**
   * Привязка точки (в ячейках) к ближайшему отрезку улицы.
   * Возвращает [узел1, метры1, узел2|-1, метры2] — метры = отступ от улицы + путь вдоль отрезка. null, если улиц рядом нет.
   */
  snap(px, py, maxCells = 24) {
    const BS = this.BS, bx = Math.floor(px / BS), by = Math.floor(py / BS);
    for (let win = 2; win <= Math.ceil(maxCells / BS) + 1; win += 2) {
      let best = Infinity, bu = -1, bv = -1, bt = 0, bd = 0;
      for (let y = Math.max(0, by - win); y <= Math.min(this.bh - 1, by + win); y++) {
        for (let x = Math.max(0, bx - win); x <= Math.min(this.bw - 1, bx + win); x++) {
          const bid = y * this.bw + x;
          for (let i = this.bStart[bid]; i < this.bStart[bid + 1]; i++) {
            const u = this.bNodes[i];
            for (let e = this.aStart[u]; e < this.aStart[u + 1]; e++) {
              const v = this.aTo[e];
              const ax = this.gx[u], ay = this.gy[u], ex = this.gx[v] - ax, ey = this.gy[v] - ay;
              const L2 = ex * ex + ey * ey;
              let t = L2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / L2 : 0; t = Math.max(0, Math.min(1, t));
              const d = Math.hypot(ax + t * ex - px, ay + t * ey - py);
              if (d < best) { best = d; bu = u; bv = v; bt = t; bd = d; }
            }
          }
        }
      }
      if (bu >= 0 && best <= maxCells) {
        const len = Math.hypot(this.gx[bv] - this.gx[bu], this.gy[bv] - this.gy[bu]);
        const toU = (bd + bt * len) * CELL, toV = (bd + (1 - bt) * len) * CELL;
        return bt >= 1 ? [bv, bd * CELL, -1, 0] : bt <= 0 ? [bu, bd * CELL, -1, 0] : [bu, toU, bv, toV];
      }
    }
    return null;
  }

  _dijkstra(dist, seeds, cutoff, inv) {
    dist.fill(Infinity);
    const heap = this.heap; heap.n = 0;
    for (let i = 0; i < seeds.length; i += 2) { const n = seeds[i], t = seeds[i + 1]; if (t < dist[n]) { dist[n] = t; heap.push(t, n); } }
    const { aStart, aTo, aW } = this;
    while (heap.n) {
      const u = heap.pop(), d = heap.topKey;
      if (d > dist[u]) continue;
      if (d > cutoff) break;
      for (let e = aStart[u]; e < aStart[u + 1]; e++) {
        const v = aTo[e], nd = d + aW[e] * inv;
        if (nd < dist[v]) { dist[v] = nd; heap.push(nd, v); }
      }
    }
  }

  /**
   * Считает время (сек) до каждого узла улиц от точки старта.
   * walkMs — скорость ходьбы по улицам, м/с. modes — 6 булевых. maxSec — отсечка.
   * Возвращает false, если рядом со стартом нет улиц.
   */
  run(lon, lat, { walkMs, modes, maxSec }, slot = 0) {
    const st = this.states[slot];
    const inv = 1 / walkMs;
    const [ox, oy] = this.lonLatToCell(lon, lat);
    st.last = null;
    if (ox < 0 || oy < 0 || ox >= this.W || oy >= this.H) return false;
    const s = this.snap(ox, oy);
    const gridSeeds = []; // [индекс ячейки, время] — источники для «ходьбы по прямой» вне улиц
    const oseeds = [];
    const originFree = !s; // рядом нет улиц (за пределами покрытия) — идём по прямой
    if (s) { oseeds.push(s[0], s[1] * inv); if (s[2] >= 0) oseeds.push(s[2], s[3] * inv); }
    else gridSeeds.push(Math.floor(oy) * this.W + Math.floor(ox), 0);
    const H = this.nh;
    const seeds2 = oseeds.slice();
    let anyTransit = false;
    for (let m = 0; m < 6; m++) if (modes[m]) anyTransit = true;

    if (anyTransit) {
      // 1) пешком от старта до остановок: по улицам, а где улиц нет — по прямой с запасом на извилистость
      this._dijkstra(this.dist1, oseeds, Math.min(maxSec, WALK_CUT), inv);
      const dist = new Float64Array(2 * H + this.nrn).fill(Infinity);
      const heap = this.heap; heap.n = 0;
      const cut = Math.min(maxSec, WALK_CUT);
      for (let h = 0; h < H; h++) {
        let t = Infinity;
        if (!originFree) for (let j = 0; j < 2; j++) { const n = this.hubN[2 * h + j]; if (n >= 0) t = Math.min(t, this.dist1[n] + this.hubM[2 * h + j] * inv); }
        if (originFree || this.hubN[2 * h] < 0) t = Math.min(t, (Math.hypot(this.hx[h] - ox, this.hy[h] - oy) * CELL * DETOUR) * inv);
        if (t < cut) { dist[H + h] = t; heap.push(t, H + h); }
      }
      // 2) транспорт
      while (heap.n) {
        const u = heap.pop(), d = heap.topKey;
        if (d > dist[u]) continue;
        if (d > maxSec) break;
        if (u < H) { // A_h
          if (d < dist[H + u]) { dist[H + u] = d; heap.push(d, H + u); }
          for (let e = this.nbStart[u]; e < this.nbStart[u + 1]; e++) {
            const g = H + this.nbList[e], nd = d + (this.nbDist[e] * DETOUR) / walkMs;
            if (nd < dist[g]) { dist[g] = nd; heap.push(nd, g); }
          }
        } else if (u < 2 * H) { // W_h
          const h = u - H;
          for (let e = this.hubStart[h]; e < this.hubStart[h + 1]; e++) {
            const rn = this.hubRn[e];
            if (!modes[this.rnMode[rn]]) continue;
            const v = 2 * H + rn, nd = d + this.rnWait[rn];
            if (nd < dist[v]) { dist[v] = nd; heap.push(nd, v); }
          }
        } else { // RN
          const rn = u - 2 * H;
          const c = this.rnCost[rn];
          if (c >= 0) { const v = u + 1, nd = d + c; if (nd < dist[v]) { dist[v] = nd; heap.push(nd, v); } }
          const a = this.rnHub[rn], nd = d + EGRESS[this.rnMode[rn]];
          if (nd < dist[a]) { dist[a] = nd; heap.push(nd, a); }
        }
      }
      // 3) время «конца транспорта» в хабе → источники для пешего растекания
      for (let h = 0; h < H; h++) {
        const T = Math.min(dist[h], dist[H + h]);
        if (!(T < maxSec)) continue;
        if (this.hubN[2 * h] >= 0) {
          for (let j = 0; j < 2; j++) { const n = this.hubN[2 * h + j]; if (n >= 0) seeds2.push(n, T + this.hubM[2 * h + j] * inv); }
        } else {
          const x = Math.floor(this.hx[h]), y = Math.floor(this.hy[h]);
          if (x >= 0 && y >= 0 && x < this.W && y < this.H) gridSeeds.push(y * this.W + x, T);
        }
      }
    }
    this._dijkstra(st.dist, seeds2, maxSec, inv);
    st.last = { walkMs, maxSec, ox, oy, gridSeeds };
    return true;
  }

  /** Пешее растекание от произвольных источников: seeds = [узел, секунды, ...]. Результат — в слот, как после run(). */
  runSeeds(seeds, { walkMs, maxSec }, slot = 0) {
    const st = this.states[slot];
    this._dijkstra(st.dist, seeds, maxSec, 1 / walkMs);
    st.last = { walkMs, maxSec, ox: 0, oy: 0, gridSeeds: [] };
    return true;
  }

  /** Источники для runSeeds: все привязанные станции метро / все хабы транспорта (время 0). */
  stationSeeds(walkMs) {
    const out = [], inv = 1 / walkMs;
    for (const s of this.stations) if (s) { out.push(s[0], s[1] * inv); if (s[2] >= 0) out.push(s[2], s[3] * inv); }
    return out;
  }
  hubSeeds(walkMs) {
    const out = [], inv = 1 / walkMs;
    for (let h = 0; h < this.nh; h++) for (let j = 0; j < 2; j++) { const n = this.hubN[2 * h + j]; if (n >= 0) out.push(n, this.hubM[2 * h + j] * inv); }
    return out;
  }

  /** Углы картинки (верх-лево, верх-право, низ-право, низ-лево) для прямоугольника ячеек [x0,x1)×[y0,y1), y вверх. */
  cornersFor(x0, y0, x1, y1) {
    const X = (c) => unMercX(this.mx0 + c * CS), Y = (c) => unMercY(this.my0 + c * CS);
    return [[X(x0), Y(y1)], [X(x1), Y(y1)], [X(x1), Y(y0)], [X(x0), Y(y0)]];
  }

  /**
   * Растр времени (сек) W×H, y вверх; Infinity там, куда не дойти. Шаги:
   *  1) время вдоль улиц; 2) кайма вокруг улиц (не через воду/пути); 3) вне зоны улиц — ходьба по прямой
   *  с запасом на извилистость, но не через воду и пути (мосты проходимы); 4) заполнение «дыр» внутри зоны.
   * Результат: this.best, и this.bbox = {x0,x1,y0,y1} ячеек со временем ≤ budget.
   */
  raster(budget, slot = 0) {
    const st = this.states[slot], dist = st.dist;
    const { walkMs, gridSeeds } = st.last, { W, H, gx, gy, eu, ev, barrier, cov } = this;
    if (!this.best) { this.best = new Float32Array(W * H); this.off = new Uint8Array(W * H); this.vis = new Uint8Array(W * H); this.q = new Int32Array(W * H); }
    const best = this.best, off = this.off;
    best.fill(Infinity); off.fill(255);
    const spc = CELL / walkMs; // секунд на ячейку
    let minx = W, maxx = 0, miny = H, maxy = 0;
    const grow = (x, y) => { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; };
    // 1) время вдоль улиц
    for (let k = 0; k < eu.length; k++) {
      const u = eu[k], v = ev[k], tu = dist[u], tv = dist[v];
      if (tu > budget && tv > budget) continue;
      const ax = gx[u], ay = gy[u], bx = gx[v], by = gy[v];
      const L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L * 2));
      for (let s = 0; s <= n; s++) {
        const f = s / n, t = Math.min(tu + f * L * spc, tv + (1 - f) * L * spc);
        if (t > budget) continue;
        const x = Math.floor(ax + f * (bx - ax)), y = Math.floor(ay + f * (by - ay));
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (t < best[i]) { best[i] = t; off[i] = 0; grow(x, y); }
      }
    }
    // источники «по прямой»: хабы без улиц и старт без улиц
    for (let k = 0; k < gridSeeds.length; k += 2) {
      const i = gridSeeds[k], t = gridSeeds[k + 1];
      if (t <= budget && t < best[i]) { best[i] = t; off[i] = 0; grow(i % W, (i / W) | 0); }
    }
    if (minx > maxx) { this.bbox = null; return best; }
    const D1 = CELL, D2 = CELL * Math.SQRT2;
    // 2) кайма вокруг улиц (двухпроходное расстояние), не заходя в воду/пути и не дальше FRINGE_M
    {
      const x0 = Math.max(1, minx - 3), x1 = Math.min(W - 2, maxx + 3), y0 = Math.max(1, miny - 3), y1 = Math.min(H - 2, maxy + 3);
      const tryUpd = (i, j, step) => {
        if (off[i] === 0) return;
        const tj = best[j]; if (tj === Infinity) return;
        const dj = off[j] + step; if (dj > FRINGE_M) return;
        if (barrier[i]) return;
        const t = tj + step / walkMs;
        if (t < best[i]) { best[i] = t; off[i] = Math.min(254, Math.round(dj)); }
      };
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x; tryUpd(i, i - 1, D1); tryUpd(i, i - W - 1, D2); tryUpd(i, i - W, D1); tryUpd(i, i - W + 1, D2); }
      for (let y = y1; y >= y0; y--) for (let x = x1; x >= x0; x--) { const i = y * W + x; tryUpd(i, i + 1, D1); tryUpd(i, i + W + 1, D2); tryUpd(i, i + W, D1); tryUpd(i, i + W - 1, D2); }
      grow(x0, y0); grow(x1, y1);
    }
    // 3) вне зоны улиц: ходьба по прямой (×DETOUR), не через воду и пути; мосты проходимы (в маске они сняты)
    {
      const r = Math.min(Math.max(W, H), Math.ceil((budget * walkMs) / DETOUR / CELL) + 2);
      const x0 = Math.max(1, minx - r), x1 = Math.min(W - 2, maxx + r), y0 = Math.max(1, miny - r), y1 = Math.min(H - 2, maxy + r);
      const k1 = (D1 * DETOUR) / walkMs, k2 = (D2 * DETOUR) / walkMs;
      if (!this.noWalk) { this.noWalk = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) this.noWalk[i] = cov[i] | barrier[i]; }
      const nw = this.noWalk;
      let changed = true;
      for (let round = 0; round < 4 && changed; round++) {
        changed = false;
        for (let y = y0; y <= y1; y++) for (let x = x0, i = y * W + x0; x <= x1; x++, i++) {
          if (nw[i]) continue;
          let t = best[i], u;
          if ((u = best[i - 1] + k1) < t) t = u;
          if ((u = best[i - W - 1] + k2) < t) t = u;
          if ((u = best[i - W] + k1) < t) t = u;
          if ((u = best[i - W + 1] + k2) < t) t = u;
          if (t < best[i] && t <= budget) { best[i] = t; off[i] = 254; changed = true; }
        }
        for (let y = y1; y >= y0; y--) for (let x = x1, i = y * W + x1; x >= x0; x--, i--) {
          if (nw[i]) continue;
          let t = best[i], u;
          if ((u = best[i + 1] + k1) < t) t = u;
          if ((u = best[i + W + 1] + k2) < t) t = u;
          if ((u = best[i + W] + k1) < t) t = u;
          if ((u = best[i + W - 1] + k2) < t) t = u;
          if (t < best[i] && t <= budget) { best[i] = t; off[i] = 254; changed = true; }
        }
      }
    }
    // границы всей закрашенной области
    minx = W; maxx = 0; miny = H; maxy = 0;
    for (let y = 0; y < H; y++) { const row = y * W; for (let x = 0; x < W; x++) if (best[row + x] <= budget) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; } }
    if (minx > maxx) { this.bbox = null; return best; }
    // 4) заполнение «дыр»: компоненты незакрашенной суши, окружённые закрашенным (а не водой и не внешней стороной)
    {
      const vis = this.vis, q = this.q, MAXHOLE = 6000;
      const bx0 = Math.max(0, minx - 1), bx1 = Math.min(W - 1, maxx + 1), by0 = Math.max(0, miny - 1), by1 = Math.min(H - 1, maxy + 1);
      for (let y = by0; y <= by1; y++) vis.fill(0, y * W + bx0, y * W + bx1 + 1);
      const land = (i) => best[i] > budget && !barrier[i];
      for (let sy = by0 + 1; sy < by1; sy++) for (let sx = bx0 + 1; sx < bx1; sx++) {
        const si = sy * W + sx;
        if (vis[si] || !land(si)) continue;
        let head = 0, tail = 0, edgeReach = 0, edgeBar = 0, outer = false, cx0 = sx, cx1 = sx, cy0 = sy, cy1 = sy;
        q[tail++] = si; vis[si] = 1;
        while (head < tail) {
          const i = q[head++], x = i % W, y = (i / W) | 0;
          if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y;
          for (let n = 0; n < 4; n++) {
            const nx = n === 0 ? x - 1 : n === 1 ? x + 1 : x, ny = n === 2 ? y - 1 : n === 3 ? y + 1 : y;
            if (nx <= bx0 || nx >= bx1 || ny <= by0 || ny >= by1) { outer = true; continue; }
            const j = ny * W + nx;
            if (best[j] <= budget) edgeReach++;
            else if (barrier[j]) edgeBar++;
            else if (!vis[j]) { vis[j] = 1; q[tail++] = j; }
          }
        }
        if (outer || tail > MAXHOLE || edgeReach < 0.6 * (edgeReach + edgeBar)) continue;
        // заливка: время растёт от границы внутрь (двухпроходное расстояние в пределах дыры)
        for (let k = 0; k < tail; k++) vis[q[k]] = 2;
        const kk1 = D1 / walkMs, kk2 = D2 / walkMs;
        const fillUpd = (i, j, k) => { if (vis[i] === 2 && best[j] !== Infinity) { const t = best[j] + k; if (t < best[i]) best[i] = t; } };
        for (let round = 0; round < 2; round++) {
          for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) { const i = y * W + x; fillUpd(i, i - 1, kk1); fillUpd(i, i - W - 1, kk2); fillUpd(i, i - W, kk1); fillUpd(i, i - W + 1, kk2); }
          for (let y = cy1; y >= cy0; y--) for (let x = cx1; x >= cx0; x--) { const i = y * W + x; fillUpd(i, i + 1, kk1); fillUpd(i, i + W + 1, kk2); fillUpd(i, i + W, kk1); fillUpd(i, i + W - 1, kk2); }
        }
        for (let k = 0; k < tail; k++) { const i = q[k]; if (best[i] > budget) best[i] = budget; }
      }
    }
    this.bbox = { x0: minx, x1: maxx + 1, y0: miny, y1: maxy + 1 };
    return best;
  }

  /** Привязать станции метро ([lon,lat,...]) к улицам — для подсчёта «сколько станций в зоне». */
  setStations(list) {
    this.stations = [];
    for (const [lon, lat] of list) {
      const [x, y] = this.lonLatToCell(lon, lat);
      const sn = this.snap(x, y, 40);
      this.stations.push(sn);
    }
  }

  _timeAt(dist, n1, m1, n2, m2, inv) {
    let t = Infinity;
    if (n1 >= 0) t = dist[n1] + m1 * inv;
    if (n2 >= 0) t = Math.min(t, dist[n2] + m2 * inv);
    return t;
  }

  /** Сколько станций метро и остановок транспорта попадает в зону (по времени прихода на улицу рядом). */
  countStops(budget, slot = 0) {
    const st = this.states[slot], inv = 1 / st.last.walkMs, d = st.dist;
    let stations = 0, hubs = 0;
    for (const s of this.stations) if (s && this._timeAt(d, s[0], s[1], s[2], s[3], inv) <= budget) stations++;
    for (let h = 0; h < this.nh; h++) if (this.hubN[2 * h] >= 0 && this._timeAt(d, this.hubN[2 * h], this.hubM[2 * h], this.hubN[2 * h + 1], this.hubM[2 * h + 1], inv) <= budget) hubs++;
    return { stations, hubs };
  }

  /**
   * Растр на budget секунд → гистограмма площади по времени.
   * Возвращает { cum: км² с временем ≤ k·bin для k=1..nb, mosCum: то же внутри Москвы, mosKm2: площадь Москвы в растре }.
   */
  histogram(best, binSec, nb) {
    const cnt = new Float64Array(nb + 1), mcnt = new Float64Array(nb + 1);
    const { W, H, mos } = this, bb = this.bbox;
    if (bb) for (let y = bb.y0; y < bb.y1; y++) for (let x = bb.x0, i = y * W + x; x < bb.x1; x++, i++) {
      const t = best[i]; if (t === Infinity) continue;
      const b = Math.ceil(t / binSec); if (b > nb) continue;
      cnt[b]++; if (mos[i]) mcnt[b]++;
    }
    const k = (CELL * CELL) / 1e6, cum = new Float64Array(nb + 1), mcum = new Float64Array(nb + 1);
    for (let b = 1; b <= nb; b++) { cum[b] = cum[b - 1] + cnt[b] * k; mcum[b] = mcum[b - 1] + mcnt[b] * k; }
    if (!this.mosKm2) { let n = 0; for (let i = 0; i < mos.length; i++) n += mos[i]; this.mosKm2 = n * k; }
    return { cum, mosCum: mcum, mosKm2: this.mosKm2 };
  }
}
