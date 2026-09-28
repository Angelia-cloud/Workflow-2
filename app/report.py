"""Monthly GEO report: every number on the Report tab, computed from Supabase.

Metric definitions (same as Rankscale; see db/07_report.sql):
  answer score = 100 / (1 + 0.1 × (rank − 1)) when the brand is mentioned, else 0
  Visibility   = average answer score        Detection = % of answers mentioning the brand
  Avg position = average rank when mentioned  Top 3     = % of answers with rank 1–3
  Sentiment    = average sentiment × 100 when mentioned

`names='rankscale'` uses Rankscale's own brand detection (matches its dashboard and the
monthly report); `names='all'` counts every confirmed hotel name (Crowne Plaza, Shutters…).
"""
from __future__ import annotations

from datetime import date, timedelta

from .db import connect

METRICS = ("visibility", "detection", "position", "top3", "sentiment")
LOWER_IS_BETTER = {"position"}
MIN_TREND_ANSWERS = 30


def _cols(names: str) -> tuple[str, str, str]:
    return ("found_any", "rank_any", "sentiment_any") if names == "all" else ("found_rs", "rank_rs", "sentiment_rs")


def _metric_sql(found: str, rank: str, sent: str) -> str:
    return f"""
        count(*)                                                                       as answers,
        round(avg(case when {found} then 100.0 / (1 + 0.1 * ({rank} - 1)) else 0 end), 2) as visibility,
        round(100.0 * avg({found}::int), 2)                                             as detection,
        round(avg({rank}) filter (where {found}), 2)                                    as position,
        round(100.0 * avg(({found} and {rank} <= 3)::int), 2)                           as top3,
        round(100.0 * avg({sent}) filter (where {found}), 1)                            as sentiment"""


def _num(row: dict | None) -> dict:
    if not row:
        return {}
    return {k: (float(v) if v is not None and k in METRICS else v) for k, v in row.items()}


def movement(current: float | None, reference: float | None, metric: str) -> dict | None:
    """Relative change, with 'better' meaning an improvement (position: lower is better)."""
    if current is None or reference in (None, 0):
        return None
    rel = (current - reference) / reference * 100
    better = rel < 0 if metric in LOWER_IS_BETTER else rel > 0
    return {"reference": reference, "relative_pct": round(rel, 1), "better": better if abs(rel) >= 0.05 else None}


def _benchmarks(conn, pid: str) -> dict:
    rows = conn.execute("""select label, kind, as_of, prompt_set, dimension, dim_key, metric,
                                  value::float as value, is_derived
                           from benchmarks where property_id = %s""", (pid,)).fetchall()
    out: dict = {}
    for r in rows:
        out.setdefault(r["label"], {"kind": r["kind"], "as_of": r["as_of"], "values": {}})
        out[r["label"]]["values"][(r["prompt_set"], r["dimension"], r["dim_key"], r["metric"])] = r["value"]
    return out


def _bm(bms: dict, label: str, pset: str, dim: str, key: str, metric: str):
    return bms.get(label, {}).get("values", {}).get((pset, dim, key, metric))


def competitor_metrics(conn, property_id: str, date_from: date, date_to: date,
                       intent_id: str | None = None, engine_id: str | None = None,
                       answer_table: str = "_ans", competitor_table: str = "_comp") -> list[dict]:
    """Tracked competitor metrics using the report's neutral-set denominator and score formula."""
    if answer_table not in {"_ans", "v_answer_scores"} or competitor_table not in {"_comp", "v_competitor_answer_scores"}:
        raise ValueError("unsupported report score source")
    where = ["property_id = %(pid)s", "day between %(df)s and %(dt)s", "is_neutral"]
    params = {"pid": property_id, "df": date_from, "dt": date_to}
    if intent_id:
        where.append("intent_id = %(iid)s")
        params["iid"] = intent_id
    if engine_id:
        where.append("engine = (select name from engines where id = %(eid)s)")
        params["eid"] = engine_id
    scoped = " and ".join(where)
    comp_filters = ["c.group_id = g.id", "c.is_neutral", "c.day between %(df)s and %(dt)s"]
    if intent_id:
        comp_filters.append("c.intent = (select name from intents where id = %(iid)s)")
    if engine_id:
        comp_filters.append("c.engine = (select name from engines where id = %(eid)s)")
    return conn.execute(f"""
        with total as (select count(*) n from {answer_table} where {scoped})
        select g.name, g.display_name, g.sort_order, (select n from total) as answers,
               round(coalesce(sum(100.0 / (1 + 0.1 * (c.rank - 1))), 0) / nullif((select n from total), 0), 2) as visibility,
               round(100.0 * count(c.measurement_id) / nullif((select n from total), 0), 2) as detection,
               round(avg(c.rank), 2) as position,
               round(100.0 * count(*) filter (where c.rank <= 3) / nullif((select n from total), 0), 2) as top3,
               round(100.0 * avg(c.sentiment), 1) as sentiment
        from competitor_groups g
        left join {competitor_table} c on {' and '.join(comp_filters)}
        where g.property_id = %(pid)s and g.is_tracked
        group by g.id order by g.sort_order""", params).fetchall()


def build_report(pid: str, date_from: date | None = None, date_to: date | None = None,
                 names: str = "rankscale", baseline_label: str = "Pre-schema baseline",
                 benchmark_label: str = "13 Aug benchmark") -> dict:
    found, rank, sent = _cols(names)
    M = _metric_sql(found, rank, sent)
    with connect() as conn:
        prop = conn.execute("select id, name from properties where id = %s", (pid,)).fetchone()
        if not prop:
            raise ValueError("property not found")
        # snapshot the views once for this property; every query below reads these (much faster
        # than letting Postgres re-expand the views in each join)
        for tmp, view in (("_ans", "v_answer_scores"), ("_comp", "v_competitor_answer_scores"),
                          ("_dom", "v_domain_category")):
            conn.execute(f"create temp table {tmp} on commit drop as select * from {view} where property_id = %s", (pid,))
            conn.execute(f"analyze {tmp}")
        span = conn.execute("select min(day) as first, max(day) as last from _ans where property_id = %s",
                            (pid,)).fetchone()
        if not span["last"]:
            return {"property": prop, "empty": True}
        date_to = date_to or span["last"]
        date_from = date_from or max(span["first"], date_to - timedelta(days=29))
        days = (date_to - date_from).days + 1
        prev_to, prev_from = date_from - timedelta(days=1), date_from - timedelta(days=days)
        P = {"pid": pid, "df": date_from, "dt": date_to, "pf": prev_from, "pt": prev_to}
        cur_w = "property_id = %(pid)s and day between %(df)s and %(dt)s"
        prev_w = "property_id = %(pid)s and day between %(pf)s and %(pt)s"
        bms = _benchmarks(conn, pid)

        def one(where: str, extra: str = "") -> dict:
            return _num(conn.execute(f"select {M} from _ans where {where} {extra}", P).fetchone())

        # ---------- 1. Full prompt set: headline metrics ----------
        full_cur, full_prev = one(cur_w), one(prev_w)
        overall = []
        for m in METRICS:
            overall.append({
                "metric": m, "current": full_cur.get(m),
                "vs_baseline": movement(full_cur.get(m), _bm(bms, baseline_label, "full", "overall", "", m), m),
                "vs_previous": movement(full_cur.get(m), full_prev.get(m), m) if full_prev.get("answers") else None,
                "vs_last_report": movement(full_cur.get(m), _bm(bms, "Aug 2026 report", "full", "overall", "", m), m),
            })

        # ---------- 2. Trend: visibility per ~2-day Rankscale run ----------
        trend = conn.execute(f"""
            with b as (select *, ((day - %(first)s) / 2) as bucket from _ans where property_id = %(pid)s)
            select min(day) as day, {M} from b group by bucket order by bucket""",
            {**P, "first": span["first"]}).fetchall()
        trend = [_num(t) for t in trend if t["answers"] >= MIN_TREND_ANSWERS]

        # ---------- 3. By engine / by intent (full set) ----------
        def grouped(dim: str, col: str) -> list[dict]:
            cur = {r[col]: _num(r) for r in conn.execute(
                f"select {col}, {M} from _ans where {cur_w} group by {col}", P).fetchall()}
            prev = {r[col]: _num(r) for r in conn.execute(
                f"select {col}, {M} from _ans where {prev_w} group by {col}", P).fetchall()}
            rows = []
            for k, v in cur.items():
                rows.append({"name": k, **v,
                             "vs_baseline": movement(v["visibility"], _bm(bms, baseline_label, "full", dim, k, "visibility"), "visibility"),
                             "vs_previous": movement(v["visibility"], prev.get(k, {}).get("visibility"), "visibility")
                                            if k in prev else None})
            return sorted(rows, key=lambda r: -(r["visibility"] or 0))

        engines, intents = grouped("engine", "engine"), grouped("intent", "intent")
        intent_engine = [_num(r) for r in conn.execute(
            f"select intent, engine, {M} from _ans where {cur_w} group by intent, engine order by intent, engine",
            P).fetchall()]

        # ---------- 4. Neutral competitor benchmark ----------
        neutral_cur = one(cur_w, "and is_neutral")
        neutral_prompts = conn.execute("""select count(*) filter (where p.is_neutral) as neutral, count(*) as total
                                          from prompts p join intents i on i.id = p.intent_id
                                          where i.property_id = %s and p.status = 'tracked'""", (pid,)).fetchone()
        comp_rows = competitor_metrics(conn, pid, date_from, date_to)
        competitors = [{"name": prop["name"], "short": "Coogee", "is_self": True, **neutral_cur}] + \
                      [{**_num(r), "name": r["display_name"] or r["name"], "short": r["name"], "is_self": False}
                       for r in comp_rows]
        neutral_vs_benchmark = [{
            "metric": m, "benchmark": _bm(bms, benchmark_label, "neutral", "overall", "", m),
            "current": neutral_cur.get(m),
            "movement": movement(neutral_cur.get(m), _bm(bms, benchmark_label, "neutral", "overall", "", m), m)}
            for m in METRICS]

        # ---------- 5. Intent-level competitive intelligence (neutral set) ----------
        own_int = {r["intent"]: float(r["visibility"]) for r in conn.execute(f"""
            select intent, round(avg(case when {found} then 100.0/(1+0.1*({rank}-1)) else 0 end), 1) as visibility
            from _ans where {cur_w} and is_neutral group by intent""", P).fetchall()}
        comp_int = conn.execute(f"""
            with t as (select intent, count(*) n from _ans where {cur_w} and is_neutral group by intent)
            select t.intent, g.name, round(coalesce(sum(100.0/(1+0.1*(c.rank-1))), 0) / t.n, 1) as visibility
            from t cross join competitor_groups g
            left join _comp c on c.group_id = g.id and c.intent = t.intent
                   and c.is_neutral and c.day between %(df)s and %(dt)s
            where g.property_id = %(pid)s and g.is_tracked
            group by t.intent, t.n, g.name""", P).fetchall()
        intent_comp = []
        for intent, mine in sorted(own_int.items(), key=lambda kv: -kv[1]):
            rivals = sorted([(r["name"], float(r["visibility"])) for r in comp_int if r["intent"] == intent],
                            key=lambda x: -x[1])
            ahead = [r for r in rivals if r[1] > mine]
            if ahead:
                names_ = " and ".join(n for n, _ in ahead[:2])
                gap = ahead[0][1] - mine
                text = f"{names_} currently {'edges' if len(ahead) == 1 and gap < 5 else 'stronger'}" + \
                       (" Coogee" if len(ahead) == 1 and gap < 5 else "")
                shown = ahead[:2]
            else:
                gap = mine - (rivals[0][1] if rivals else 0)
                text = ("Clear Coogee lead" if gap >= 20 else "Strong Coogee lead" if gap >= 10
                        else f"Coogee leads; {rivals[0][0]} is nearest" if rivals else "Coogee leads")
                shown = rivals[:1]
            intent_comp.append({"intent": intent, "coogee": mine,
                                "leaders": [{"name": n, "visibility": v} for n, v in shown],
                                "status": "behind" if ahead else "lead", "implication": text})

        # ---------- 6. Source intelligence ----------
        src_cat = conn.execute("""
            select coalesce(dc.category, 'Other') as category,
                   count(*) as citations,
                   count(*) filter (where e.attributed_to = 'own_brand') as for_hotel,
                   count(distinct e.domain) as domains
            from evidence e
            join _ans a on a.measurement_id = e.measurement_id
            left join _dom dc on dc.property_id = e.property_id and dc.domain = e.domain
            where a.property_id = %(pid)s and a.day between %(df)s and %(dt)s
            group by 1 order by 2 desc""", P).fetchall()
        tot = sum(r["citations"] for r in src_cat) or 1
        tot_h = sum(r["for_hotel"] for r in src_cat) or 1
        for r in src_cat:
            r["share"] = round(100 * r["citations"] / tot, 1)
            r["share_for_hotel"] = round(100 * r["for_hotel"] / tot_h, 1)

        top_sources = conn.execute("""
            select e.domain, coalesce(dc.category, 'Other') as category, count(*) as citations,
                   count(distinct a.intent) as intents
            from evidence e join _ans a on a.measurement_id = e.measurement_id
            left join _dom dc on dc.property_id = e.property_id and dc.domain = e.domain
            where a.property_id = %(pid)s and a.day between %(df)s and %(dt)s and e.attributed_to = 'own_brand'
            group by 1, 2 order by 3 desc limit 10""", P).fetchall()

        missing_sources = conn.execute("""
            with c as (
              select e.domain, coalesce(dc.category, 'Other') as category,
                     count(*) filter (where e.attributed_to = 'competitor') as for_competitors,
                     count(*) filter (where e.attributed_to = 'own_brand') as for_hotel,
                     count(distinct a.intent) as intents,
                     (select array_agg(n order by c desc) from (
                        select cp2.name as n, count(*) as c from evidence e2
                        join _ans a2 on a2.measurement_id = e2.measurement_id
                        join competitors cp2 on cp2.id = e2.competitor_id
                        where e2.domain = e.domain and a2.property_id = %(pid)s
                          and a2.day between %(df)s and %(dt)s
                        group by cp2.name order by count(*) desc limit 2) t) as competitors
              from evidence e join _ans a on a.measurement_id = e.measurement_id
              left join competitors cp on cp.id = e.competitor_id
              left join _dom dc on dc.property_id = e.property_id and dc.domain = e.domain
              where a.property_id = %(pid)s and a.day between %(df)s and %(dt)s
              group by 1, 2)
            select * from c where for_hotel = 0 and for_competitors > 0 and category <> 'Competitor sites'
            order by for_competitors desc limit 10""", P).fetchall()

        pages_by_intent = conn.execute("""
            with x as (
              select a.intent, e.url, count(*) as citations,
                     row_number() over (partition by a.intent order by count(*) desc) as rn
              from evidence e join _ans a on a.measurement_id = e.measurement_id
              join _dom dc on dc.property_id = e.property_id and dc.domain = e.domain
              where a.property_id = %(pid)s and a.day between %(df)s and %(dt)s
                and dc.category in ('Owned site', 'IHG / brand ecosystem') and e.attributed_to = 'own_brand'
              group by a.intent, e.url)
            select intent, url, citations from x where rn <= 3 order by intent, citations desc""", P).fetchall()

        comp_sources = conn.execute("""
            with x as (
              select g.name as competitor, e.domain, count(*) as citations,
                     row_number() over (partition by g.name order by count(*) desc) as rn
              from evidence e
              join _ans a on a.measurement_id = e.measurement_id
              join competitors cp on cp.id = e.competitor_id
              join competitor_groups g on g.property_id = a.property_id and g.is_tracked
                                      and public.name_matches(cp.name, g.aliases)
              where a.property_id = %(pid)s and a.day between %(df)s and %(dt)s
              group by g.name, e.domain)
            select competitor, domain, citations from x where rn <= 4 order by competitor, citations desc""",
            P).fetchall()

        # ---------- 7. Diagnoses summary (Relevance / Clarity / Credibility) ----------
        diag = conn.execute("""
            select d.diagnosis_type, count(*) as n
            from diagnoses d join _ans a on a.measurement_id = d.measurement_id
            where a.property_id = %(pid)s and d.status <> 'rejected'
            group by 1""", P).fetchall()

        period_key = f"{date_from}_{date_to}"
        notes = {r["section"]: r for r in conn.execute(
            "select section, body, updated_by, updated_at from report_notes where property_id = %s and period_key = %s",
            (pid, period_key)).fetchall()}

    # ---------- auto-written commentary ----------
    insights = _insights(full_cur, overall, engines, intents, competitors, neutral_vs_benchmark, intent_comp)

    return {
        "property": prop, "names": names,
        "period": {"from": date_from, "to": date_to, "days": days, "key": period_key,
                   "previous_from": prev_from, "previous_to": prev_to,
                   "data_from": span["first"], "data_to": span["last"]},
        "baseline_label": baseline_label, "benchmark_label": benchmark_label,
        "baseline_visibility": _bm(bms, baseline_label, "full", "overall", "", "visibility"),
        "benchmarks": [{"label": k, "kind": v["kind"], "as_of": v["as_of"]} for k, v in bms.items()],
        "last_report": {"label": "Aug 2026 report",
                        "neutral_visibility": {k[2] or "__self__": v for k, v in bms.get("Aug 2026 report", {}).get("values", {}).items()
                                               if k[0] == "neutral" and k[3] == "visibility" and k[1] in ("overall", "competitor")}},
        "prompt_sets": {"full": neutral_prompts["total"], "neutral": neutral_prompts["neutral"]},
        "overall": overall, "overall_answers": full_cur.get("answers"),
        "trend": trend, "engines": engines, "intents": intents, "intent_engine": intent_engine,
        "competitors": competitors, "neutral_vs_benchmark": neutral_vs_benchmark,
        "intent_competition": intent_comp,
        "sources": {"categories": src_cat, "top_cited": top_sources, "missing": missing_sources,
                    "pages_by_intent": pages_by_intent, "competitor_sources": comp_sources},
        "diagnoses": diag, "notes": notes, "insights": insights,
    }


def _insights(full, overall, engines, intents, competitors, nvb, intent_comp) -> dict:
    o = {x["metric"]: x for x in overall}
    good, qual = [], []
    vb = o["visibility"]["vs_baseline"]
    if vb:
        word = "stronger than" if vb["better"] else "weaker than"
        good.append(f"Full-set AI visibility is {abs(vb['relative_pct'])}% {word} the pre-schema baseline.")
    good.append(f"Visibility Score: {full.get('visibility')}. Detection Rate: {full.get('detection')}. "
                f"Average Position: #{full.get('position')}. Sentiment: {full.get('sentiment')}.")
    if intents:
        good.append("Strongest intent areas: " + ", ".join(i["name"] for i in intents[:3]) + ".")
    if engines:
        best = engines[0]
        improved = [e for e in engines if e["vs_baseline"] and e["vs_baseline"]["better"]]
        line = f"{best['name']} remains strongest ({best['visibility']})."
        if improved:
            top = max(improved, key=lambda e: e["vs_baseline"]["relative_pct"])
            line += f" {top['name']} improved most (+{top['vs_baseline']['relative_pct']}% vs baseline)."
        good.append(line)

    me = next((c for c in competitors if c["is_self"]), None)
    rivals = [c for c in competitors if not c["is_self"]]
    if me and rivals:
        top_rival = max(rivals, key=lambda c: c.get("visibility") or 0)
        if (me.get("visibility") or 0) >= (top_rival.get("visibility") or 0):
            qual.append(f"Coogee still leads the neutral competitor set ({me['visibility']} vs "
                        f"{top_rival['short']} {top_rival['visibility']}).")
        else:
            qual.append(f"{top_rival['short']} leads the neutral competitor set ({top_rival['visibility']} vs "
                        f"Coogee {me['visibility']}).")
    nv = next((x for x in nvb if x["metric"] == "visibility"), None)
    if nv and nv["movement"]:
        qual.append(f"Neutral visibility is {nv['current']} vs {nv['benchmark']} at the benchmark "
                    f"({'+' if nv['movement']['relative_pct'] > 0 else ''}{nv['movement']['relative_pct']}%).")
    behind = [i for i in intent_comp if i["status"] == "behind"]
    if behind:
        qual.append("Competitors are stronger in " + ", ".join(
            f"{i['intent']} ({i['leaders'][0]['name']})" for i in behind) + ".")
    return {"good_news": good, "qualification": qual}
