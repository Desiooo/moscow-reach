// Движок досягаемости: транспортная сеть + пешие участки.
//
// Граф (все времена в секундах):
//   A_h  — «вышел из транспорта на хабе h» (отсюда можно идти пешком к соседним хабам)
//   W_h  — «стою на хабе h» (отсюда можно сесть на любой маршрут, проходящий через h)
//   RN   — «еду по маршруту r, сейчас на i-й остановке»
// Пешком между хабами идём по прямой с коэффициентом извилистости.

export const MODES = ['Метро', 'МЦК', 'МЦД', 'Трамвай', 'Троллейбус', 'Автобус'];
const ACCESS = [150, 90, 90, 0, 0, 0]; // спуск на платформу, секунд
const EGRESS = [60, 30, 30, 0, 0, 0]; // выход с платформы
export const CELL = 60; // метров на ячейку растра
const LAT0 = 55.75;
const R = 6378137;
const TRANSFER_M = 350; // максимальная пересадка пешком, по прямой
export const DETOUR = 1.3; // извилистость пешего пути относительно прямой

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

export class Reach {
  constructor(net) {
    const b = net.bbox;
    this.mx0 = mercX(b.minLon); this.my0 = mercY(b.minLat);
    this.W = Math.ceil((mercX(b.maxLon) - this.mx0) / CS);
    this.H = Math.ceil((mercY(b.maxLat) - this.my0) / CS);
    // углы картинки для maplibre: верх-лево, верх-право, низ-право, низ-лево
    const x1 = this.mx0 + this.W * CS, y1 = this.my0 + this.H * CS;
    this.corners = [
      [unMercX(this.mx0), unMercY(y1)], [unMercX(x1), unMercY(y1)],
      [unMercX(x1), unMercY(this.my0)], [unMercX(this.mx0), unMercY(this.my0)],
    ];

    const H = (this.nh = net.hubs.length / 2);
    this.hx = new Float32Array(H); this.hy = new Float32Array(H); // в ячейках
    for (let i = 0; i < H; i++) {
      this.hx[i] = (mercX(net.hubs[2 * i] / 1e5) - this.mx0) / CS;
      this.hy[i] = (mercY(net.hubs[2 * i + 1] / 1e5) - this.my0) / CS;
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
    const fill = new Int32Array(H);
    for (let kk = 0; kk < total; kk++) {
      const h = this.rnHub[kk];
      this.hubRn[this.hubStart[h] + fill[h]++] = kk;
    }

    // пешие пересадки между хабами
    const bs = TRANSFER_M / CELL; // размер корзины в ячейках
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
  }

  lonLatToCell(lon, lat) {
    return [(mercX(lon) - this.mx0) / CS, (mercY(lat) - this.my0) / CS];
  }

  inside(lon, lat) {
    const [x, y] = this.lonLatToCell(lon, lat);
    return x >= 0 && y >= 0 && x < this.W && y < this.H;
  }

  /**
   * Дейкстра от точки. walkMs — скорость ходьбы м/с (по тропе, с учётом извилистости считаем внутри).
   * modes — массив из 6 булевых. maxSec — отсечка.
   */
  run(lon, lat, { walkMs, modes, maxSec }) {
    const H = this.nh, N = 2 * H + this.nrn;
    // double, как и ключи кучи: при float32 округление отбрасывало валидные вершины (d > dist[u])
    const dist = new Float64Array(N).fill(Infinity);
    const eff = walkMs / DETOUR; // скорость по прямой, м/с
    const [ox, oy] = this.lonLatToCell(lon, lat);
    const heap = this.heap; heap.n = 0;
    let anyTransit = false;
    for (let m = 0; m < 6; m++) if (modes[m]) anyTransit = true;

    if (anyTransit) {
      for (let h = 0; h < H; h++) {
        const t = (Math.hypot(this.hx[h] - ox, this.hy[h] - oy) * CELL) / eff;
        if (t < maxSec) { dist[H + h] = t; heap.push(t, H + h); }
      }
    }
    while (heap.n) {
      const u = heap.pop(), d = heap.topKey;
      if (d > dist[u]) continue;
      if (d > maxSec) break;
      if (u < H) { // A_h
        if (d < dist[H + u]) { dist[H + u] = d; heap.push(d, H + u); }
        for (let e = this.nbStart[u]; e < this.nbStart[u + 1]; e++) {
          const g = H + this.nbList[e], nd = d + this.nbDist[e] / eff;
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
        if (c >= 0) {
          const v = u + 1, nd = d + c;
          if (nd < dist[v]) { dist[v] = nd; heap.push(nd, v); }
        }
        const a = this.rnHub[rn], nd = d + EGRESS[this.rnMode[rn]];
        if (nd < dist[a]) { dist[a] = nd; heap.push(nd, a); }
      }
    }
    // время «окончания транспорта» в хабе = min(A, W)
    const hubT = new Float32Array(H);
    for (let h = 0; h < H; h++) hubT[h] = Math.min(dist[h], dist[H + h]);
    this.last = { ox, oy, eff, hubT, maxSec };
    return this.last;
  }

  /** Растр времени (сек) на сетке. Float32Array W*H, y вверх (север = больший индекс строки). */
  raster(budgetSec) {
    const { ox, oy, eff, hubT } = this.last;
    const { W, H } = this;
    const best = new Float32Array(W * H).fill(Infinity);
    const splat = (cx, cy, T) => {
      const rem = budgetSec - T;
      if (rem <= 0) return;
      const r = Math.ceil((rem * eff) / CELL);
      const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
      const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
      const k = CELL / eff;
      for (let y = y0; y <= y1; y++) {
        const dy = y + 0.5 - cy, row = y * W;
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - cx;
          const t = T + Math.sqrt(dx * dx + dy * dy) * k;
          if (t < best[row + x]) best[row + x] = t;
        }
      }
    };
    // источники по возрастанию времени; доминируемые отбрасываем
    const order = [];
    for (let h = 0; h < this.nh; h++) if (hubT[h] < budgetSec - 20) order.push(h);
    order.sort((a, b) => hubT[a] - hubT[b]);
    splat(ox, oy, 0);
    for (const h of order) {
      const cx = this.hx[h], cy = this.hy[h];
      const ix = Math.floor(cx), iy = Math.floor(cy);
      if (ix >= 0 && iy >= 0 && ix < W && iy < H && best[iy * W + ix] <= hubT[h] + 10) continue;
      splat(cx, cy, hubT[h]);
    }
    return best;
  }
}
