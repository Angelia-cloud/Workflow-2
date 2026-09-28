/* App shell pages: Overview, Monthly Intelligence, AI Engine Performance, Competitive Benchmark,
   Intent Analysis, Evidence & Diagnosis (top part), Reports header, Settings.
   Every number comes from /api/report (Supabase). Data text is inserted with textContent only. */
"use strict";
(() => {
  const G = window.GEO;
  const { el, s, api, num, fmtDate, showTip, hideTip, hoverable, store } = G;
  const RP = G.report;
  const $ = (q) => document.querySelector(q);
  const PAGES = {
    overview: ["From visibility to your next move.", (n) => `Track AI search visibility, understand competitive position, and get data-driven insights for ${n}.`],
    intelligence: ["Monthly intelligence", () => "What changed this period, why it matters, and what we'll monitor next."],
    engines: ["AI engine performance", (n) => `How ChatGPT, Gemini, Claude, Perplexity, Copilot and AI Overview see ${n}.`],
    competitive: ["Competitive benchmark", (n) => `${n} against the tracked competitor set on the neutral prompt set.`],
    intents: ["Intent analysis", (n) => `Where ${n} wins by guest intent, and where competitors are stronger.`],
    evidence: ["Evidence & diagnosis", () => "Which sources inform AI, and every answer behind the numbers. Open an answer to run the diagnosis agent."],
    recommendations: ["Recommendations", () => "Review, approve or reject what the diagnosis agent proposes. Every decision is logged."],
    reports: ["Reports", () => "The full client report for the selected period. Export PDF prints it with a cover page."],
    uploads: ["Data & uploads", () => "Upload the Rankscale export exactly as it downloads. It's checked, cleaned and saved to Supabase."],
    generate: ["Prompt generation", () => "Three agents propose new prompts to track; approve them and export the file for Rankscale."],
    settings: ["Settings", () => "Competitor set, neutral prompts, benchmarks and the model the agents use."],
  };
  const propName = () => $("#property")?.selectedOptions?.[0]?.textContent || "your property";
  const short = (n) => RP.shortName(n);
  const periodText = (r) => (r ? RP.fmtRange(r.period.from, r.period.to) : "Last 30 days");
  const monthText = (r) => (r ? new Date(r.period.to).toLocaleDateString("en-AU", { month: "long", year: "numeric" }) : "");

  // ------------------------------------------------------------------ page header
  window.setPageHead = (name, r) => {
    const [title, sub] = PAGES[name] || ["GEO Intelligence", () => ""];
    const data = r || G.rstate?.data;
    $("#ph-eyebrow").textContent = data ? `Monthly report · ${monthText(data)}` : "Monthly report";
    $("#ph-title").textContent = title;
    $("#ph-sub").textContent = sub(short(propName()));
    $("#period-label").textContent = periodText(data);
  };

  // ------------------------------------------------------------------ period menu
  const menu = $("#period-menu"), pbtn = $("#period-btn");
  function currentPage() { return document.querySelector(".tabs button[aria-selected=true]")?.dataset.tab || "overview"; }
  function buildMenu(r) {
    const R = G.rstate;
    const opt = (label, preset) => {
      const b = el("button", { class: "opt", role: "menuitemradio", "aria-checked": String(R.preset === preset) }, el("span", {}, label), el("span", { class: "check" }, "✓"));
      b.addEventListener("click", () => { RP.applyPeriod(preset); closeMenu(); rerender(); });
      return b;
    };
    const nameOpt = (label, v) => {
      const b = el("button", { class: "opt", role: "menuitemradio", "aria-checked": String(R.names === v) }, el("span", {}, label), el("span", { class: "check" }, "✓"));
      b.addEventListener("click", () => { RP.applyPeriod(R.preset, R.from, R.to, v); closeMenu(); rerender(); });
      return b;
    };
    const from = el("input", { type: "date", value: String(r?.period.from || "").slice(0, 10), "aria-label": "From" });
    const to = el("input", { type: "date", value: String(r?.period.to || "").slice(0, 10), "aria-label": "To" });
    const go = el("button", { class: "ghost-btn", style: "padding:6px 10px" }, "Apply");
    go.addEventListener("click", () => { RP.applyPeriod("custom", from.value, to.value); closeMenu(); rerender(); });
    menu.replaceChildren(
      el("div", { class: "grp" }, "Reporting period"),
      opt("Last 30 days of data", "last30"),
      ...(r ? RP.monthsBetween(r.period.data_from, r.period.data_to).map((m) =>
        opt(m.toLocaleDateString("en-AU", { month: "long", year: "numeric" }), "m:" + m.toISOString().slice(0, 7))) : []),
      opt("All data", "all"),
      el("div", { class: "custom" }, from, to, go),
      el("div", { class: "grp" }, "Count the hotel when"),
      nameOpt("Rankscale detects it", "rankscale"),
      nameOpt("Any confirmed hotel name appears", "all"));
  }
  function closeMenu() { menu.hidden = true; pbtn.setAttribute("aria-expanded", "false"); }
  pbtn.addEventListener("click", () => { if (menu.hidden) { buildMenu(G.rstate.data); menu.hidden = false; pbtn.setAttribute("aria-expanded", "true"); } else closeMenu(); });
  document.addEventListener("click", (e) => { if (!menu.hidden && !e.target.closest(".period-pick")) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  function rerender() { G.openTab(currentPage()); }

  $("#btn-upload-new").addEventListener("click", () => G.openTab("uploads"));
  $("#btn-pdf").addEventListener("click", async () => {
    G.openTab("reports");
    await RP.getReport(); await new Promise((res) => setTimeout(res, 500));
    window.print();
  });

  // ------------------------------------------------------------------ small components
  const card = (title, sub, right, ...body) => el("article", { class: "ui-card" },
    el("div", { class: "ui-card-head" }, el("div", {}, el("h3", {}, ...[].concat(title)), sub ? el("p", { class: "sub" }, sub) : null), right || null), ...body);
  const svgIcon = (paths, color) => { const svg = s("svg", { viewBox: "0 0 20 20", fill: "none", stroke: color, "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" }); paths.forEach((d) => svg.append(s("path", { d }))); return svg; };
  const KPI_ICONS = {
    visibility: [["M4 16V10", "M8 16V6", "M12 16V9", "M16 16V4"], "#3b76e1", "#e8effd"],
    detection: [["M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z", "M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"], "#5b54e6", "#ecebfd"],
    position: [["M4 14h12", "M4.5 14 3.5 6.5l4 3L10 5l2.5 4.5 4-3-1 7.5"], "#d99a1e", "#fdf3df"],
    sentiment: [["M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z", "M7.5 11.5c1.3 1.3 3.7 1.3 5 0", "M7.6 8h.01", "M12.4 8h.01"], "#1a8f4a", "#e3f5ea"],
    top3: [["M6 16h8", "M10 16v-3", "M6 4h8v3a4 4 0 0 1-8 0z"], "#3b76e1", "#e8effd"],
  };
  const DEFS = {
    visibility: "Average answer score: 100 at rank 1, 90.9 at rank 2, 83.3 at rank 3 … and 0 when not mentioned (Rankscale's formula).",
    detection: "Share of AI answers that mention the hotel.",
    position: "Average rank when the hotel is mentioned (1 = named first).",
    sentiment: "Average sentiment × 100 when the hotel is mentioned.",
    top3: "Share of AI answers where the hotel ranks 1–3.",
  };
  function kpiCard(o) {
    const [paths, stroke, bg] = KPI_ICONS[o.metric];
    const mv = o.vs_baseline;
    const delta = !mv ? el("div", { class: "k-delta flat" }, "No baseline yet")
      : el("div", { class: "k-delta " + (mv.better ? "good" : mv.better === false ? "bad" : "flat") },
          o.metric === "position" ? `${mv.better ? "↑" : "↓"} ${Math.abs(mv.relative_pct)}% ${mv.better ? "improvement" : "decline"}`
            : `${mv.relative_pct >= 0 ? "↑ +" : "↓ −"}${Math.abs(mv.relative_pct)}% vs baseline`);
    return el("div", { class: "kpi-card" },
      el("div", { class: "kpi-icon", style: `background:${bg}` }, svgIcon(paths, stroke)),
      el("div", {},
        el("div", { class: "k-label" }, RP.METRIC_LABEL[o.metric], el("span", { class: "k-info", title: DEFS[o.metric], "aria-label": DEFS[o.metric] }, "i")),
        el("div", { class: "k-value" }, o.current == null ? "–" : o.metric === "position" ? `#${num(o.current, 2)}` : num(o.current, o.metric === "sentiment" ? 1 : 2)),
        delta,
        o.vs_last_report ? el("div", { class: "k-note" }, `${o.vs_last_report.relative_pct >= 0 ? "+" : "−"}${Math.abs(o.vs_last_report.relative_pct)}% vs last report (${o.metric === "position" ? "#" : ""}${o.vs_last_report.reference})`) : null));
  }

  // smooth path through points (Catmull-Rom → cubic Bézier)
  function smooth(pts) {
    if (pts.length < 3) return pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join("");
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
    }
    return d;
  }

  function trendCard(r) {
    const sel = el("select", { class: "ui-select", "aria-label": "Metric" },
      ...["visibility", "detection", "top3", "sentiment"].map((m) => el("option", { value: m }, RP.METRIC_LABEL[m])));
    sel.value = store("geo.trendMetric") || "visibility";
    const box = el("div", { class: "ui-chart" });
    const draw = () => {
      const m = sel.value; store("geo.trendMetric", m);
      const pts = r.trend.filter((p) => p[m] != null);
      const base = r.overall.find((o) => o.metric === m)?.vs_baseline?.reference ?? null;
      if (!pts.length) return box.replaceChildren(el("div", { class: "empty" }, "No data"));
      const W = 700, H = 280, L = 34, Rr = 12, T = 14, B = 30;
      const vals = pts.map((p) => p[m]).concat(base != null ? [base] : []);
      const lo = Math.max(0, Math.floor((Math.min(...vals) - 5) / 10) * 10), hi = Math.min(100, Math.ceil((Math.max(...vals) + 5) / 10) * 10);
      const xs = (i) => L + (pts.length === 1 ? (W - L - Rr) / 2 : (i * (W - L - Rr)) / (pts.length - 1));
      const ys = (v) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
      const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${RP.METRIC_LABEL[m]} over time` });
      for (let v = lo; v <= hi; v += 10) {
        svg.append(s("line", { x1: L, x2: W - Rr, y1: ys(v), y2: ys(v), stroke: "var(--ui-line)", "stroke-width": 1 }));
        svg.append(s("text", { x: L - 8, y: ys(v) + 4, "text-anchor": "end" }, String(v)));
      }
      const P = pts.map((p, i) => [xs(i), ys(p[m])]);
      const line = smooth(P);
      svg.append(s("path", { d: `${line}L${xs(pts.length - 1)},${ys(lo)}L${xs(0)},${ys(lo)}Z`, fill: "var(--ui-blue)", opacity: 0.14 }));
      svg.append(s("path", { d: line, fill: "none", stroke: "var(--ui-blue)", "stroke-width": 2.5, "stroke-linecap": "round" }));
      if (base != null) {
        svg.append(s("line", { x1: L, x2: W - Rr, y1: ys(base), y2: ys(base), stroke: "#e0527a", "stroke-width": 1.5, "stroke-dasharray": "7 6" }));
        svg.append(s("text", { x: W - Rr - 4, y: ys(base) + 16, "text-anchor": "end", style: "fill:#e0527a;font-weight:600" }, `Pre-schema baseline ${num(base, 1)}`));
      }
      const last = pts.length - 1;
      svg.append(s("circle", { cx: xs(last), cy: ys(pts[last][m]), r: 4.5, fill: "var(--ui-blue)", stroke: "var(--ui-card)", "stroke-width": 2 }));
      const step = Math.max(1, Math.ceil(pts.length / 6));
      pts.forEach((p, i) => { if (i % step === 0 || i === last) svg.append(s("text", { x: xs(i), y: H - 8, "text-anchor": i === 0 ? "start" : i === last ? "end" : "middle" }, fmtDate(p.day))); });
      const cross = s("line", { y1: T, y2: H - B, stroke: "var(--ui-muted)", "stroke-width": 1, visibility: "hidden" });
      const hit = s("rect", { x: L, y: T, width: W - L - Rr, height: H - T - B, fill: "transparent" });
      svg.append(cross, hit);
      hit.addEventListener("pointermove", (ev) => {
        const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
        const x = pt.matrixTransform(svg.getScreenCTM().inverse()).x;
        let i = 0, best = 1e9; pts.forEach((_, n) => { const d = Math.abs(xs(n) - x); if (d < best) { best = d; i = n; } });
        cross.setAttribute("x1", xs(i)); cross.setAttribute("x2", xs(i)); cross.setAttribute("visibility", "visible");
        showTip(ev, num(pts[i][m], 2), `${RP.METRIC_LABEL[m]} · ${fmtDate(pts[i].day)}`, [`${pts[i].answers} AI answers in this run`]);
      });
      hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
      box.replaceChildren(svg);
    };
    sel.addEventListener("change", draw);
    draw();
    return card(`${RP.METRIC_LABEL[sel.value]} over time`, "Each point is one Rankscale tracking run · all data, with the selected period's metrics above", sel, box);
  }

  function engineBars(r, big) {
    const rows = r.engines;
    const W = big ? 520 : 330, labelW = big ? 120 : 84, rowH = big ? 44 : 40, T = 6, H = T + rows.length * rowH + 26;
    const max = 100, tickVals = [0, 40, 80];
    const x = (v) => labelW + (v / max) * (W - labelW - 56);
    const short = { "Google AI Overview": "AI Overview", "Bing Copilot": "Copilot" };
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Visibility by AI engine" });
    rows.forEach((e, i) => {
      const y = T + i * rowH;
      svg.append(s("text", { x: labelW - 12, y: y + 14, "text-anchor": "end", class: "lbl" }, short[e.name] || e.name));
      svg.append(s("rect", { x: labelW, y: y + 4, width: x(max) - labelW, height: 12, rx: 3, fill: "var(--ui-track)" }));
      const bar = s("rect", { x: labelW, y: y + 4, width: Math.max(3, x(e.visibility) - labelW), height: 12, rx: 3, fill: "var(--ui-blue)" });
      hoverable(bar, (ev) => showTip(ev, num(e.visibility, 2), e.name, [
        `Detection ${num(e.detection, 1)}% · Avg #${num(e.position, 2)}`,
        e.vs_baseline ? `${e.vs_baseline.relative_pct >= 0 ? "+" : ""}${e.vs_baseline.relative_pct}% vs baseline` : ""].filter(Boolean)));
      svg.append(bar, s("text", { x: W - 4, y: y + 14, "text-anchor": "end", class: "val" }, num(e.visibility, 2)));
    });
    tickVals.forEach((t) => svg.append(s("text", { x: x(t), y: H - 6, "text-anchor": "middle" }, String(t))));
    return el("div", { class: "ui-chart" }, svg);
  }

  function compChart(r) {
    const cols = r.competitors;
    const lastVals = r.last_report?.neutral_visibility || {};
    const W = 700, H = 320, L = 8, B = 30, T = 28, groupW = (W - L * 2) / cols.length, barW = Math.min(46, groupW / 4);
    const vals = cols.flatMap((c) => [c.visibility, lastVals[c.is_self ? "__self__" : c.short]]).filter((v) => v != null);
    const max = Math.max(10, ...vals) * 1.1;
    const ys = (v) => T + (1 - v / max) * (H - T - B);
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Neutral visibility: last report vs current" });
    svg.append(s("line", { x1: L, x2: W - L, y1: H - B, y2: H - B, stroke: "var(--ui-line)" }));
    const barPath = (x, v) => { const y = ys(v), h = H - B - y, r0 = Math.min(4, h); return `M${x},${H - B} v${-(h - r0)} a${r0},${r0} 0 0 1 ${r0},${-r0} h${barW - 2 * r0} a${r0},${r0} 0 0 1 ${r0},${r0} v${h - r0} z`; };
    cols.forEach((c, i) => {
      const cx = L + i * groupW + groupW / 2;
      const prev = lastVals[c.is_self ? "__self__" : c.short];
      const pairs = [[prev, "var(--ui-blue-soft)", r.last_report.label], [c.visibility, "var(--ui-navy)", "Current period"]];
      pairs.forEach(([v, fill, label], k) => {
        if (v == null) return;
        const x = cx - barW - 1 + k * (barW + 2);
        const b = s("path", { d: barPath(x, v), fill });
        hoverable(b, (ev) => showTip(ev, num(v, 2), `${c.is_self ? short(r.property.name) : c.short} · ${label}`, []));
        svg.append(b, s("text", { x: x + barW / 2, y: ys(v) - 6, "text-anchor": "middle", class: k ? "val" : "" }, num(v, v >= 10 ? 1 : 2)));
      });
      svg.append(s("text", { x: cx, y: H - 12, "text-anchor": "middle", class: "lbl" }, c.is_self ? short(r.property.name) : c.short.replace("InterCon ", "InterCon ")));
    });
    return el("div", { class: "ui-chart" }, svg);
  }

  function heatmapCard(r) {
    const rows = r.intent_engine;
    const intents = r.intents.map((i) => i.name);
    const engines = r.engines.map((e) => e.name);
    const short = { "Google AI Overview": "AI Overview", "Bing Copilot": "Copilot" };
    const labelW = 190, cw = 92, ch = 40, top = 30, W = labelW + engines.length * cw, H = top + intents.length * ch + 30;
    const cs = getComputedStyle(document.documentElement);
    const steps = ["--seq-0", "--seq-1", "--seq-2", "--seq-3", "--seq-4", "--seq-5", "--seq-6", "--seq-7"].map((v) => cs.getPropertyValue(v).trim());
    const lum = (hex) => { const h = hex.replace("#", ""); const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Visibility by intent and engine" });
    engines.forEach((e, j) => svg.append(s("text", { x: labelW + j * cw + cw / 2, y: top - 10, "text-anchor": "middle", class: "lbl" }, short[e] || e)));
    intents.forEach((it, i) => {
      svg.append(s("text", { x: labelW - 12, y: top + i * ch + ch / 2 + 4, "text-anchor": "end", class: "lbl" }, it));
      engines.forEach((e, j) => {
        const c = rows.find((x) => x.intent === it && x.engine === e); if (!c) return;
        const fill = steps[Math.min(7, Math.round((c.visibility / 100) * 7))];
        const rect = s("rect", { x: labelW + j * cw + 1, y: top + i * ch + 1, width: cw - 2, height: ch - 2, rx: 5, fill });
        hoverable(rect, (ev) => showTip(ev, num(c.visibility, 1), `${it} · ${e}`, [`Detection ${num(c.detection, 1)}% · ${c.answers} answers`]));
        svg.append(rect, s("text", { x: labelW + j * cw + cw / 2, y: top + i * ch + ch / 2 + 4, "text-anchor": "middle", style: `fill:${lum(fill) < 0.4 ? "#fff" : "#0b0b0b"};font-weight:600;pointer-events:none` }, num(c.visibility, 1)));
      });
    });
    svg.append(s("text", { x: labelW, y: H - 6 }, "Visibility Score: lighter = lower, darker = higher"));
    return card("Visibility by intent and engine", "Visibility Score for each guest intent on each AI engine", null, el("div", { class: "ui-chart r-scroll" }, svg));
  }

  // ------------------------------------------------------------------ insights + actions
  function insightsCard(r) {
    const name = short(r.property.name);
    const o = Object.fromEntries(r.overall.map((x) => [x.metric, x]));
    const items = [];
    const vb = o.visibility.vs_baseline;
    if (vb) items.push([vb.better ? "good" : "bad", vb.better ? "trend" : "down",
      `Full prompt set visibility is ${vb.better ? "stronger" : "weaker"}`,
      `Visibility Score ${num(o.visibility.current, 2)} (${vb.relative_pct >= 0 ? "+" : ""}${vb.relative_pct}%) vs pre-schema baseline.`]);
    if (r.intents.length) items.push(["info", "star", "Strongest intent areas", r.intents.slice(0, 3).map((i) => i.name).join(", ") + "."]);
    const nv = r.neutral_vs_benchmark.find((x) => x.metric === "visibility");
    const me = r.competitors.find((c) => c.is_self), rivals = r.competitors.filter((c) => !c.is_self);
    const leads = rivals.every((c) => (me?.visibility ?? 0) >= (c.visibility ?? 0));
    if (nv?.movement) items.push([nv.movement.better ? "good" : "warn", nv.movement.better ? "trend" : "bang",
      `Neutral competitive visibility has ${nv.movement.better ? "strengthened" : "softened"}`,
      `${name} ${leads ? "still leads the set" : "no longer leads the set"}; ${num(nv.current, 2)} vs ${nv.benchmark} at the ${r.benchmark_label}.`]);
    const behind = r.intent_competition.filter((i) => i.status === "behind");
    if (behind.length) items.push(["warn", "bang", "Where competitors are stronger", behind.map((i) => `${i.intent} (${i.leaders[0].name})`).join(", ") + "."]);
    const icons = { trend: ["M4 14 9 9l3 3 4-5", "M12 7h4v4"], down: ["M4 6l5 5 3-3 4 5", "M12 13h4V9"], star: ["M10 3.5l1.9 4 4.3.5-3.2 2.9.9 4.3L10 13l-3.9 2.2.9-4.3L3.8 8l4.3-.5z"], bang: ["M10 5v6", "M10 14.5h.01"] };
    const see = el("button", { class: "ui-link" }, "See all →"); see.addEventListener("click", () => G.openTab("intelligence"));
    return card(["Key insights ", el("small", {}, `(${monthText(r)})`)], null, see,
      ...items.map(([tone, icon, title, text]) => el("div", { class: "insight" },
        el("div", { class: "ic " + tone }, svgIcon(icons[icon], "#fff")), el("div", {}, el("b", {}, title), el("span", {}, text)))));
  }

  async function actionsCard(r) {
    let recs = [];
    try { recs = await api(`/api/recommendations?property_id=${G.state.propertyId}&limit=50`); } catch { recs = []; }
    const order = { high: 0, medium: 1, low: 2 };
    recs = recs.filter((x) => x.status !== "rejected" && x.status !== "done").sort((a, b) => order[a.priority] - order[b.priority]).slice(0, 4);
    let rows = recs.map((x) => el("div", { class: "action" }, el("span", { class: "box" }),
        el("div", {}, x.title, el("small", {}, `${x.intent} · ${x.engine} · ${x.status}`)), el("span", { class: "pri " + x.priority }, x.priority)));
    if (rows.length < 4) {   // top up with suggestions from this period's data
      const derived = [];
      r.intent_competition.filter((i) => i.status === "behind").forEach((i) =>
        derived.push([`Diagnose why ${i.leaders[0].name} wins ${i.intent}`, "Open an answer in Evidence & Diagnosis and run the agent", "high"]));
      r.sources.missing.slice(0, 2).forEach((m) => derived.push([`Get ${short(r.property.name)} cited on ${m.domain}`, `${m.for_competitors} citations for competitors, none for the hotel`, "medium"]));
      derived.push(["Track whether the softening in neutral competitive visibility persists", "Compare next period against the benchmark", "low"]);
      rows = rows.concat(derived.slice(0, 4 - rows.length).map(([t, sub, p]) => el("div", { class: "action" }, el("span", { class: "box" }), el("div", {}, t, el("small", {}, `Suggested · ${sub}`)), el("span", { class: "pri " + p }, p))));
    }
    const all = el("button", { class: "ui-link" }, "View all →"); all.addEventListener("click", () => G.openTab("recommendations"));
    return card("Next actions", recs.length ? "Agent recommendations first, then suggestions from this period's data" : "Suggested from this period's data", all, ...rows);
  }

  function intentSnapshot(r) {
    const name = short(r.property.name);
    const max = Math.max(1, ...r.intent_competition.flatMap((i) => [i.coogee, ...i.leaders.map((l) => l.visibility)]));
    const bar = (v, color) => el("span", { style: "white-space:nowrap" },
      el("span", { style: `display:inline-block;height:8px;border-radius:4px;vertical-align:middle;margin-right:8px;width:${Math.max(3, Math.round((v / max) * 110))}px;background:${color}` }), num(v, 1));
    const more = el("button", { class: "ui-link" }, "Intent analysis →"); more.addEventListener("click", () => G.openTab("intents"));
    return card("Where " + name + " wins by intent", "Neutral prompt set · Visibility Score vs the strongest tracked competitor", more,
      RP.rtable(["Intent", name, "Strongest competitor", ""],
        r.intent_competition.map((i) => [i.intent, bar(i.coogee, "var(--ui-blue)"),
          el("span", {}, `${i.leaders[0]?.name || "–"} `, i.leaders[0] ? bar(i.leaders[0].visibility, "var(--ui-blue-soft)") : ""),
          el("span", { class: "pri " + (i.status === "lead" ? "low" : "high"), style: "font-size:11.5px;font-weight:700;border-radius:999px;padding:2px 9px;white-space:nowrap;" + (i.status === "lead" ? "background:#e3f5ea;color:var(--ui-good)" : "background:#fdeaea;color:var(--ui-bad)") }, i.status === "lead" ? "Leading" : "Behind")]), { left: [2] }));
  }

  // ------------------------------------------------------------------ pages
  async function withReport(rootSel, build) {
    const box = $(rootSel); if (!box) return;
    box.style.opacity = 0.55;
    let r;
    try { r = await RP.getReport(); }
    catch (e) { box.replaceChildren(el("div", { class: "report bad" }, `Couldn't load data from Supabase: ${e.message}`)); box.style.opacity = 1; return; }
    if (!r) { box.style.opacity = 1; return; }
    if (r.empty) { box.replaceChildren(el("div", { class: "empty" }, "No data yet — upload a Rankscale export (Data & Uploads).")); box.style.opacity = 1; return; }
    window.setPageHead(currentPage(), r);
    const nodes = await build(r, short(r.property.name));
    box.replaceChildren(...[].concat(nodes).filter(Boolean));
    box.style.opacity = 1;
  }

  const pages = {
    overview: () => withReport("#overview-root", async (r) => {
      const benchNote = el("div", { class: "ui-note" }, r.insights.qualification[0] || "");
      return [
        el("div", { class: "ov-kpis" }, ...["visibility", "detection", "position", "sentiment"].map((m) => kpiCard(r.overall.find((o) => o.metric === m)))),
        el("div", { class: "ov-row" }, trendCard(r),
          card("Visibility by AI engine", `Full set · ${r.prompt_sets.full} prompts`, null, engineBars(r))),
        el("div", { class: "ov-row top" },
          el("div", { class: "ov-stack" },
            card("Competitive benchmark", `${r.prompt_sets.neutral} neutral prompts · Current vs ${r.last_report.label}`,
              el("div", { class: "ui-legend" }, el("span", {}, el("i", { style: "background:var(--ui-blue-soft)" }), r.last_report.label), el("span", {}, el("i", { style: "background:var(--ui-navy)" }), "Current period")),
              compChart(r), benchNote),
            intentSnapshot(r)),
          el("div", { class: "ov-stack" }, insightsCard(r), await actionsCard(r))),
      ];
    }),
    intelligence: () => withReport("#intel-root", (r, n) => {
      const S = RP.sections;
      return [S.execOverview(r, n), S.promptSets(r, n), S.whySection(r), S.engagement()];
    }),
    engines: () => withReport("#engines-root", (r) => [
      el("div", { class: "ov-kpis" }, ...["visibility", "detection", "position", "top3"].map((m) => kpiCard(r.overall.find((o) => o.metric === m)))),
      el("div", { class: "ov-row even" },
        card("Visibility by AI engine", `Full set · ${r.prompt_sets.full} prompts · ${RP.fmtRange(r.period.from, r.period.to)}`, null, engineBars(r, true)),
        card("Engine scorecard", "Movement is relative to the pre-schema baseline and the previous period of the same length", null,
          RP.rtable(["Engine", "Visibility", "Detection", "Avg position", "Top 3", "Δ baseline", "Δ prev."],
            r.engines.map((e) => [e.name, num(e.visibility, 2), `${num(e.detection, 1)}%`, e.position ? `#${num(e.position, 2)}` : "–", `${num(e.top3, 1)}%`, RP.signedPct(e.vs_baseline), RP.signedPct(e.vs_previous)])))),
      heatmapCard(r),
    ]),
    competitive: () => withReport("#comp-root", (r, n) => [
      card("Competitive benchmark", `${r.prompt_sets.neutral} neutral prompts · Current vs ${r.last_report.label}`,
        el("div", { class: "ui-legend" }, el("span", {}, el("i", { style: "background:var(--ui-blue-soft)" }), r.last_report.label), el("span", {}, el("i", { style: "background:var(--ui-navy)" }), "Current period")),
        compChart(r)),
      el("div", { style: "height:18px" }),
      ...RP.sections.competitive(r, n),
    ]),
    intents: () => withReport("#intents-root", (r, n) => [
      el("div", { class: "ov-row even" },
        card("Visibility by search intent", "Full prompt set", null,
          RP.rtable(["Search intent", "Visibility", "Detection", "Avg position", "Δ baseline", "Δ prev."],
            r.intents.map((e) => [e.name, num(e.visibility, 2), `${num(e.detection, 1)}%`, e.position ? `#${num(e.position, 2)}` : "–", RP.signedPct(e.vs_baseline), RP.signedPct(e.vs_previous)]))),
        heatmapCard(r)),
      el("div", { style: "height:18px" }),
      RP.sections.intentSection(r, n),
    ]),
    evidence: () => withReport("#evidence-root", async (r, n) => {
      renderAggregatedInsights(r);
      return [RP.sections.sourcesSection(r, n)];
    }),
    reports: () => withReport("#reports-noop", () => []),
    settings: () => settingsPage(),
  };

  async function renderAggregatedInsights(report) {
    const list = $("#aggregated-insights-list");
    const detail = $("#aggregated-insight-evidence");
    const period = `date_from=${encodeURIComponent(String(report.period.from).slice(0, 10))}&date_to=${encodeURIComponent(String(report.period.to).slice(0, 10))}`;
    const metricValue = (value, suffix = "") => value == null ? "–" : `${num(value, 2)}${suffix}`;
    const escDate = (value) => new Date(value).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
    async function load() {
      const rows = await api(`/api/insights/${G.state.propertyId}?${period}`);
      if (!rows.length) {
        list.replaceChildren(el("div", { class: "empty" }, "No aggregated insights for this period yet. Generate insights to calculate them from stored measurements."));
        return;
      }
      list.replaceChildren(...rows.map((insight) => {
        const metrics = insight.metrics || {};
        const isIntent = insight.insight_type === "INTENT_WEAKNESS";
        const cards = [
          ["Detection Rate", metricValue(metrics.detection, "%")],
          ["Visibility Score", metricValue(metrics.visibility_score)],
          ...(metrics.competitor_detection != null ? [["Competitor Detection", metricValue(metrics.competitor_detection, "%")]] : []),
          ...(metrics.visibility_gap != null ? [["Gap", `${metrics.visibility_gap > 0 ? "+" : ""}${num(metrics.visibility_gap * (Math.abs(metrics.visibility_gap) <= 1 ? 100 : 1), 1)}${Math.abs(metrics.visibility_gap) <= 1 ? "pp" : " points"}`]] : []),
          ["Measurements", num(insight.measurement_count)],
        ];
        const view = el("button", { type: "button", class: "secondary" }, "View Evidence");
        view.addEventListener("click", async () => {
          view.disabled = true;
          try { renderInsightEvidence(await api(`/api/insights/item/${insight.id}/evidence`)); }
          catch (error) { detail.replaceChildren(el("div", { class: "report bad" }, error.message)); }
          finally { view.disabled = false; }
        });
        return el("article", { class: "rec aggregated-insight" },
          el("div", { class: "meta" }, el("span", { class: "pill" }, insight.insight_type.replaceAll("_", " ")),
            el("span", { class: "pill" }, `${escDate(insight.period_start)} – ${escDate(insight.period_end)}`)),
          el("h3", {}, insight.title), el("p", {}, insight.summary),
          el("div", { class: "ov-kpis" }, ...cards.map(([label, value]) => el("div", { class: "kpi-card" },
            el("div", { class: "k-label" }, label), el("div", { class: "k-value" }, value)))),
          isIntent ? el("p", { class: "muted" }, `Neutral-prompt competitor comparison · ${metrics.competitor || "tracked competitor"}`) : null,
          view);
      }));
    }
    const button = $("#btn-insights-generate");
    button.onclick = async () => {
      button.disabled = true;
      button.textContent = "Calculating…";
      try {
        await api("/api/insights/generate", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ property_id: G.state.propertyId, date_from: String(report.period.from).slice(0, 10),
            date_to: String(report.period.to).slice(0, 10) }) });
        await load();
      } catch (error) { list.replaceChildren(el("div", { class: "report bad" }, error.message)); }
      finally { button.disabled = false; button.textContent = "Generate insights"; }
    };
    await load();
  }

  function renderInsightEvidence(packageData) {
    const detail = $("#aggregated-insight-evidence");
    const metrics = packageData.metrics || {};
    const engineRows = packageData.engine_breakdown || [];
    const intentRows = packageData.intent_breakdown || [];
    const competitorRows = packageData.competitors || [];
    const measurementRows = packageData.relevant_measurements || [];
    const citationRows = packageData.citations || [];
    const table = (headers, rows) => RP.rtable(headers, rows);
    const asText = (v) => v == null ? "–" : String(v);
    detail.replaceChildren(
      el("article", { class: "rec" },
        el("div", { class: "meta" }, el("span", { class: "pill" }, "Evidence package"),
          el("span", { class: "pill" }, `${num(packageData.measurement_count)} supporting measurements${packageData.measurements_truncated ? ` · showing ${num(packageData.measurements_returned)}` : ""}`)),
        el("h3", {}, packageData.insight.title), el("p", {}, packageData.insight.summary),
        el("p", { class: "muted" }, `Calculated metrics: ${JSON.stringify(metrics)}`),
        el("h3", {}, "ENGINE BREAKDOWN"), table(["Engine", "Answers", "Detection", "Visibility", "Average position", "Top 3", "Sentiment"],
          engineRows.map((r) => [r.name || r.engine, num(r.answers), `${num(r.detection, 1)}%`, num(r.visibility, 2), r.position == null ? "–" : `#${num(r.position, 2)}`, `${num(r.top3, 1)}%`, num(r.sentiment, 1)])),
        el("h3", {}, "INTENT BREAKDOWN"), table(["Intent", "Answers", "Detection", "Visibility", "Average position", "Top 3", "Sentiment"],
          intentRows.map((r) => [r.name || r.intent, num(r.answers), `${num(r.detection, 1)}%`, num(r.visibility, 2), r.position == null ? "–" : `#${num(r.position, 2)}`, `${num(r.top3, 1)}%`, num(r.sentiment, 1)])),
        el("h3", {}, "COMPETITORS"), table(["Competitor", "Appearances", "Detection", "Visibility"],
          competitorRows.map((r) => [r.display_name || r.name, num(r.appearances ?? r.answers), `${num(r.detection, 1)}%`, num(r.visibility, 2)])),
        el("h3", {}, "RELEVANT MEASUREMENTS"), table(["Prompt", "Engine", "Detected", "Position", "Score", "Date"],
          measurementRows.map((r) => [r.prompt, r.engine, r.detected ? "Yes" : "No", r.position == null ? "–" : `#${r.position}`, num(r.visibility_score, 2), r.measured_at ? new Date(r.measured_at).toLocaleDateString("en-AU") : "–"])),
        el("h3", {}, "CITATIONS"), table(["Domain", "Count", "Hotel", "Competitors", "Source type"],
          citationRows.map((r) => [r.domain, num(r.count), num(r.for_hotel), num(r.for_competitors), r.source_type || "Other"])),
        el("h3", {}, "SUPPORTING MEASUREMENT IDS"), el("p", { class: "muted" }, measurementRows.map((r) => asText(r.measurement_id)).join(", "))));
  }

  async function settingsPage() {
    const box = $("#settings-root");
    const pid = G.state.propertyId; if (!pid) return;
    const [st, bms] = await Promise.all([api(`/api/report/${pid}/settings`), api(`/api/report/${pid}/benchmarks`)]);
    const chips = (arr) => el("div", {}, ...(arr || []).map((a) => el("span", { class: "chip" }, a)));
    const form = el("form", { class: "row", style: "margin-top:12px" });
    const metric = el("select", {}, ...["visibility", "detection", "position", "top3", "sentiment"].map((m) => el("option", { value: m }, RP.METRIC_LABEL[m])));
    const pset = el("select", {}, el("option", { value: "full" }, "Full set"), el("option", { value: "neutral" }, "Neutral set"));
    const val = el("input", { type: "number", step: "0.01", required: true, placeholder: "e.g. 50" });
    const label = el("input", { value: "Target", required: true });
    const msg = el("span", { class: "muted" });
    form.append(el("label", {}, "Label", label), el("label", {}, "Prompt set", pset), el("label", {}, "Metric", metric), el("label", {}, "Value", val),
      el("button", { type: "submit" }, "Save benchmark"), msg);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await api(`/api/report/${pid}/benchmarks`, { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label.value, kind: label.value.toLowerCase().includes("target") ? "target" : "benchmark", prompt_set: pset.value, metric: metric.value, value: Number(val.value) }) });
      msg.textContent = "Saved"; G.rstate.key = null; settingsPage();
    });
    box.replaceChildren(
      el("div", { class: "settings-grid" },
        card("Tracked competitor set", "Edit in Supabase → competitor_groups. Names are matched exactly; a trailing * means “starts with”.", null,
          RP.rtable(["Competitor", "Names engines use"], st.competitor_groups.map((g) => [g.display_name || g.name, chips(g.aliases)]), { left: [1] })),
        card("Hotel names", "Every name that counts as the hotel, and names ignored entirely (properties table).", null,
          el("h4", {}, "Counts as the hotel"), chips(st.property?.aliases), el("h4", {}, "Ignored"), chips(st.property?.ignored_names),
          el("h4", {}, "Own domains"), chips(st.property?.own_domains))),
      el("div", { style: "height:18px" }),
      el("div", { class: "settings-grid" },
        card("Neutral prompt set", `${st.prompts.filter((p) => p.is_neutral).length} of ${st.prompts.length} tracked prompts are neutral. A prompt containing any of these terms is brand/location-specific:`, null,
          chips(st.neutral_exclusion_terms),
          el("details", {}, el("summary", {}, "See which prompts are neutral"),
            RP.rtable(["Prompt", "Intent", "Neutral"], st.prompts.map((p) => [p.prompt_text, p.intent, p.is_neutral ? "Yes" : "No"]), { left: [0] }))),
        card("AI model for the agents", "Set in .env on the server.", null,
          RP.rtable(["Setting", "Value"], [["Provider", st.llm.provider], ["Model", st.llm.model], ["API key", st.llm.key_set ? "Set" : "Missing — agents won't run"]]))),
      el("div", { style: "height:18px" }),
      card("Benchmarks and targets", "Baselines marked derived were back-calculated from the Aug 2026 report's movements. Add a target to track progress against it.", null,
        RP.rtable(["Label", "Set", "Dimension", "Metric", "Value", "Derived"], bms.map((b) => [b.label, b.prompt_set, b.dim_key || b.dimension, RP.METRIC_LABEL[b.metric], num(b.value, 2), b.is_derived ? "Yes" : ""])),
        form));
  }

  window.renderPage = (name) => { const f = pages[name]; if (f) f(); };
  // keep the report cache in step with the property picker
  $("#property").addEventListener("change", () => { if (G.rstate) G.rstate.key = null; });
})();
