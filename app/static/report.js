/* Report tab — the monthly Komosion GEO report, rendered live from Supabase via /api/report.
   Layout follows the Aug 2026 PDF report section by section. All data text goes in via
   textContent (the el() helper), never innerHTML. */
"use strict";
(() => {
  const G = window.GEO;
  const { el, s, api, pct, num, fmtDate, store, showTip, hideTip, hoverable } = G;
  const R = G.rstate = { names: store("geo.names") || "rankscale", preset: "last30", from: null, to: null, data: null, key: null, pending: null };
  const METRIC_LABEL = { visibility: "Visibility Score", detection: "Detection Rate", position: "Average Position",
                         top3: "Top 3", sentiment: "Sentiment Score" };
  const root = () => document.getElementById("report-root");
  const shortName = (n) => (n && n.includes("Coogee") ? "Coogee" : n);

  const fmtVal = (m, v) => (v == null ? "–" : m === "position" ? `#${num(v, 2)}` : num(v, 2));
  const fmtRange = (a, b) => `${fmtDate(a)} – ${new Date(b).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}`;

  function moveText(mv, metric, style = "relative") {
    if (!mv) return el("span", { class: "flat" }, "–");
    const p = Math.abs(mv.relative_pct);
    const cls = mv.better == null ? "flat" : mv.better ? "up" : "down";
    if (style === "arrow") return el("span", { class: cls }, `${mv.better === false ? "▼" : "▲"} ${p}%`);
    if (metric === "position") return el("span", { class: cls }, `${mv.better ? "Improved" : "Declined"} ${p}% relative`);
    return el("span", { class: cls }, `${mv.relative_pct > 0 ? "+" : "−"}${p}% relative`);
  }
  function signedPct(mv) {
    if (!mv) return el("span", { class: "flat" }, "–");
    const cls = mv.better == null ? "flat" : mv.better ? "up" : "down";
    return el("span", { class: cls, style: "font-weight:600" }, `${mv.relative_pct > 0 ? "+" : mv.relative_pct < 0 ? "−" : ""}${Math.abs(mv.relative_pct)}%`);
  }
  function interpret(o, name) {
    const b = o.vs_baseline?.better;
    switch (o.metric) {
      case "visibility": return b === false ? "Overall AI visibility is weaker." : "Overall AI visibility is stronger.";
      case "detection": return b === false ? `${name} appears in fewer relevant AI answers.` : `${name} appears in more relevant AI answers.`;
      case "position": return (o.current ?? 9) <= 2.5 ? `When ${name} appears, it is typically near the top.` : `${name} tends to appear lower in answers.`;
      case "top3": return `Share of answers with ${name} ranked in the top 3.`;
      case "sentiment": return (o.current ?? 0) >= 80 ? "AI descriptions remain strongly positive." : "AI descriptions are mixed; check sentiment reasons.";
    }
    return "";
  }
  function rtable(headers, rows, opts = {}) {
    const t = el("table", { class: "r-table" });
    t.append(el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", {}, ...(Array.isArray(h) ? [h[0], el("span", { class: "small" }, h[1])] : [h]))))));
    const tb = el("tbody");
    rows.forEach((r, i) => {
      const tr = el("tr", { class: opts.selfRow === i ? "self" : "" });
      r.forEach((c, j) => tr.append(el("td", { class: (opts.left || []).includes(j) ? "left" : (opts.num || []).includes(j) ? "num" : "" }, c)));
      tb.append(tr);
    });
    t.append(tb);
    return el("div", { class: "r-scroll" }, t);
  }
  const section = (id, eyebrow, title, lede, ...body) =>
    el("section", { class: "r-section page", id }, eyebrow ? el("div", { class: "r-eyebrow" }, eyebrow) : null,
      el("h2", {}, title), lede ? el("p", { class: "lede" }, lede) : null, ...body);

  // ------------------------------------------------------------------ controls
  function monthsBetween(a, b) {
    const out = []; const d = new Date(a); d.setDate(1); const end = new Date(b);
    while (d <= end) { out.push(new Date(d)); d.setMonth(d.getMonth() + 1); }
    return out;
  }
  // ------------------------------------------------------------------ chart: visibility over time
  function trendChart(r) {
    const pts = r.trend; const base = r.baseline_visibility;
    if (!pts.length) return el("div", { class: "empty" }, "No trend data");
    const W = 1100, H = 250, L = 46, Rr = 24, T = 30, B = 32;
    const vals = pts.map((p) => p.visibility).concat(base != null ? [base] : []);
    const lo = Math.max(0, Math.floor((Math.min(...vals) - 5) / 5) * 5), hi = Math.ceil((Math.max(...vals) + 3) / 5) * 5;
    const xs = (i) => L + (pts.length === 1 ? (W - L - Rr) / 2 : (i * (W - L - Rr)) / (pts.length - 1));
    const ys = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Visibility Score over time" });
    svg.append(s("text", { x: L + 8, y: 18, class: "title" }, "Visibility Score over time"));
    for (let v = lo; v <= hi; v += 5) {
      svg.append(s("line", { x1: L, x2: W - Rr, y1: ys(v), y2: ys(v), stroke: v === lo ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }));
      svg.append(s("text", { x: L - 8, y: ys(v) + 4, "text-anchor": "end" }, String(v)));
    }
    // shade the reporting period
    const inP = pts.map((p, i) => [p, i]).filter(([p]) => p.day >= String(r.period.from).slice(0, 10) && p.day <= String(r.period.to).slice(0, 10));
    if (inP.length && inP.length < pts.length) {
      const x0 = xs(inP[0][1]) - 6, x1 = xs(inP[inP.length - 1][1]) + 6;
      svg.append(s("rect", { x: x0, y: T, width: Math.max(4, x1 - x0), height: H - T - B, fill: "var(--series-1)", opacity: 0.06 }));
    }
    const line = pts.map((p, i) => `${i ? "L" : "M"}${xs(i)},${ys(p.visibility)}`).join("");
    svg.append(s("path", { d: `${line}L${xs(pts.length - 1)},${ys(lo)}L${xs(0)},${ys(lo)}Z`, fill: "var(--series-1)", opacity: 0.16 }));
    svg.append(s("path", { d: line, fill: "none", stroke: "var(--series-1)", "stroke-width": 2, "stroke-linejoin": "round" }));
    if (base != null) {
      svg.append(s("line", { x1: L, x2: W - Rr, y1: ys(base), y2: ys(base), stroke: "var(--k-red)", "stroke-width": 1.5, "stroke-dasharray": "8 6" }));
      svg.append(s("text", { x: W - Rr - 4, y: ys(base) + 16, "text-anchor": "end", style: "fill:var(--k-red);font-weight:600" }, `Pre-schema baseline ${num(base, 2)}`));
    }
    const last = pts.length - 1;
    svg.append(s("circle", { cx: xs(last), cy: ys(pts[last].visibility), r: 4, fill: "var(--series-1)", stroke: "var(--surface)", "stroke-width": 2 }));
    svg.append(s("text", { x: xs(last) - 8, y: ys(pts[last].visibility) - 10, "text-anchor": "end", class: "ink" }, num(pts[last].visibility, 1)));
    const step = Math.max(1, Math.ceil(pts.length / 8));
    pts.forEach((p, i) => { if (i % step === 0 || i === last) svg.append(s("text", { x: xs(i), y: H - 10, "text-anchor": "middle" }, fmtDate(p.day))); });
    const cross = s("line", { y1: T, y2: H - B, stroke: "var(--axis)", visibility: "hidden" });
    const hit = s("rect", { x: L, y: T, width: W - L - Rr, height: H - T - B, fill: "transparent" });
    svg.append(cross, hit);
    hit.addEventListener("pointermove", (ev) => {
      const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
      const x = pt.matrixTransform(svg.getScreenCTM().inverse()).x;
      let i = 0, best = 1e9; pts.forEach((_, n) => { const d = Math.abs(xs(n) - x); if (d < best) { best = d; i = n; } });
      cross.setAttribute("x1", xs(i)); cross.setAttribute("x2", xs(i)); cross.setAttribute("visibility", "visible");
      const p = pts[i];
      showTip(ev, num(p.visibility, 2), `Visibility · run of ${fmtDate(p.day)}`,
        [`Detection ${num(p.detection, 1)}% · Top 3 ${num(p.top3, 1)}%`, `${p.answers} AI answers`]);
    });
    hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
    return el("div", { class: "r-chart" }, svg);
  }

  // ------------------------------------------------------------------ chart: source categories
  function categoryChart(cats) {
    const W = 560, labelW = 170, barH = 11, gap = 16, T = 6;
    const H = T + cats.length * (barH * 2 + 2 + gap);
    const max = Math.max(1, ...cats.map((c) => Math.max(c.share, c.share_for_hotel)));
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Citation share by source type" });
    const bar = (x, y, w, fill) => s("path", { d: `M${x},${y} h${Math.max(0, w - 3)} a3,3 0 0 1 3,3 v${barH - 6} a3,3 0 0 1 -3,3 h${-Math.max(0, w - 3)} z`, fill, class: "bar" });
    cats.forEach((c, i) => {
      const y = T + i * (barH * 2 + 2 + gap);
      svg.append(s("text", { x: labelW - 10, y: y + barH + 4, "text-anchor": "end", class: "ink" }, c.category));
      const w1 = (c.share / max) * (W - labelW - 50), w2 = (c.share_for_hotel / max) * (W - labelW - 50);
      const b1 = bar(labelW, y, Math.max(2, w1), "var(--series-1)");
      const b2 = bar(labelW, y + barH + 2, Math.max(2, w2), "var(--series-2)");
      hoverable(b1, (ev) => showTip(ev, `${c.share}%`, `${c.category} · all citations`, [`${num(c.citations)} citations · ${c.domains} domains`]));
      hoverable(b2, (ev) => showTip(ev, `${c.share_for_hotel}%`, `${c.category} · cited for the hotel`, [`${num(c.for_hotel)} citations`]));
      svg.append(b1, b2,
        s("text", { x: labelW + Math.max(2, w1) + 6, y: y + barH - 1, class: "ink2" }, `${c.share}%`),
        s("text", { x: labelW + Math.max(2, w2) + 6, y: y + barH * 2 + 1, class: "ink2" }, `${c.share_for_hotel}%`));
    });
    return el("div", { class: "r-chart" }, svg,
      el("div", { class: "legend" },
        el("span", {}, el("i", { class: "box", style: "background:var(--series-1)" }), "Share of all citations in these answers"),
        el("span", {}, el("i", { class: "box", style: "background:var(--series-2)" }), "Share of citations Rankscale ties to the hotel")));
  }

  // ------------------------------------------------------------------ sections
  function hero(r) {
    return el("div", { class: "r-hero" },
      el("div", { class: "prop" }, r.property.name),
      el("h1", {}, "GEO-AI Discoverability Program"),
      el("div", { class: "meta" }, `Performance report · ${fmtRange(r.period.from, r.period.to)} · ${num(r.overall_answers)} AI answers across ${r.engines.length} engines`),
      el("div", { class: "rule" }),
      el("div", { class: "print-only r-cover-foot" }, el("span", { class: "wordmark" }, "komosion", el("i")),
        el("div", { class: "tagline" }, "Helping organisations use AI to be more efficient and effective.")));
  }

  function nav() {
    const links = [["r-exec", "Executive overview"], ["r-perf", "Performance"], ["r-sets", "Prompt sets"], ["r-comp", "Competitive position"],
                   ["r-intent", "Intent intelligence"], ["r-why", "Why AI chooses"], ["r-sources", "Source intelligence"], ["r-engage", "Engagement"]];
    return el("nav", { class: "r-nav", "aria-label": "Report sections" },
      ...links.map(([id, t]) => el("a", { href: "#" + id, onclick: (e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }); } }, t)));
  }

  function execOverview(r, name) {
    const note = r.notes.monitor_next;
    const ta = el("textarea", { "aria-label": "What we'll monitor next" });
    ta.value = note ? note.body : "Whether the softening in neutral competitive visibility persists.\nWhere Coogee leads and where competitors are stronger.\nEngagement and conversion measures once GTM/GA4 access is available.";
    const saved = el("div", { class: "saved" }, note ? `Saved by ${note.updated_by || "someone"} · ${fmtDate(note.updated_at)}` : "Draft — edit and it saves for this period");
    let t;
    ta.addEventListener("input", () => {
      clearTimeout(t); saved.textContent = "Saving…";
      t = setTimeout(async () => {
        await api(`/api/report/${G.state.propertyId}/notes`, { method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ period_key: r.period.key, section: "monitor_next", body: ta.value, updated_by: store("geo.reviewer") || null }) });
        saved.textContent = "Saved";
      }, 700);
    });
    return section("r-exec", null, "Executive overview", null,
      trendChart(r),
      el("div", { class: "r-cards3" },
        el("div", { class: "r-card" }, el("h4", {}, "1. The good news"), el("ul", {}, ...r.insights.good_news.map((x) => el("li", {}, x)))),
        el("div", { class: "r-card grey" }, el("h4", {}, "2. The qualification"), el("ul", {}, ...r.insights.qualification.map((x) => el("li", {}, x)))),
        el("div", { class: "r-card plain" }, el("h4", {}, "3. What we'll monitor next"), ta, saved)));
  }

  function performance(r, name) {
    const o = Object.fromEntries(r.overall.map((x) => [x.metric, x]));
    const tile = (m) => el("div", { class: "r-kpi" },
      el("div", { class: "label" }, METRIC_LABEL[m]),
      el("div", { class: "value" }, m === "position" ? num(o[m].current, 2) : num(o[m].current, 2)),
      el("div", { class: "delta" }, moveText(o[m].vs_baseline, m, "arrow")),
      el("div", { class: "sub" }, o[m].vs_last_report ? ["vs last report ", signedPct(o[m].vs_last_report)] : "vs pre-schema baseline"));
    const engineRows = r.engines.map((e) => [e.name, num(e.visibility, 2), signedPct(e.vs_baseline), signedPct(e.vs_previous)]);
    const intentRows = r.intents.map((e) => [e.name, num(e.visibility, 2), signedPct(e.vs_baseline), signedPct(e.vs_previous)]);
    const best = r.engines[0];
    const movers = r.engines.filter((e) => e.vs_baseline);
    const up = movers.filter((e) => e.vs_baseline.better).sort((a, b) => b.vs_baseline.relative_pct - a.vs_baseline.relative_pct);
    const down = movers.filter((e) => e.vs_baseline.better === false).map((e) => e.name);
    return section("r-perf", "Brand-aware + location-aware measurement", `Performance overview: full ${name} prompt set`,
      `This view measures ${name}'s overall discoverability across the full ${r.prompt_sets.full}-prompt set. Reporting period: ${fmtRange(r.period.from, r.period.to)}. Movement is relative to the ${r.baseline_label.toLowerCase()}.`,
      el("div", { class: "r-kpis" }, ...["visibility", "detection", "position", "top3", "sentiment"].map(tile)),
      rtable(["Metric", "Current", "Baseline", "Movement", "Interpretation"],
        r.overall.filter((x) => x.metric !== "top3").map((x) => [METRIC_LABEL[x.metric], fmtVal(x.metric, x.current),
          x.vs_baseline ? fmtVal(x.metric, x.vs_baseline.reference) : "–", moveText(x.vs_baseline, x.metric), interpret(x, name)]), { left: [4] }),
      el("div", { class: "r-callout center" },
        el("strong", {}, up.length >= down.length ? "AI visibility has strengthened across the full tracking set." : "AI visibility has softened across the full tracking set."),
        el("div", {}, el("strong", {}, "Engine view: "),
          `${best?.name} remains strongest (${num(best?.visibility, 2)}).` +
          (up.length ? ` ${up[0].name} recorded the strongest improvement (+${up[0].vs_baseline.relative_pct}% relative)` : "") +
          (down.length ? `, while ${down.join(", ")} softened during the period.` : "."))),
      el("div", { class: "r-grid2", style: "margin-top:18px" },
        el("div", {}, el("h3", {}, "Visibility Score by AI Engine"), rtable(["Engine", "Visibility Score", "% Δ baseline", "% Δ prev. period"], engineRows)),
        el("div", {}, el("h3", {}, "Visibility Score by Search Intent Category"), rtable(["Search Intent", "Visibility Score", "% Δ baseline", "% Δ prev. period"], intentRows))));
  }

  function promptSets(r, name) {
    const nb = Object.fromEntries(r.neutral_vs_benchmark.map((x) => [x.metric, x]));
    const me = r.competitors.find((c) => c.is_self);
    const rivals = r.competitors.filter((c) => !c.is_self);
    const leads = rivals.every((c) => (me?.visibility ?? 0) >= (c.visibility ?? 0));
    const soft = nb.visibility?.movement && nb.visibility.movement.better === false;
    return section("r-sets", null, "Performance across prompt sets", null,
      el("div", { class: "r-grid2" },
        el("div", {}, el("h3", {}, `1. Full ${name} tracking set`), el("ul", {},
          el("li", {}, `${r.prompt_sets.full} prompts retained for single-property tracking.`),
          el("li", {}, `Includes brand- and location-specific prompts such as ${name} Beach.`),
          el("li", {}, `Answers: "Is ${name} becoming clearer and more visible to AI?"`),
          el("li", {}, `Current answer: ${r.overall[0].vs_baseline?.better ? "yes — stronger than the pre-schema baseline" : "not yet — below the pre-schema baseline"} (${num(r.overall[0].current, 2)} vs ${num(r.baseline_visibility, 2)}).`))),
        el("div", {}, el("h3", {}, "2. Neutral competitor set"), el("ul", {},
          el("li", {}, `${r.prompt_sets.neutral} broad prompts used for like-for-like comparison across competitors.`),
          el("li", {}, `Excludes brand/location prompts that would unfairly favour ${name}.`),
          el("li", {}, `Answers: "When AI chooses between credible Sydney hotels, does it select ${name}?"`),
          el("li", {}, `Current answer: ${leads ? `${name} still leads` : `${name} does not lead`}${soft ? ` — but its lead has softened since the ${r.benchmark_label.replace(" benchmark", "")} benchmark` : ""}.`)))),
      el("div", { class: "r-callout center" }, el("strong", {}, `AI understands ${name} increasingly well when the context points toward ${name}.`),
        el("div", {}, el("strong", {}, "The next area to monitor is unaided competitive selection."))));
  }

  function competitive(r, name) {
    const cols = r.competitors;
    const metrics = ["visibility", "detection", "position", "top3", "sentiment"];
    const head = ["Metric", ...cols.map((c) => c.is_self ? name : c.name.includes("(") ? [c.short, c.name.slice(c.name.indexOf("("))] : c.short)];
    const rows = metrics.map((m) => [METRIC_LABEL[m] === "Top 3" ? "Top 3" : METRIC_LABEL[m], ...cols.map((c) => fmtVal(m, c[m]))]);
    const me = cols.find((c) => c.is_self);
    const rivals = cols.filter((c) => !c.is_self).sort((a, b) => (b.visibility ?? 0) - (a.visibility ?? 0));
    const behind = r.intent_competition.filter((i) => i.status === "behind");
    const threat = rivals[0];
    const threatIntents = behind.filter((i) => i.leaders.some((l) => l.name === threat?.short)).map((i) => i.intent);
    const nb = r.neutral_vs_benchmark;
    return [
      section("r-comp", `Neutral ${r.prompt_sets.neutral}-prompt benchmark`, "Current competitive position",
        `${(me?.visibility ?? 0) >= (threat?.visibility ?? 0) ? `${name} remains the strongest property` : `${threat?.short} leads`} in the selected competitive set across the headline measures. Reporting period: ${fmtRange(r.period.from, r.period.to)}.`,
        rtable(head, rows),
        el("div", { class: "r-callout" }, el("strong", {}, "Interpretation"), el("ul", {},
          el("li", {}, (me?.visibility ?? 0) >= (threat?.visibility ?? 0) ? `${name} is still the leading AI-recommended property in this competitor set.` : `${threat?.short} is currently ahead of ${name} in this competitor set.`),
          threat ? el("li", {}, `${threat.short} is the clearest competitive threat${threatIntents.length ? `, especially in ${threatIntents.join(" and ")}` : ""}.`) : null,
          el("li", {}, "AI results remain dynamic and should be assessed over repeated reporting periods.")))),
      section("r-bench", `${r.benchmark_label} vs current report`, (nb.find((x) => x.metric === "visibility")?.movement?.better === false) ? "Neutral visibility has softened" : "Neutral visibility vs benchmark",
        `How ${name}'s unaided visibility compares with the ${r.benchmark_label}.`,
        rtable(["Metric", r.benchmark_label.replace(" benchmark", ""), "Current", "Movement", "Implication"],
          nb.map((x) => [METRIC_LABEL[x.metric], fmtVal(x.metric, x.benchmark), fmtVal(x.metric, x.current), moveText(x.movement, x.metric),
            ({ visibility: x.movement?.better === false ? "May reflect prompt/source movement or normal AI-engine volatility." : "Unaided visibility is holding or improving.",
               detection: x.movement?.better === false ? `${name} appears less often in neutral answers.` : `${name} appears as often or more often.`,
               position: x.movement?.better === false ? `When selected, ${name} is less prominent.` : `When selected, ${name} is as prominent or more.`,
               top3: x.movement?.better === false ? "Prominent visibility has softened." : "Prominent visibility is holding.",
               sentiment: (x.current ?? 0) >= 80 ? "Still strong; not the core issue." : "Sentiment needs attention." })[x.metric]]), { left: [4] })),
    ];
  }

  function intentSection(r, name) {
    const max = Math.max(1, ...r.intent_competition.flatMap((i) => [i.coogee, ...i.leaders.map((l) => l.visibility)]));
    const bar = (v, color) => el("span", {}, el("span", { class: "bar", style: `width:${Math.round((v / max) * 80)}px;background:${color}` }), num(v, 1));
    return section("r-intent", "Intent-level competitive intelligence", `Where ${name} wins and where competitors are stronger`,
      `Neutral prompt set, by guest intent. Leader = the strongest tracked competitor for that intent.`,
      rtable(["Intent", name, "Nearest / leader", "Implication"],
        r.intent_competition.map((i) => [i.intent, bar(i.coogee, "var(--series-1)"),
          el("span", {}, ...i.leaders.map((l, n) => el("div", {}, `${l.name} `, bar(l.visibility, "var(--de-emph)")))),
          el("span", {}, el("span", { class: "r-dot", style: `background:${i.status === "lead" ? "var(--k-up)" : "var(--k-down)"}` }), i.implication)]), { left: [3] }));
  }

  function whySection(r) {
    const count = (types) => r.diagnoses.filter((d) => types.includes(d.diagnosis_type)).reduce((a, d) => a + d.n, 0);
    const card = (cls, title, bullets, n, types) => el("div", { class: "r-card " + cls }, el("h4", {}, title),
      el("ul", {}, ...bullets.map((b) => el("li", {}, b))),
      el("div", { class: "saved" }, `${n} open diagnosis${n === 1 ? "" : "es"} (${types})`));
    return section("r-why", "Understanding AI selection", "Why AI chooses Coogee — or someone else", null,
      el("div", { class: "r-cards3" },
        card("", "1. Relevance", ["Does the hotel match the guest intent?", "Are pages written around traveller needs, not just hotel features?", "Do we cover specific occasions and use cases?"], count(["content_gap"]), "content gaps"),
        card("grey", "2. Clarity", ["Can AI understand the hotel as one entity?", "Are rooms, dining, venues, offers and location signals connected?", "Is schema aligned with live content?"], count(["entity_confusion", "negative_sentiment"]), "entity confusion, sentiment"),
        card("plain", "3. Credibility", ["Which sources does AI cite?", "Are owned, IHG, editorial and review sources consistent?", "Do competitors have stronger third-party corroboration?"], count(["citation_gap", "competitor_dominance"]), "citation gaps, competitor dominance")));
  }

  function sourcesSection(r, name) {
    const S = r.sources;
    const pagesByIntent = {};
    S.pages_by_intent.forEach((p) => (pagesByIntent[p.intent] ||= []).push(p));
    const compSrc = {};
    S.competitor_sources.forEach((p) => (compSrc[p.competitor] ||= []).push(p));
    const shortUrl = (u) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\?.*$/, "").slice(0, 70);
    return section("r-sources", "Move from measurement to diagnosis", `Source intelligence: who is informing AI about ${name}?`,
      `Every source the engines cited in ${name}'s answers this period, grouped by type.`,
      el("div", { class: "r-grid2" },
        el("div", {}, el("h3", {}, "Citation share by source type"), categoryChart(S.categories)),
        el("div", {}, el("h3", {}, `Top 10 cited sources for ${name}`),
          rtable(["Source", "Type", "Citations", "Intents"], S.top_cited.map((x) => [x.domain, x.category, num(x.citations), String(x.intents)]), { num: [2, 3] }))),
      el("div", { class: "r-grid2", style: "margin-top:10px" },
        el("div", {}, el("h3", {}, `Top 10 missing sources (cited for competitors, never for ${name})`),
          rtable(["Source", "Type", "Citations for rivals", "Cited for"], S.missing.map((x) => [x.domain, x.category, num(x.for_competitors), (x.competitors || []).join(", ")]), { num: [2], left: [3] })),
        el("div", {}, el("h3", {}, "Cited pages by prompt cluster"),
          rtable(["Intent", `Most-cited ${name} / IHG pages`], Object.entries(pagesByIntent).map(([k, v]) => [k,
            el("span", {}, ...v.map((p) => el("div", {}, el("a", { href: p.url, target: "_blank", rel: "noopener" }, shortUrl(p.url)), ` · ${p.citations}`)))]), { left: [1] }))),
      el("h3", {}, "Competitor sources"),
      rtable(["Competitor", "Sources AI cites for them"], Object.entries(compSrc).map(([k, v]) => [k, v.map((x) => `${x.domain} (${x.citations})`).join(" · ")]), { left: [1] }),
      el("div", { class: "r-callout" }, el("strong", {}, "Action triggers: "),
        "low owned-site share or stale pages → refresh owned content; weak IHG linking → align brand pages; competitor cited where the hotel is absent → target PR or a listing correction; outdated OTA descriptions → update listings."));
  }

  function engagement() {
    const rows = (items) => items.map((t) => el("div", { class: "r-metric-row" }, el("span", {}, t), el("span", {}, "—")));
    return section("r-engage", null, "Engagement and conversion", null,
      el("div", { class: "r-pending" }, "These metrics require conversion tracking in Google Tag Manager, which depends on Editor-level GTM/GA4 access from the hotel. They will populate here once tracking is configured."),
      el("div", { class: "r-grid2" },
        el("div", { class: "r-panel" }, el("h4", {}, "Engagement"), el("div", { class: "it" }, "Pending hotel GTM/GA4 access"),
          ...rows(["High-intent page time", "Check-availability click behaviour", "Booking engine handoff"])),
        el("div", { class: "r-panel" }, el("h4", {}, "Conversion"), el("div", { class: "it" }, "Declared-intent proxies, pending hotel GTM/GA4 access — booking conversion sits in PMS data, outside program scope"),
          ...rows(["Enquiry submissions", "Brochure downloads", "Dining click-outs", "Booking engine referrals"]))));
  }

  function footer(r) {
    return el("footer", { class: "r-foot" },
      el("span", { class: "wordmark" }, "komosion", el("i")),
      el("p", {}, `Visibility = average answer score, where an answer scores 100 ÷ (1 + 0.1 × (rank − 1)) when the hotel is mentioned and 0 when not; Detection = % of answers mentioning the hotel; Top 3 = % ranked 1–3; Sentiment = average × 100. ` +
        `${r.names === "all" ? "Counting every confirmed hotel name." : "Using Rankscale's brand detection."} Baselines marked as derived were back-calculated from the Aug 2026 report's movements. AI responses are non-deterministic; repeated trends matter more than single observations.`));
  }

  // ------------------------------------------------------------------ data (cached per filter set)
  async function getReport() {
    const pid = G.state.propertyId; if (!pid) return null;
    const q = new URLSearchParams({ names: R.names });
    if (R.from) q.set("date_from", String(R.from).slice(0, 10));
    if (R.to) q.set("date_to", String(R.to).slice(0, 10));
    const key = `${pid}?${q}`;
    if (R.key === key && R.data) return R.data;
    if (R.key === key && R.pending) return R.pending;
    R.key = key; R.data = null;
    R.pending = api(`/api/report/${key}`).then((d) => { if (R.key === key) R.data = d; return d; });
    return R.pending;
  }
  function applyPeriod(preset, from, to, names) {
    const r = R.data;
    R.preset = preset;
    if (preset === "last30") { R.from = R.to = null; }
    else if (preset === "all" && r) { R.from = r.period.data_from; R.to = r.period.data_to; }
    else if (preset.startsWith("m:")) {
      const [y, m] = preset.slice(2).split("-").map(Number);
      R.from = `${preset.slice(2)}-01`;
      R.to = `${y}-${String(m).padStart(2, "0")}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
    } else if (preset === "custom") { R.from = from; R.to = to; }
    if (names) { R.names = names; store("geo.names", names); }
    R.key = null;
  }

  // Reports page: the full printable report
  async function loadReport() {
    const box = root(); if (!box) return;
    box.classList.add("r-loading");
    let r;
    try { r = await getReport(); }
    catch (e) { box.replaceChildren(el("div", { class: "report bad" }, `Couldn't build the report: ${e.message}`)); box.classList.remove("r-loading"); return; }
    if (!r) return;
    if (r.empty) { box.replaceChildren(el("div", { class: "empty" }, "No data yet — upload a Rankscale export first.")); box.classList.remove("r-loading"); return; }
    if (window.setPageHead) window.setPageHead("reports", r);
    const name = shortName(r.property.name);
    box.replaceChildren(hero(r), nav(), execOverview(r, name), performance(r, name), promptSets(r, name),
      ...competitive(r, name), intentSection(r, name), whySection(r), sourcesSection(r, name), engagement(), footer(r));
    box.classList.remove("r-loading");
  }
  G.report = { getReport, applyPeriod, monthsBetween, shortName, fmtRange, METRIC_LABEL, signedPct, moveText, rtable,
               sections: { hero, nav, execOverview, performance, promptSets, competitive, intentSection, whySection,
                           sourcesSection, engagement, footer, trendChart, categoryChart } };
  window.loadReport = loadReport;
})();
