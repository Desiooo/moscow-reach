// Вкладка «Районы»: раскраска районов по показателю, рейтинги, график по округам и карточка района.
import { VIR, lerpPal, rgbHex, makeScale, fmtKm, MEANS } from "./scale.js";

const T_MIN = 10;
const fmt1 = (v) => (v >= 100 ? Math.round(v).toLocaleString("ru") : v.toFixed(1).replace(".", ","));
const fmtMin = (v) => (v == null ? "> 2,5 ч" : v >= 60 ? `${Math.floor(v / 60)} ч ${Math.round(v % 60)} мин` : `${Math.round(v)} мин`);

// good: 'high' — чем больше, тем лучше (ярче); 'low' — чем меньше, тем лучше; 'none' — просто размер
const METRICS = [
  { id: "acc", chip: "Охват по времени", name: "Охват за N мин", unit: "км²", good: "high", get: (p, T) => p.acc[T / T_MIN - 1], fmt: (v) => `${fmtKm(v)} км²`, dyn: true, hint: "Сколько территории можно охватить за N минут, стартуя из района (транспорт + пешком)." },
  { id: "center", name: "Время до центра", unit: "мин", good: "low", get: (p) => p.toCenter.p50 ?? 160, fmt: (v) => (v > 150 ? "> 2,5 ч" : fmtMin(v)), hint: "Типичное (медианное по площади) время в пути от Красной площади." },
  { id: "metro", name: "Пешком до метро", unit: "мин", good: "low", get: (p) => p.metroWalk.mean, fmt: (v) => `${fmt1(v)} мин`, hint: "Средняя пешая дорога до ближайшей станции метро или МЦК (по улицам; места дальше 30 мин считаются за 30)." },
  { id: "stops", name: "Остановок на км²", unit: "ост./км²", good: "high", get: (p) => p.stops / p.area, fmt: (v) => `${fmt1(v)} /км²`, hint: "Плотность остановок и станций общественного транспорта." },
  { id: "street", name: "Плотность улиц", unit: "км/км²", good: "high", get: (p) => p.streetKm / p.area, fmt: (v) => `${fmt1(v)} км/км²`, hint: "Километров улиц, дорожек и троп на квадратный километр (по OpenStreetMap)." },
  { id: "area", name: "Площадь", unit: "км²", good: "none", get: (p) => p.area, fmt: (v) => `${fmtKm(v)} км²`, hint: "Площадь района." },
];

export function createDistricts({ map, $, state, BASE, beforeId, getMean, onChange }) {
  let feats = null, loading = null, hoverId = null, hovering = false;
  const byId = new Map();
  let cur = null; // текущая шкала и значения

  const metricOf = () => METRICS.find((m) => m.id === state.dMetric) || METRICS[0];
  const valOf = (m, p) => m.get(p, state.aT);

  async function load() {
    if (feats) return true;
    if (!loading) loading = (async () => {
      try {
        const gj = await (await fetch(`${BASE}districts.json`)).json();
        feats = gj.features; for (const f of feats) byId.set(f.properties.id, f);
        map.addSource("districts", { type: "geojson", data: gj, promoteId: "id" });
        map.addLayer({ id: "districts-fill", type: "fill", source: "districts", layout: { visibility: "none" }, paint: { "fill-color": ["coalesce", ["feature-state", "c"], "rgba(0,0,0,0)"], "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.92, 0.78] } }, beforeId);
        map.addLayer({ id: "districts-line", type: "line", source: "districts", layout: { visibility: "none" }, paint: { "line-color": "#fff", "line-opacity": 0.85, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 13, 1.6] } }, beforeId);
        map.addLayer({ id: "districts-sel", type: "line", source: "districts", layout: { visibility: "none", "line-join": "round" }, filter: ["==", ["get", "id"], -1], paint: { "line-color": "#e8483b", "line-width": 3 } }, beforeId);
        map.addLayer({ id: "districts-labels", type: "symbol", source: "districts", minzoom: 9.5, layout: { visibility: "none", "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 9.5, 9, 13, 13], "text-max-width": 7 }, paint: { "text-color": "#1d2a33", "text-halo-color": "rgba(255,255,255,.9)", "text-halo-width": 1.4 } });
        map.on("mousemove", "districts-fill", (e) => {
          const f = e.features?.[0]; if (!f) return;
          const id = f.properties.id;
          map.getCanvas().style.cursor = "pointer";
          if (hoverId !== id) { if (hoverId != null) map.setFeatureState({ source: "districts", id: hoverId }, { hover: false }); hoverId = id; map.setFeatureState({ source: "districts", id }, { hover: true }); }
          const p = byId.get(id).properties, m = metricOf(), tip = $("tip");
          tip.innerHTML = `<b>${p.name}</b> · ${p.okrug}<br>${m.name.replace("N", state.aT)}: ${m.fmt(valOf(m, p))}`;
          tip.style.display = "block"; tip.style.left = `${e.point.x + 14}px`; tip.style.top = `${e.point.y + 14}px`;
          hovering = true;
        });
        map.on("mouseleave", "districts-fill", () => { if (hoverId != null) map.setFeatureState({ source: "districts", id: hoverId }, { hover: false }); hoverId = null; hovering = false; $("tip").style.display = "none"; map.getCanvas().style.cursor = ""; });
        map.on("click", "districts-fill", (e) => { if (state.view !== "districts") return; const f = e.features?.[0]; if (f) select(f.properties.id, false); });
        return true;
      } catch (e) { console.warn("районы не загрузились", e); feats = null; loading = null; return false; }
    })();
    await loading; return !!feats;
  }

  const LAYERS = ["districts-fill", "districts-line", "districts-sel", "districts-labels"];
  const setVis = (on) => { if (!map.getLayer("districts-fill")) return; for (const id of LAYERS) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); };

  async function show() {
    $("busy").style.display = "block"; $("busy").textContent = "Загружаю районы…";
    const ok = await load();
    $("busy").style.display = "none";
    if (!ok) { $("dSummary").textContent = "Данные районов недоступны"; return; }
    if (state.view !== "districts") return;
    setVis(true); render();
    if (state.dSel != null && byId.has(state.dSel)) { map.setFilter("districts-sel", ["==", ["get", "id"], state.dSel]); renderCard(state.dSel); }
  }
  function hide() { setVis(false); $("tip").style.display = "none"; }

  // ---- панель выбора показателя
  const chipBox = $("dMetrics");
  for (const m of METRICS) {
    const b = document.createElement("button"); b.className = "chip"; b.textContent = m.chip || m.name; b.dataset.m = m.id;
    b.onclick = () => { state.dMetric = m.id; render(); onChange?.(); };
    chipBox.appendChild(b);
  }
  $("dSlider").oninput = () => { state.aT = Number($("dSlider").value); render(); onChange?.(); };

  function render() {
    if (!feats || state.view !== "districts") return;
    const m = metricOf();
    for (const b of chipBox.children) b.setAttribute("aria-pressed", b.dataset.m === m.id);
    $("dSliderBox").hidden = !m.dyn; $("dSlider").value = state.aT; $("dMins").textContent = state.aT;
    $("dHint").textContent = m.hint;
    const vals = feats.map((f) => valOf(m, f.properties));
    const wts = feats.map((f) => f.properties.area);
    const sc = makeScale(vals, getMean());
    const col = (v) => { const t = sc.f(v); return lerpPal(VIR, 1 - (m.good === "low" ? 1 - t : t)); };
    cur = { m, sc, col, vals };
    feats.forEach((f, i) => map.setFeatureState({ source: "districts", id: f.properties.id }, { c: rgbHex(col(vals[i])) }));
    // легенда
    const legend = $("dLegend"); legend.style.background = `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((x) => `rgb(${lerpPal(VIR, 1 - (m.good === "low" ? 1 - x : x))})`).join(",")})`;
    $("dLo").textContent = m.fmt(sc.min); $("dMid").textContent = `${MEANS.find((x) => x.id === getMean()).short} ${m.fmt(sc.mid)}`; $("dHi").textContent = m.fmt(sc.max);
    $("scaleInfo").textContent = `Среднее по районам: арифм. ${m.fmt(sc.arith)} · геом. ${m.fmt(sc.geo)} · квадр. ${m.fmt(sc.quad)}`;
    $("dSummary").innerHTML = `${m.name.replace("N", `<b>${state.aT}</b>`)}${m.good === "low" ? " · <small>красный — лучше</small>" : m.good === "high" ? " · <small>красный — больше</small>" : ""}`;
    // рейтинги: лучшие и худшие
    const order = feats.map((f, i) => ({ f, v: vals[i] })).sort((a, b) => (m.good === "low" ? a.v - b.v : b.v - a.v));
    const fillList = (el, list) => {
      el.innerHTML = "";
      list.forEach((x, i) => { const li = document.createElement("li"); li.innerHTML = `<span class="n">${i + 1}</span><span class="nm">${x.f.properties.name}<small>${x.f.properties.okrug}</small></span><span class="v">${m.fmt(x.v)}</span>`; li.onclick = () => select(x.f.properties.id, true); el.appendChild(li); });
    };
    fillList($("dTop"), order.slice(0, 5));
    fillList($("dBottom"), order.slice(-5).reverse());
    $("dTopLabel").textContent = m.good === "none" ? "Самые большие" : m.good === "low" ? "Лучшие (меньше — лучше)" : "Лучшие";
    $("dBottomLabel").textContent = m.good === "none" ? "Самые маленькие" : "Худшие";
    if (m.good === "none") { fillList($("dBottom"), order.slice(-5).reverse()); }
    drawOkrugs(m, vals, wts, sc);
    if (state.dSel != null) renderCard(state.dSel);
  }

  // ---- по округам (среднее, взвешенное по площади)
  function drawOkrugs(m, vals, wts, sc) {
    const g = new Map();
    feats.forEach((f, i) => { const k = f.properties.okrug; const o = g.get(k) || { s: 0, w: 0 }; o.s += vals[i] * wts[i]; o.w += wts[i]; g.set(k, o); });
    const rows = [...g].map(([k, o]) => ({ k, v: o.s / o.w })).sort((a, b) => (m.good === "low" ? a.v - b.v : b.v - a.v));
    const W = 320, rowH = 18, L = 44, R = 70, H = rows.length * rowH + 4, mx = Math.max(...rows.map((r) => r.v), 1e-9);
    let s = "";
    rows.forEach((r, i) => {
      const y = 2 + i * rowH, w = ((W - L - R) * r.v) / mx, c = lerpPal(VIR, 1 - (m.good === "low" ? 1 - sc.f(r.v) : sc.f(r.v)));
      s += `<text x="${L - 6}" y="${y + 12}" text-anchor="end">${r.k}</text><rect x="${L}" y="${y + 2}" width="${Math.max(2, w)}" height="${rowH - 6}" rx="3" fill="rgb(${c})"/><text x="${L + Math.max(2, w) + 5}" y="${y + 12}">${m.fmt(r.v)}</text>`;
    });
    const svg = $("chartOkrug"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.innerHTML = s;
  }

  // ---- карточка района
  function select(id, fly) {
    state.dSel = id; onChange?.();
    map.setFilter("districts-sel", ["==", ["get", "id"], id]);
    renderCard(id);
    if (fly) { const p = byId.get(id).properties; map.flyTo({ center: p.c, zoom: Math.max(map.getZoom(), 11.2) }); }
    $("dCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function rankOf(m, p) { // 1 = лучший
    const v = valOf(m, p); let better = 0;
    for (const f of feats) { const w = valOf(m, f.properties); if (m.good === "low" ? w < v : w > v) better++; }
    return better + 1;
  }
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  function renderCard(id) {
    const f = byId.get(id); if (!f) return;
    const p = f.properties, N = feats.length, card = $("dCard");
    card.hidden = false;
    const accAt = (T) => p.acc[T / T_MIN - 1];
    const tiles = [
      [`${fmtKm(accAt(60))} км²`, "охват за 60 мин"],
      [fmtMin(p.toCenter.p50), "до центра (типично)"],
      [`${fmt1(p.metroWalk.mean)} мин`, "пешком до метро"],
      [`${p.metro}`, "станций метро в районе"],
      [`${p.stops}`, "остановок транспорта"],
      [`${Math.round(p.streetKm)} км`, "улиц и дорожек"],
    ].map(([a, b]) => `<div class="tile"><b>${a}</b><span>${b}</span></div>`).join("");
    // ранги по показателям
    const bars = METRICS.filter((m) => m.good !== "none").map((m) => {
      const r = rankOf(m, p), pct = ((N - r) / (N - 1)) * 100;
      return `<div class="rk"><span class="rn">${m.name.replace("N", "60").replace("Охват за 60 мин", "Охват за час")}</span><span class="rb"><i style="width:${pct}%"></i></span><span class="rv">${r}-й</span></div>`;
    }).join("");
    // кривая охвата: район и медиана по Москве
    const medAcc = Array.from({ length: 12 }, (_, k) => median(feats.map((x) => x.properties.acc[k])));
    const ymaxRaw = Math.max(...p.acc, ...medAcc, 1), mag = 10 ** Math.floor(Math.log10(ymaxRaw)), ymax = Math.ceil(ymaxRaw / mag) * mag;
    const CW = 320, CH = 130, L = 36, R = 8, T = 8, B = 20, pw = CW - L - R, ph = CH - T - B, X = (t) => L + (t / 120) * pw, Y = (v) => T + ph - (v / ymax) * ph;
    const path = (arr) => `M${X(0)},${Y(0)}` + arr.map((v, k) => `L${X((k + 1) * 10).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    let grid = ""; for (let i = 0; i <= 3; i++) { const v = (ymax * i) / 3; grid += `<line class="grid" x1="${L}" x2="${CW - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 4}" y="${Y(v) + 3}" text-anchor="end">${fmtKm(v)}</text>`; }
    for (const t of [0, 30, 60, 90, 120]) grid += `<text x="${X(t)}" y="${CH - 6}" text-anchor="middle">${t}</text>`;
    const curve = `<svg class="chart" viewBox="0 0 ${CW} ${CH}">${grid}<path class="l2" d="${path(medAcc)}"/><path class="l1" d="${path(p.acc)}"/></svg>`;
    // время до центра по полосам
    const bands = p.toCenter.bands, bmx = Math.max(...bands.slice(0, -1), 0.05), BW = 320, BH = 100, BL = 4, pw2 = BW - 2 * BL, bw = pw2 / bands.length;
    let bs = ""; bands.forEach((s, k) => { const last = k === bands.length - 1, h = Math.min(1, s / bmx) * 60, x = BL + k * bw; bs += `<rect x="${x + 1}" y="${74 - h}" width="${bw - 2}" height="${h}" rx="2" fill="${last ? "#8a949c" : `rgb(${VIR[k]})`}"/>`; if (s >= 0.08) bs += `<text x="${x + bw / 2}" y="${70 - h}" text-anchor="middle">${Math.round(s * 100)}%</text>`; bs += `<text x="${x + bw}" y="94" text-anchor="middle">${last ? "∞" : (k + 1) * 15}</text>`; });
    const dist = `<svg class="chart" viewBox="0 0 ${BW} ${BH}">${bs}</svg>`;
    const walk = (label, share) => `<div class="rk"><span class="rn">${label}</span><span class="rb"><i style="width:${Math.round(share * 100)}%"></i></span><span class="rv">${Math.round(share * 100)}%</span></div>`;
    card.innerHTML = `
      <div class="card-h"><b>${p.name}</b><span>${p.okrug} · ${fmtKm(p.area)} км²${p.water > 0.05 ? ` · реки и пути ${Math.round(p.water * 100)}%` : ""}</span><button class="x" aria-label="Закрыть">×</button></div>
      <div class="tiles">${tiles}</div>
      <div class="label">Место среди ${N} районов (1-й — лучший)</div>${bars}
      <div class="label">Охват по времени: район и медиана по Москве</div>${curve}
      <div class="key"><span><i></i>${p.name}</span><span><i class="d"></i>медиана района</span></div>
      <div class="label">Время до центра: доля территории района</div>${dist}
      <div class="label">Шаговая доступность территории</div>
      ${walk("станция метро ≤ 10 мин", p.metroWalk.w10)}${walk("станция метро ≤ 15 мин", p.metroWalk.w15)}${walk("остановка ≤ 5 мин", p.stopWalk.w5)}
      ${p.accFallback ? '<p class="hint">Район слишком мал для собственных стартовых точек: охват взят у ближайшей.</p>' : ""}`;
    card.querySelector(".x").onclick = () => { state.dSel = null; card.hidden = true; map.setFilter("districts-sel", ["==", ["get", "id"], -1]); onChange?.(); };
  }

  return { show, hide, render, select, load };
}
