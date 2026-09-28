/* GEO Insight Tool — Workflow 1 UI (vanilla JS, no build step).
   All data comes from the FastAPI endpoints under /api. Data values are always
   inserted with textContent (never innerHTML) because they come from AI answers. */
"use strict";

const $ = (s, root = document) => root.querySelector(s);
const state = { propertyId: null, meta: null, period: "all", intent: "", engine: "", lastMeasured: null,
                showTrendTable: false, file: null };

// ---------- tiny DOM helper ----------
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "style") n.setAttribute("style", v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
const NS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}
const pct = (v, d = 0) => (v == null ? "–" : `${(Number(v) * 100).toFixed(d)}%`);
const num = (v, d = 0) => (v == null ? "–" : Number(v).toLocaleString("en-AU", { maximumFractionDigits: d, minimumFractionDigits: d }));
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "–");
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–");
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } }

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) {
    const msg = typeof body === "string" ? body : (body.detail?.message || body.detail || JSON.stringify(body));
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.body = body; throw err;
  }
  return body;
}

// ---------- tooltip ----------
const tip = $("#tooltip");
function showTip(evt, value, label, extra = []) {
  tip.replaceChildren(el("strong", {}, value), el("div", {}, label), ...extra.map((x) => el("div", { class: "muted" }, x)));
  tip.hidden = false;
  const r = (evt.target.getBoundingClientRect ? evt.target.getBoundingClientRect() : { left: evt.clientX, top: evt.clientY, width: 0 });
  const x = evt.clientX ?? r.left + r.width / 2, y = evt.clientY ?? r.top;
  tip.style.left = Math.min(window.innerWidth - 290, x + 12) + "px";
  tip.style.top = y + 14 + "px";
}
function hideTip() { tip.hidden = true; }
function hoverable(node, fn) {
  node.setAttribute("tabindex", "0");
  node.addEventListener("pointermove", fn); node.addEventListener("focus", fn);
  node.addEventListener("pointerleave", hideTip); node.addEventListener("blur", hideTip);
}

// ---------- tabs ----------
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => openTab(b.dataset.tab)));
function openTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== `tab-${name}`));
  store("geo.tab", name);
  if (window.setPageHead) window.setPageHead(name);
  if (name === "uploads") loadImports();
  if (name === "recommendations") loadQueue();
  if (name === "generate") loadCandidates();
  if (name === "evidence") loadDashboard();
  if (name === "reports" && window.loadReport) window.loadReport();
  if (window.renderPage) window.renderPage(name);
  window.scrollTo(0, 0);
}

// ---------- boot ----------
function G_rstateReset() { if (window.GEO?.rstate) window.GEO.rstate.key = null; return false; }
async function boot() {
  let props = [];
  try { props = await api("/api/properties"); } catch (e) { $("#overview-root").replaceChildren(el("div", { class: "report bad" }, `Can't reach the database: ${e.message}`)); return; }
  const sel = $("#property");
  sel.replaceChildren(...props.map((p) => el("option", { value: p.id }, p.name)));
  if (!props.length) { sel.append(el("option", {}, "No property yet — upload a Rankscale export")); openTab("upload"); return; }
  state.propertyId = props[0].id;
  sel.addEventListener("change", () => {
    state.propertyId = sel.value; state.intent = state.engine = ""; state.meta = null;
    const active = document.querySelector(".tabs button[aria-selected=true]")?.dataset.tab || "overview";
    if (G_rstateReset()) {}
    openTab(active);
  });
  $("#reviewer").value = store("geo.reviewer") || "";
  $("#uploader").value = store("geo.reviewer") || "";
  const saved = store("geo.tab");
  const pages = [...document.querySelectorAll(".tabs button")].map((b) => b.dataset.tab);
  openTab(pages.includes(saved) ? saved : "overview");
}

// ============================ DASHBOARD ============================
["f-period", "f-intent", "f-engine"].forEach((id) => $("#" + id).addEventListener("change", (e) => {
  state[{ "f-period": "period", "f-intent": "intent", "f-engine": "engine" }[id]] = e.target.value;
  loadDashboard();
}));
$("[data-table-toggle=trend]").addEventListener("click", (e) => {
  state.showTrendTable = !state.showTrendTable;
  e.target.textContent = state.showTrendTable ? "View as chart" : "View as table";
  loadDashboard();
});

function qs(extra = {}) {
  const p = new URLSearchParams();
  if (state.intent) p.set("intent", state.intent);
  if (state.engine) p.set("engine", state.engine);
  if (state.period !== "all" && state.lastMeasured) {
    const to = new Date(state.lastMeasured); const from = new Date(to); from.setDate(to.getDate() - Number(state.period) + 1);
    p.set("date_from", from.toISOString().slice(0, 10)); p.set("date_to", to.toISOString().slice(0, 10));
  }
  for (const [k, v] of Object.entries(extra)) if (v != null) p.set(k, v);
  return p.toString();
}

async function loadDashboard() {
  if (!state.propertyId) return;
  const pid = state.propertyId;
  document.querySelectorAll("#tab-dashboard .chart, #kpis").forEach((n) => (n.style.opacity = 0.5));
  if (!state.meta) {
    const grid = await api(`/api/dashboard/${pid}/intent-engine`);
    state.meta = { intents: [...new Set(grid.map((r) => r.intent))].sort(), engines: [...new Set(grid.map((r) => r.engine))].sort() };
    $("#f-intent").replaceChildren(el("option", { value: "" }, "All intents"), ...state.meta.intents.map((i) => el("option", { value: i }, i)));
    $("#f-engine").replaceChildren(el("option", { value: "" }, "All engines"), ...state.meta.engines.map((i) => el("option", { value: i }, i)));
    const all = await api(`/api/dashboard/${pid}/kpis`);
    state.lastMeasured = all.last_measured;
  }
  const noDate = qs(); // intent/engine/date filters
  const dateOnly = new URLSearchParams(noDate); dateOnly.delete("intent"); dateOnly.delete("engine");
  const trendQ = new URLSearchParams(noDate); trendQ.delete("date_from"); trendQ.delete("date_to");
  const [k, grid, trend, comps, cites, prompts] = await Promise.all([
    api(`/api/dashboard/${pid}/kpis?${noDate}`),
    api(`/api/dashboard/${pid}/intent-engine?${dateOnly}`),
    api(`/api/dashboard/${pid}/weekly?${trendQ}`),
    api(`/api/dashboard/${pid}/competitors?${qs({ limit: 10 })}`),
    api(`/api/dashboard/${pid}/citations?${qs({ limit: 12 })}`),
    api(`/api/dashboard/${pid}/prompts${state.intent ? "?intent=" + encodeURIComponent(state.intent) : ""}`),
  ]);
  $("#f-range").textContent = k.answers ? `${fmtDate(k.first_measured)} – ${fmtDate(k.last_measured)} · ${num(k.answers)} answers` : "No data for these filters";
  renderKpis(k);
  renderHeatmap(grid);
  renderTrend(trend);
  renderCompetitors(comps, k);
  renderCitations(cites);
  renderPrompts(prompts);
  document.querySelectorAll("#tab-dashboard .chart, #kpis").forEach((n) => (n.style.opacity = 1));
}

function renderKpis(k) {
  const tile = (label, value, note, hero) =>
    el("div", { class: "kpi" + (hero ? " hero" : "") }, el("div", { class: "label" }, label), el("div", { class: "value" }, value), note ? el("div", { class: "note" }, note) : null);
  $("#kpis").replaceChildren(
    tile("Visibility", pct(k.found_rate_any_alias), `Answers that mention the hotel under any of its names`, true),
    tile("Rankscale visibility", pct(k.found_rate_rankscale), `${num(k.missed_by_rankscale)} answers Rankscale missed (other names)`),
    tile("Average rank when found", k.avg_rank_when_found == null ? "–" : `#${num(k.avg_rank_when_found, 1)}`, "1 = named first"),
    tile("Average sentiment", k.avg_sentiment_when_found == null ? "–" : num(k.avg_sentiment_when_found, 2), "0 negative – 1 positive"),
    tile("Answers analysed", num(k.answers), `${num(k.prompts)} prompts · ${num(k.engines)} engines`),
  );
}

// relative luminance of a #rrggbb colour (picks white or ink text inside a fill)
function luminance(hex) {
  const h = hex.replace("#", ""); const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

// heatmap: intent × engine, sequential blue, value in each cell
function renderHeatmap(rows) {
  const box = $("#heatmap");
  if (!rows.length) return box.replaceChildren(el("div", { class: "empty" }, "No data"));
  const intents = [...new Set(rows.map((r) => r.intent))];
  const engines = [...new Set(rows.map((r) => r.engine))];
  // sort intents by overall rate, lowest first (the story is the gaps)
  const rate = (i) => { const rs = rows.filter((r) => r.intent === i); return rs.reduce((a, r) => a + r.found_rate * r.answers, 0) / rs.reduce((a, r) => a + r.answers, 0); };
  intents.sort((a, b) => rate(a) - rate(b));
  const labelW = 150, cellW = 82, cellH = 34, top = 34, W = labelW + engines.length * cellW, H = top + intents.length * cellH;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H + 36}`, role: "img", "aria-label": "Visibility by intent and engine" });
  const short = { "Google AI Overview": "AI Overview", "Bing Copilot": "Copilot" };
  engines.forEach((e, j) => svg.append(s("text", { x: labelW + j * cellW + cellW / 2, y: top - 10, "text-anchor": "middle", class: "ink2" }, short[e] || e)));
  const steps = ["--seq-0", "--seq-1", "--seq-2", "--seq-3", "--seq-4", "--seq-5", "--seq-6", "--seq-7"];
  const cs = getComputedStyle(document.documentElement);
  intents.forEach((it, i) => {
    svg.append(s("text", { x: labelW - 10, y: top + i * cellH + cellH / 2 + 4, "text-anchor": "end", class: "ink" }, it));
    engines.forEach((e, j) => {
      const r = rows.find((x) => x.intent === it && x.engine === e);
      if (!r) return;
      const stepIdx = Math.min(7, Math.round(r.found_rate * 7));
      const fill = cs.getPropertyValue(steps[stepIdx]).trim();
      const x = labelW + j * cellW, y = top + i * cellH;
      const rect = s("rect", { x: x + 1, y: y + 1, width: cellW - 2, height: cellH - 2, rx: 4, fill, class: "cell" });
      const t = s("text", { x: x + cellW / 2, y: y + cellH / 2 + 4, "text-anchor": "middle", style: `fill:${luminance(fill) < 0.4 ? "#fff" : "#0b0b0b"};font-size:12px;pointer-events:none` }, pct(r.found_rate));
      hoverable(rect, (ev) => showTip(ev, pct(r.found_rate, 1), `${it} · ${e}`,
        [`${r.answers} answers`, `Rankscale: ${pct(r.found_rate_rankscale, 1)}`, r.avg_rank_when_found ? `Avg rank when found #${r.avg_rank_when_found}` : "Never ranked"]));
      rect.addEventListener("click", () => { state.intent = it; state.engine = e; $("#f-intent").value = it; $("#f-engine").value = e; loadDashboard(); });
      svg.append(rect, t);
    });
  });
  // scale legend
  const ly = H + 14;
  svg.append(s("text", { x: labelW, y: ly + 9, class: "ink2" }, "0%"));
  steps.forEach((st, n) => svg.append(s("rect", { x: labelW + 26 + n * 22, y: ly, width: 20, height: 10, rx: 2, fill: cs.getPropertyValue(st).trim() })));
  svg.append(s("text", { x: labelW + 26 + 8 * 22 + 6, y: ly + 9, class: "ink2" }, "100%  · click a cell to filter"));
  box.replaceChildren(svg);
}

// weekly line: two series on one percentage axis (same unit), crosshair tooltip
function renderTrend(rows) {
  const box = $("#trend");
  if (!rows.length) return box.replaceChildren(el("div", { class: "empty" }, "No data"));
  if (state.showTrendTable) {
    return box.replaceChildren(table(["Week of", "Answers", "Visibility (any name)", "Rankscale visibility"],
      rows.map((r) => [fmtDate(r.week_start), num(r.answers), pct(r.found_rate, 1), pct(r.found_rate_rankscale, 1)]), [1, 2, 3]));
  }
  const W = 560, H = 240, L = 40, R = 110, T = 14, B = 28;
  const xs = (i) => L + (rows.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (rows.length - 1));
  const maxV = Math.min(1, Math.max(0.5, ...rows.map((r) => Math.max(r.found_rate, r.found_rate_rankscale))) + 0.05);
  const ys = (v) => T + (1 - v / maxV) * (H - T - B);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Weekly visibility" });
  const ticks = [0, 0.25, 0.5, 0.75, 1].filter((t) => t <= maxV + 1e-9);
  ticks.forEach((t) => {
    svg.append(s("line", { x1: L, x2: W - R, y1: ys(t), y2: ys(t), stroke: t === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }));
    svg.append(s("text", { x: L - 6, y: ys(t) + 4, "text-anchor": "end" }, pct(t)));
  });
  rows.forEach((r, i) => svg.append(s("text", { x: xs(i), y: H - 8, "text-anchor": "middle" }, fmtDate(r.week_start))));
  const series = [
    { key: "found_rate", name: "Any name", color: "var(--series-1)" },
    { key: "found_rate_rankscale", name: "Rankscale", color: "var(--series-2)" },
  ];
  series.forEach((ser) => {
    const d = rows.map((r, i) => `${i ? "L" : "M"}${xs(i)},${ys(r[ser.key])}`).join("");
    svg.append(s("path", { d, fill: "none", stroke: ser.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    const last = rows.length - 1;
    svg.append(s("circle", { cx: xs(last), cy: ys(rows[last][ser.key]), r: 4, fill: ser.color, stroke: "var(--surface)", "stroke-width": 2 }));
  });
  // end labels (nudged apart only if they overlap)
  const last = rows.length - 1;
  let y1 = ys(rows[last].found_rate), y2 = ys(rows[last].found_rate_rankscale);
  if (Math.abs(y1 - y2) < 14) { const mid = (y1 + y2) / 2; y1 = y1 <= y2 ? mid - 7 : mid + 7; y2 = y1 <= mid ? mid + 7 : mid - 7; }
  svg.append(s("text", { x: xs(last) + 10, y: y1 + 4, class: "ink" }, `${pct(rows[last].found_rate)} any name`));
  svg.append(s("text", { x: xs(last) + 10, y: y2 + 4, class: "ink2" }, `${pct(rows[last].found_rate_rankscale)} Rankscale`));
  // crosshair
  const cross = s("line", { y1: T, y2: H - B, stroke: "var(--axis)", "stroke-width": 1, visibility: "hidden" });
  svg.append(cross);
  const hit = s("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" });
  hit.addEventListener("pointermove", (ev) => {
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    let i = 0, best = Infinity; rows.forEach((_, n) => { const dd = Math.abs(xs(n) - p.x); if (dd < best) { best = dd; i = n; } });
    cross.setAttribute("x1", xs(i)); cross.setAttribute("x2", xs(i)); cross.setAttribute("visibility", "visible");
    const r = rows[i];
    tip.replaceChildren(el("div", { class: "muted" }, `Week of ${fmtDate(r.week_start)} · ${r.answers} answers`),
      ...series.map((ser) => el("div", {}, el("span", { class: "k", style: `background:${ser.color}` }), el("b", {}, pct(r[ser.key], 1)), ` ${ser.name}`)));
    tip.hidden = false; tip.style.left = Math.min(window.innerWidth - 290, ev.clientX + 12) + "px"; tip.style.top = ev.clientY + 14 + "px";
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  svg.append(hit);
  box.replaceChildren(svg, el("div", { class: "legend" },
    ...series.map((ser) => el("span", {}, el("i", { style: `background:${ser.color}` }), ser.name === "Any name" ? "Any of the hotel's names" : "Rankscale's brand_found"))));
}

// horizontal bars: the hotel emphasised, competitors de-emphasised
function renderCompetitors(rows, k) {
  const box = $("#competitors");
  if (!rows.length) return box.replaceChildren(el("div", { class: "empty" }, "No competitors for these filters"));
  const all = [{ competitor: "This hotel", share: k.found_rate_any_alias, answers: Math.round((k.found_rate_any_alias || 0) * k.answers), avg_rank: k.avg_rank_when_found, me: true },
               ...rows.map((r) => ({ ...r, share: Number(r.share) }))].sort((a, b) => b.share - a.share);
  const labelW = 210, W = 560, barH = 16, gap = 10, T = 4, H = T + all.length * (barH + gap);
  const max = Math.max(...all.map((r) => r.share), 0.01);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Share of answers by brand" });
  all.forEach((r, i) => {
    const y = T + i * (barH + gap), w = Math.max(2, (r.share / max) * (W - labelW - 60));
    const name = r.competitor.length > 32 ? r.competitor.slice(0, 31) + "…" : r.competitor;
    svg.append(s("text", { x: labelW - 10, y: y + barH / 2 + 4, "text-anchor": "end", class: r.me ? "ink" : "ink2", style: r.me ? "font-weight:600" : "" }, name));
    // 4px rounded data-end, square at the baseline
    const path = `M${labelW},${y} h${w - 4} a4,4 0 0 1 4,4 v${barH - 8} a4,4 0 0 1 -4,4 h${-(w - 4)} z`;
    const bar = s("path", { d: path, fill: r.me ? "var(--series-1)" : "var(--de-emph)", class: "bar" });
    hoverable(bar, (ev) => showTip(ev, pct(r.share, 1), r.competitor, [`${num(r.answers)} answers`, r.avg_rank ? `Avg rank #${num(r.avg_rank, 1)}` : ""].filter(Boolean)));
    svg.append(bar, s("text", { x: labelW + w + 6, y: y + barH / 2 + 4, class: "ink2" }, pct(r.share)));
  });
  box.replaceChildren(svg);
}

function table(headers, rows, numCols = [], onRow) {
  const t = el("table", {}, el("thead", {}, el("tr", {}, ...headers.map((h, i) => el("th", { class: numCols.includes(i) ? "num" : "" }, h)))));
  const tb = el("tbody");
  rows.forEach((r, n) => {
    const tr = el("tr", { class: onRow ? "click" : "" }, ...r.map((c, i) => el("td", { class: numCols.includes(i) ? "num" : "" }, c)));
    if (onRow) { tr.tabIndex = 0; tr.addEventListener("click", () => onRow(n)); tr.addEventListener("keydown", (e) => e.key === "Enter" && onRow(n)); }
    tb.append(tr);
  });
  t.append(tb);
  return t;
}

function renderCitations(rows) {
  const box = $("#citations");
  if (!rows.length) return box.replaceChildren(el("div", { class: "empty" }, "No citations"));
  box.replaceChildren(el("div", { class: "scroll" }, table(["Domain", "Citations", "Hotel", "Rivals", "Other"],
    rows.map((r) => [el("span", {}, r.domain, r.is_own_domain ? el("span", { class: "pill good", style: "margin-left:6px" }, "own site") : null),
                     num(r.citations), num(r.for_hotel), num(r.for_competitors), num(r.unattributed)]), [1, 2, 3, 4])));
}

function meter(v) { return el("span", { style: "white-space:nowrap" }, el("span", { class: "meter" }, el("span", { style: `width:${Math.round((v || 0) * 100)}%` })), pct(v)); }

function renderPrompts(rows) {
  const box = $("#prompts");
  if (!rows.length) return box.replaceChildren(el("div", { class: "empty" }, "No prompts"));
  box.replaceChildren(el("div", { class: "scroll" }, table(["Prompt", "Intent", "Visibility", "Best rank", "Top competitor", "Answers"],
    rows.map((r) => [r.prompt_text, r.intent, meter(r.found_rate), r.best_rank ? `#${r.best_rank}` : "–", r.top_competitor || "–", num(r.answers)]),
    [3, 5], (n) => openPrompt(rows[n]))));
}

// ---------- drawer: prompt → answers → measurement ----------
function openDrawer(...content) { $("#drawer-body").replaceChildren(...content.filter((c) => c != null && c !== false)); $("#drawer").hidden = false; $("#drawer-close").focus(); }
$("#drawer-close").addEventListener("click", () => ($("#drawer").hidden = true));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#drawer").hidden = true; });

async function openPrompt(p) {
  const answers = await api(`/api/prompts/${p.prompt_id}/answers`);
  openDrawer(el("h2", {}, p.prompt_text), el("p", { class: "sub" }, `${p.intent} · visibility ${pct(p.found_rate)} across ${p.answers} answers`),
    el("div", { class: "section-title" }, "Every answer (newest first) — click one to open it"),
    table(["Date", "Engine", "Hotel found", "Rank", "Brands named"],
      answers.map((a) => [fmtDateTime(a.measured_at), a.engine,
        a.brand_found_any_alias ? el("span", { class: "pill good" }, a.brand_found ? "yes" : "yes (other name)") : el("span", { class: "pill bad" }, "no"),
        a.own_brand_rank ? `#${a.own_brand_rank}` : "–", num(a.brands_total)]), [3, 4], (n) => openMeasurement(answers[n].measurement_id)));
}

async function openMeasurement(id) {
  const m = await api(`/api/measurements/${id}`);
  const diagBtn = el("button", {}, m.diagnoses.length ? "Run diagnosis again" : "Diagnose with agent");
  const diagOut = el("div");
  diagBtn.addEventListener("click", async () => {
    diagBtn.disabled = true; diagBtn.textContent = "Diagnosing…";
    try { const r = await api("/api/diagnoses/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ measurement_id: id }) });
      diagOut.replaceChildren(el("div", { class: "report ok" }, r.output.diagnosis_needed ? `Saved ${r.recommendation_ids?.length || 0} draft recommendations — see the Review tab.` : "The agent found nothing to fix for this answer."));
      openMeasurement(id);
    } catch (e) { diagOut.replaceChildren(el("div", { class: "report bad" }, e.message)); diagBtn.disabled = false; diagBtn.textContent = "Diagnose with agent"; }
  });
  openDrawer(
    el("h2", {}, m.prompt_text),
    el("p", { class: "sub" }, `${m.engine} · ${fmtDateTime(m.measured_at)} · ${m.intent}`),
    el("div", { class: "row", style: "margin-top:10px" },
      m.brand_found_any_alias ? el("span", { class: "pill good" }, `Hotel found${m.own_brand_rank ? " at #" + m.own_brand_rank : ""}`) : el("span", { class: "pill bad" }, "Hotel not mentioned"),
      m.brand_found_any_alias && !m.brand_found ? el("span", { class: "pill warn" }, `Rankscale missed it (${m.own_brand_name_mentioned || "other name"})`) : null,
      diagBtn),
    diagOut,
    m.diagnoses.length ? el("div", {}, el("div", { class: "section-title" }, "Diagnoses"),
      ...m.diagnoses.map((d) => el("div", { class: "rec" }, el("div", { class: "meta" }, el("span", { class: "pill" }, d.diagnosis_type), el("span", { class: "pill" }, `severity ${d.severity}`), el("span", { class: "pill" }, d.status), el("span", { class: "pill" }, `by ${d.generated_by}`)), el("p", {}, d.root_cause)))) : null,
    el("div", { class: "section-title" }, `Brands ranked (${m.mentions.length})`),
    table(["#", "Brand", "Sentiment", "Described as"], m.mentions.map((x) => [String(x.rank), el("span", { style: x.is_own_brand ? "font-weight:600" : "" }, x.brand_name_raw, x.is_own_brand ? " (hotel)" : ""), x.sentiment == null ? "–" : num(x.sentiment, 2), (x.positive_keywords || []).join(", ")]), [0, 2]),
    el("div", { class: "section-title" }, "Answer"),
    el("div", { class: "answer" }, (m.response_text || "").replaceAll("\\n", "\n")),
    el("div", { class: "section-title" }, `Evidence (${m.evidence.length} sources)`),
    el("div", { class: "scroll" }, table(["Domain", "Cited for", "Confidence", "Status"], m.evidence.map((e) => [
      el("a", { href: e.url, target: "_blank", rel: "noopener" }, e.domain || e.url), e.competitor || e.attributed_to.replace("_", " "),
      `${num(e.confidence_score, 2)} ${e.confidence_level}`, e.verification_status]), [2])));
}

// ============================ UPLOAD ============================
const drop = $("#drop"), fileIn = $("#file");
["dragover", "dragenter"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
drop.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]); });
fileIn.addEventListener("change", () => fileIn.files[0] && pickFile(fileIn.files[0]));
function pickFile(f) { state.file = f; $("#drop-text").textContent = `${f.name} · ${(f.size / 1e6).toFixed(1)} MB`; $("#btn-check").disabled = false; $("#btn-load").disabled = true; $("#upload-report").replaceChildren(); }
$("#btn-check").addEventListener("click", () => sendFile(true));
$("#btn-load").addEventListener("click", () => sendFile(false));

async function sendFile(dry) {
  const fd = new FormData(); fd.append("file", state.file); fd.append("dry_run", dry ? "true" : "false");
  const who = $("#uploader").value.trim(); if (who) { fd.append("uploaded_by", who); store("geo.reviewer", who); }
  const btn = dry ? $("#btn-check") : $("#btn-load"); btn.disabled = true; const label = btn.textContent; btn.textContent = dry ? "Checking…" : "Loading…";
  try {
    const r = await api("/api/imports", { method: "POST", body: fd });
    renderReport(r.report, r.status === "loaded" ? r.added : null);
    $("#btn-load").disabled = !dry;
    if (!dry) { state.meta = null; loadImports(); window.GEO = { $, el, s, api, state, pct, num, fmtDate, store, showTip, hideTip, hoverable, table, openMeasurement, openTab };
boot(); openTab("upload"); }
  } catch (e) {
    const rep = e.body?.detail?.report;
    rep ? renderReport(rep, null, e.message) : $("#upload-report").replaceChildren(el("div", { class: "report bad" }, e.message));
  } finally { btn.textContent = label; if (dry) btn.disabled = false; }
}

function renderReport(rep, added, errMsg) {
  const S = rep.summary || {};
  const ok = rep.ok && !errMsg;
  const box = el("div", { class: "report " + (ok ? "ok" : "bad") },
    el("strong", {}, errMsg ? errMsg : added ? "Loaded into Supabase" : "File looks good — ready to load"),
    el("ul", {},
      el("li", {}, `${num(rep.rows_valid)} of ${num(rep.rows_in_file)} rows valid${rep.rows_rejected ? `, ${rep.rows_rejected} rejected` : ""} (${rep.encoding}, ${rep.delimiter === "\t" ? "tab" : "comma"}-separated)`),
      S.date_from ? el("li", {}, `${fmtDate(S.date_from)} – ${fmtDate(S.date_to)} · ${S.prompts} prompts · ${S.engines.length} engines · ${S.intents.length} intents`) : null,
      S.distinct_answers ? el("li", {}, `${num(S.distinct_answers)} distinct AI answers`) : null,
      rep.columns_dropped?.length ? el("li", {}, `${rep.columns_dropped.length} columns not needed and skipped (ads, tags, shopping)`) : null,
      added ? el("li", {}, `Added ${num(added.measurements)} answers, ${num(added.mentions)} brand mentions, ${num(added.evidence)} evidence rows, ${num(added.prompts)} new prompts${added.measurements === 0 ? " — this data was already loaded" : ""}`) : null,
      ...(rep.warnings || []).map((w) => el("li", {}, w.message)),
      ...(rep.errors || []).slice(0, 10).map((e) => el("li", {}, e.row ? `Row ${e.row}: ${e.message}` : e.message + (e.columns ? ` (${e.columns.join(", ")})` : "")))));
  $("#upload-report").replaceChildren(box);
}

async function loadImports() {
  const rows = await api("/api/imports");
  $("#imports").replaceChildren(rows.length ? table(["When", "File", "By", "Status", "Rows", "Answers added", "Evidence added"],
    rows.map((r) => [fmtDateTime(r.created_at), r.filename || "–", r.uploaded_by || "–", el("span", { class: "pill " + (r.status === "loaded" ? "good" : "bad") }, r.status), num(r.rows_valid) + " / " + num(r.rows_in_file), num(r.measurements_added), num(r.evidence_added)]), [4, 5, 6])
    : el("div", { class: "empty" }, "Nothing imported yet"));
}

// ============================ REVIEW ============================
$("#r-status").addEventListener("change", loadQueue);
$("#reviewer").addEventListener("change", (e) => store("geo.reviewer", e.target.value.trim()));

async function loadQueue() {
  if (!state.propertyId) return;
  const st = $("#r-status").value;
  const rows = await api(`/api/recommendations?property_id=${state.propertyId}${st ? "&status=" + st : ""}`);
  if (!rows.length) return $("#queue").replaceChildren(el("div", { class: "empty" }, "Nothing to review. Open an answer on the dashboard and click “Diagnose with agent”."));
  $("#queue").replaceChildren(...rows.map(recCard));
}

function recCard(r) {
  const comment = el("input", { placeholder: "Comment (optional)" });
  const send = async (target, id, decision) => {
    const reviewer = $("#reviewer").value.trim();
    if (!reviewer) { $("#reviewer").focus(); $("#reviewer").placeholder = "Add your name first"; return; }
    await api("/api/feedback", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target, target_id: id, reviewer, decision, comment: comment.value || null }) });
    loadQueue();
  };
  return el("div", { class: "rec" },
    el("h3", {}, r.title),
    el("div", { class: "meta" }, el("span", { class: "pill" }, r.action_type), el("span", { class: "pill" + (r.priority === "high" ? " bad" : "") }, `${r.priority} priority`),
      el("span", { class: "pill" + (r.status === "approved" ? " good" : r.status === "rejected" ? " bad" : "") }, r.status),
      el("span", { class: "pill" }, `${r.engine} · ${fmtDate(r.measured_at)}`), el("span", { class: "pill" }, r.intent),
      r.feedback_count ? el("span", { class: "pill" }, `${r.feedback_count} review${r.feedback_count > 1 ? "s" : ""}`) : null),
    el("p", {}, r.detail || ""),
    el("details", {}, el("summary", {}, `Why: ${r.diagnosis_type || "–"} · severity ${r.severity || "–"} · confidence ${r.diagnosis_confidence ?? "–"} · ${r.generated_by || ""}`),
      el("p", { class: "muted" }, `Prompt: ${r.prompt_text}`), el("p", {}, r.root_cause || "")),
    el("div", { class: "actions" }, comment,
      el("button", { onclick: () => send("recommendation", r.recommendation_id, "approve") }, "Approve"),
      el("button", { class: "secondary", onclick: () => send("recommendation", r.recommendation_id, "reject") }, "Reject"),
      el("button", { class: "secondary", onclick: () => send("recommendation", r.recommendation_id, "comment") }, "Comment"),
      el("button", { class: "secondary", onclick: () => openMeasurement(r.measurement_id) }, "Open answer")));
}

// ============================ PROMPT GENERATION ============================
$("#btn-generate").addEventListener("click", async () => {
  const b = $("#btn-generate"); b.disabled = true; $("#gen-status").textContent = "Running the three agents… this can take a minute or two.";
  try {
    const r = await api("/api/prompt-generation/run", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ property_id: state.propertyId, total: Number($("#g-total").value), focus: $("#g-focus").value || null, created_by: $("#reviewer").value || null }) });
    $("#gen-status").textContent = `Done: ${r.summary.drafted} drafted, ${r.summary.kept} kept, ${r.summary.rejected} rejected by QA.`;
    loadCandidates();
  } catch (e) { $("#gen-status").textContent = `Failed: ${e.message}`; } finally { b.disabled = false; }
});
$("#btn-approve").addEventListener("click", () => setStatus("approved"));
$("#btn-reject").addEventListener("click", () => setStatus("rejected"));
$("#btn-export").addEventListener("click", (e) => { e.preventDefault(); window.location = `/api/prompt-generation/export.csv?property_id=${state.propertyId}`; setTimeout(loadCandidates, 1500); });

async function setStatus(status) {
  const ids = [...document.querySelectorAll("#candidates input[type=checkbox]:checked")].map((c) => c.value);
  if (!ids.length) return;
  await api("/api/prompt-generation/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt_ids: ids, status }) });
  loadCandidates();
}

async function loadCandidates() {
  if (!state.propertyId) return;
  const [cands, approved] = await Promise.all([
    api(`/api/prompt-generation/candidates?property_id=${state.propertyId}&status=candidate`),
    api(`/api/prompt-generation/candidates?property_id=${state.propertyId}&status=approved`)]);
  const rows = [...cands, ...approved];
  if (!rows.length) return $("#candidates").replaceChildren(el("div", { class: "empty" }, "No candidates yet — run the agents above."));
  $("#candidates").replaceChildren(table(["", "Prompt", "Intent", "Type", "Quality", "Status"],
    rows.map((r) => [el("input", { type: "checkbox", value: r.id, "aria-label": "select prompt" }),
      el("span", {}, r.prompt_text, el("div", { class: "muted" }, r.rationale || "")), r.intent, r.prompt_type || "–",
      r.quality_score == null ? "–" : num(r.quality_score, 2), el("span", { class: "pill" + (r.status === "approved" ? " good" : "") }, r.status)]), [4]));
}

window.GEO = { $, el, s, api, state, pct, num, fmtDate, store, showTip, hideTip, hoverable, table, openMeasurement, openTab };
boot();
