"""GEO Automation Platform — FastAPI backend.

Run:  uvicorn app.main:app --reload        then open http://localhost:8000
Docs: http://localhost:8000/docs           (interactive API explorer)
"""
from __future__ import annotations

import os
from datetime import date
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv()

from . import loader  # noqa: E402
from .db import connect, fetch_all, fetch_one  # noqa: E402
from .ingest import parse_rankscale  # noqa: E402

MAX_UPLOAD_MB = int(os.environ.get("GEO_MAX_UPLOAD_MB", "50"))
STATIC = Path(__file__).parent / "static"

app = FastAPI(title="GEO Automation Platform", version="1.0")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
def health():
    row = fetch_one("select count(*) as properties from properties")
    return {"ok": True, **row}


# ---------------------------------------------------------------------------
# Workflow 1a — file import gateway
# ---------------------------------------------------------------------------
@app.post("/api/imports")
async def import_rankscale(file: UploadFile = File(...),
                           dry_run: bool = Form(False),
                           uploaded_by: str | None = Form(None)):
    """Upload a Rankscale export. dry_run=true validates only (nothing is written)."""
    raw = await file.read()
    if len(raw) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"File is larger than {MAX_UPLOAD_MB} MB.")
    rows, rep = parse_rankscale(raw, file.filename or "upload.csv")
    if rep.ok and rows:
        with connect() as conn:
            loader.check_brand_references(conn, rows, rep)
    if not rep.ok:
        batch = None if dry_run else loader.record_rejected(rep, uploaded_by)
        raise HTTPException(422, {"message": rep.errors[0]["message"], "batch_id": batch, "report": rep.as_dict()})
    if dry_run:
        return {"status": "validated", "report": rep.as_dict()}
    try:
        result = loader.load_rows(rows, rep, uploaded_by)
    except Exception as e:  # surface DB errors to the UI in plain words
        raise HTTPException(500, {"message": f"Loading failed and nothing was saved: {e}",
                                  "report": rep.as_dict()}) from e
    return {"status": "loaded", **result, "report": rep.as_dict()}


@app.get("/api/imports")
def list_imports(limit: int = 20):
    return fetch_all("""select id, filename, uploaded_by, status, rows_in_file, rows_valid, rows_rejected,
                               measurements_added, mentions_added, evidence_added, created_at
                        from import_batches order by created_at desc limit %s""", (limit,))


@app.get("/api/imports/{batch_id}")
def get_import(batch_id: str):
    row = fetch_one("select * from import_batches where id = %s", (batch_id,))
    if not row:
        raise HTTPException(404, "batch not found")
    return row


# ---------------------------------------------------------------------------
# Workflow 1b — dashboard
# ---------------------------------------------------------------------------
@app.get("/api/properties")
def properties():
    return fetch_all("select id, name, location, website_url, aliases from properties order by name")


def _filters(property_id: str, intent: str | None = None, engine: str | None = None,
             date_from: date | None = None, date_to: date | None = None) -> tuple[str, dict]:
    where = ["property_id = %(pid)s"]
    p: dict = {"pid": property_id}
    if intent:
        where.append("intent = %(intent)s"); p["intent"] = intent
    if engine:
        where.append("engine = %(engine)s"); p["engine"] = engine
    if date_from:
        where.append("measured_at >= %(df)s"); p["df"] = date_from
    if date_to:
        where.append("measured_at < %(dt)s::date + 1"); p["dt"] = date_to
    return " and ".join(where), p


@app.get("/api/dashboard/{property_id}/kpis")
def kpis(property_id: str, intent: str | None = None, engine: str | None = None,
         date_from: date | None = None, date_to: date | None = None):
    w, p = _filters(property_id, intent, engine, date_from, date_to)
    return fetch_one(f"""
        select count(*) as answers, count(distinct prompt_id) as prompts, count(distinct engine) as engines,
               min(measured_at)::date as first_measured, max(measured_at)::date as last_measured,
               round(avg(brand_found::int), 3) as found_rate_rankscale,
               round(avg(brand_found_any_alias::int), 3) as found_rate_any_alias,
               round(avg(own_brand_rank) filter (where brand_found_any_alias), 2) as avg_rank_when_found,
               round(avg(own_brand_sentiment) filter (where brand_found_any_alias), 3) as avg_sentiment_when_found,
               count(*) filter (where brand_found_any_alias and not brand_found) as missed_by_rankscale
        from v_measurements_flat where {w}""", p)


@app.get("/api/dashboard/{property_id}/intent-engine")
def intent_engine(property_id: str, date_from: date | None = None, date_to: date | None = None):
    w, p = _filters(property_id, date_from=date_from, date_to=date_to)
    return fetch_all(f"""
        select intent, engine, count(*) as answers,
               round(avg(brand_found_any_alias::int), 3) as found_rate,
               round(avg(brand_found::int), 3) as found_rate_rankscale,
               round(avg(own_brand_rank) filter (where brand_found_any_alias), 2) as avg_rank_when_found
        from v_measurements_flat where {w} group by intent, engine order by intent, engine""", p)


@app.get("/api/dashboard/{property_id}/weekly")
def weekly(property_id: str, intent: str | None = None, engine: str | None = None):
    w, p = _filters(property_id, intent, engine)
    return fetch_all(f"""
        select week_start, count(*) as answers,
               round(avg(brand_found_any_alias::int), 3) as found_rate,
               round(avg(brand_found::int), 3) as found_rate_rankscale
        from v_measurements_flat where {w} group by week_start order by week_start""", p)


@app.get("/api/dashboard/{property_id}/competitors")
def competitors(property_id: str, intent: str | None = None, engine: str | None = None,
                date_from: date | None = None, date_to: date | None = None, limit: int = 10):
    w, p = _filters(property_id, intent, engine, date_from, date_to)
    p["limit"] = limit
    return fetch_all(f"""
        with f as (select * from v_measurements_flat where {w}),
        total as (select count(*) n from f)
        select c.name as competitor, count(distinct f.measurement_id) as answers,
               round(count(distinct f.measurement_id)::numeric / nullif((select n from total), 0), 3) as share,
               round(avg(mm.rank), 2) as avg_rank,
               count(distinct f.measurement_id) filter (where mm.rank = 1) as ranked_first
        from f join measurement_mentions mm on mm.measurement_id = f.measurement_id and not mm.is_own_brand
        join competitors c on c.id = mm.competitor_id
        group by c.name order by answers desc limit %(limit)s""", p)


@app.get("/api/dashboard/{property_id}/citations")
def citations(property_id: str, intent: str | None = None, engine: str | None = None,
              attributed_to: Literal["own_brand", "competitor", "unattributed"] | None = None, limit: int = 15):
    w, p = _filters(property_id, intent, engine)
    p["limit"] = limit
    extra = ""
    if attributed_to:
        extra = "and e.attributed_to = %(att)s"; p["att"] = attributed_to
    return fetch_all(f"""
        select e.domain, count(*) as citations, count(distinct e.measurement_id) as answers,
               count(*) filter (where e.attributed_to = 'own_brand') as for_hotel,
               count(*) filter (where e.attributed_to = 'competitor') as for_competitors,
               count(*) filter (where e.attributed_to = 'unattributed') as unattributed,
               bool_or(e.domain = any(pr.own_domains)) as is_own_domain
        from evidence e
        join (select measurement_id from v_measurements_flat where {w}) f on f.measurement_id = e.measurement_id
        join properties pr on pr.id = e.property_id
        where e.domain is not null {extra}
        group by e.domain order by citations desc limit %(limit)s""", p)


@app.get("/api/dashboard/{property_id}/prompts")
def prompt_scorecard(property_id: str, intent: str | None = None):
    p: dict = {"pid": property_id}
    extra = ""
    if intent:
        extra = "and intent = %(intent)s"; p["intent"] = intent
    return fetch_all(f"""select * from v_prompt_scorecard where property_id = %(pid)s {extra}
                         order by found_rate, answers desc""", p)


@app.get("/api/prompts/{prompt_id}/answers")
def prompt_answers(prompt_id: str, limit: int = 60):
    return fetch_all("""select measurement_id, engine, measured_at, brand_found, brand_found_any_alias,
                               own_brand_rank, own_brand_sentiment, brands_total
                        from v_measurements_flat where prompt_id = %s
                        order by measured_at desc, engine limit %s""", (prompt_id, limit))


@app.get("/api/measurements/{measurement_id}")
def measurement_detail(measurement_id: str):
    m = fetch_one("""select f.*, m.response_text, m.own_brand_name_mentioned, m.own_brand_sentiment_reason,
                            m.web_search_queries
                     from v_measurements_flat f join measurements m on m.id = f.measurement_id
                     where f.measurement_id = %s""", (measurement_id,))
    if not m:
        raise HTTPException(404, "measurement not found")
    m["mentions"] = fetch_all("""select rank, brand_name_raw, is_own_brand, sentiment, sentiment_reason,
                                        positive_keywords, negative_keywords
                                 from measurement_mentions where measurement_id = %s order by rank""",
                              (measurement_id,))
    m["evidence"] = fetch_all("""select e.id, e.evidence_type, e.attributed_to, c.name as competitor, e.domain,
                                        e.url, e.confidence_score, e.confidence_level, e.verification_status
                                 from evidence e left join competitors c on c.id = e.competitor_id
                                 where e.measurement_id = %s
                                 order by e.attributed_to, e.domain""", (measurement_id,))
    m["diagnoses"] = fetch_all("""select id, diagnosis_type, severity, root_cause, confidence_score, status,
                                         generated_by, created_at
                                  from diagnoses where measurement_id = %s order by created_at desc""",
                               (measurement_id,))
    m["recommendations"] = fetch_all("""select id, title, detail, action_type, priority, status
                                        from recommendations where measurement_id = %s
                                        order by created_at""", (measurement_id,))
    return m


@app.get("/api/insights/{property_id}")
def aggregated_insights(property_id: str, date_from: date | None = None, date_to: date | None = None):
    from .insights import list_insights
    return list_insights(property_id, date_from, date_to)


class InsightGenerateRequest(BaseModel):
    property_id: str
    date_from: date | None = None
    date_to: date | None = None
    intent_id: str | None = None
    engine_id: str | None = None


@app.post("/api/insights/generate")
def generate_aggregated_insights(req: InsightGenerateRequest):
    from .insights import generate_insights
    try:
        return generate_insights(req.property_id, req.date_from, req.date_to, req.intent_id, req.engine_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/insights/item/{insight_id}/evidence")
def aggregated_insight_evidence(insight_id: str):
    from .insights import evidence_package
    try:
        return evidence_package(insight_id)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


# ---------------------------------------------------------------------------
# Diagnosis agent + human review
# ---------------------------------------------------------------------------
class DiagnoseRequest(BaseModel):
    measurement_id: str
    dry_run: bool = False


@app.post("/api/diagnoses/run")
def run_diagnosis(req: DiagnoseRequest):
    from agents.diagnosis.agent import run
    from agents.llm import LLMError
    try:
        return run(req.measurement_id, dry_run=req.dry_run)
    except (LLMError, RuntimeError, ValueError) as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # provider errors: missing/invalid API key, rate limits, network
        raise HTTPException(502, f"The LLM call failed: {e}. Check GEO_LLM_PROVIDER, GEO_LLM_MODEL and the API key in .env.") from e


@app.get("/api/recommendations")
def recommendation_queue(property_id: str, status: str | None = None, limit: int = 100):
    p: dict = {"pid": property_id, "limit": limit}
    extra = ""
    if status:
        extra = "and status = %(status)s"; p["status"] = status
    return fetch_all(f"""select * from v_recommendation_queue where property_id = %(pid)s {extra}
                         order by created_at desc limit %(limit)s""", p)


class Feedback(BaseModel):
    target: Literal["recommendation", "diagnosis", "evidence", "measurement"]
    target_id: str
    reviewer: str
    decision: Literal["approve", "reject", "edit", "comment"]
    rating: int | None = None
    comment: str | None = None


@app.post("/api/feedback")
def add_feedback(fb: Feedback):
    col = f"{fb.target}_id"
    with connect() as conn:
        row = conn.execute(f"""insert into human_feedback ({col}, reviewer, decision, rating, comment)
                               values (%s, %s, %s, %s, %s) returning id""",
                           (fb.target_id, fb.reviewer, fb.decision, fb.rating, fb.comment)).fetchone()
        # a decision on a recommendation / diagnosis also moves its status
        if fb.target == "recommendation" and fb.decision in ("approve", "reject"):
            conn.execute("update recommendations set status = %s where id = %s",
                         ("approved" if fb.decision == "approve" else "rejected", fb.target_id))
        if fb.target == "diagnosis" and fb.decision in ("approve", "reject"):
            conn.execute("update diagnoses set status = %s where id = %s",
                         ("confirmed" if fb.decision == "approve" else "rejected", fb.target_id))
        if fb.target == "evidence" and fb.decision in ("approve", "reject"):
            conn.execute("""update evidence set verification_status = %s, verified_by = %s, verified_at = now()
                            where id = %s""",
                         ("verified" if fb.decision == "approve" else "disputed", fb.reviewer, fb.target_id))
        conn.commit()
    return {"id": row["id"]}


@app.get("/api/activity")
def activity(limit: int = 50):
    return fetch_all("""select entity_table, entity_id, action, actor, occurred_at
                        from activity_history order by id desc limit %s""", (limit,))


# ---------------------------------------------------------------------------
# Upstream: prompt-generation agents
# ---------------------------------------------------------------------------
class GenerateRequest(BaseModel):
    property_id: str
    total: int = 30
    focus: str | None = None
    dry_run: bool = False
    created_by: str | None = None


@app.post("/api/prompt-generation/run")
def run_prompt_generation(req: GenerateRequest):
    from agents.llm import LLMError
    from agents.prompt_generation.pipeline import generate
    try:
        return generate(req.property_id, req.total, req.focus, dry_run=req.dry_run, created_by=req.created_by)
    except (LLMError, RuntimeError, FileNotFoundError) as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        raise HTTPException(502, f"The LLM call failed: {e}. Check GEO_LLM_PROVIDER, GEO_LLM_MODEL and the API key in .env.") from e


@app.get("/api/prompt-generation/candidates")
def prompt_candidates(property_id: str, status: str = "candidate"):
    return fetch_all("""select p.id, p.prompt_text, i.name as intent, p.prompt_type, p.persona, p.rationale,
                               p.quality_score, p.status, p.created_at
                        from prompts p join intents i on i.id = p.intent_id
                        where i.property_id = %s and p.status = %s
                        order by i.name, p.quality_score desc nulls last""", (property_id, status))


class PromptStatus(BaseModel):
    prompt_ids: list[str]
    status: Literal["approved", "rejected", "candidate"]


@app.post("/api/prompt-generation/status")
def set_prompt_status(req: PromptStatus):
    with connect() as conn:
        n = conn.execute("update prompts set status = %s where id = any(%s::uuid[]) and source = 'prompt_agent'",
                         (req.status, req.prompt_ids)).rowcount
        conn.commit()
    return {"updated": n}


@app.get("/api/prompt-generation/export.csv", response_class=PlainTextResponse)
def export_prompts(property_id: str, mark_exported: bool = True):
    from agents.prompt_generation.pipeline import export_rankscale_csv
    csv_text = export_rankscale_csv(property_id, ("approved",), mark_exported=mark_exported)
    return PlainTextResponse(csv_text, media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=rankscale_import.csv"})


# ---------------------------------------------------------------------------
# Monthly report (Report tab) — mirrors the Komosion GEO report
# ---------------------------------------------------------------------------
@app.get("/api/report/{property_id}")
def report(property_id: str, date_from: date | None = None, date_to: date | None = None,
           names: Literal["rankscale", "all"] = "rankscale",
           baseline: str = "Pre-schema baseline", benchmark: str = "13 Aug benchmark"):
    from .report import build_report
    try:
        return build_report(property_id, date_from, date_to, names, baseline, benchmark)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


class ReportNote(BaseModel):
    period_key: str
    section: str
    body: str
    updated_by: str | None = None


@app.put("/api/report/{property_id}/notes")
def save_note(property_id: str, note: ReportNote):
    with connect() as conn:
        conn.execute("""insert into report_notes (property_id, period_key, section, body, updated_by)
                        values (%s, %s, %s, %s, %s)
                        on conflict (property_id, period_key, section)
                        do update set body = excluded.body, updated_by = excluded.updated_by, updated_at = now()""",
                     (property_id, note.period_key, note.section, note.body, note.updated_by))
        conn.commit()
    return {"ok": True}


class Benchmark(BaseModel):
    label: str
    kind: Literal["baseline", "benchmark", "report", "target"] = "target"
    as_of: date | None = None
    prompt_set: Literal["full", "neutral"] = "full"
    dimension: Literal["overall", "engine", "intent", "competitor"] = "overall"
    dim_key: str = ""
    metric: Literal["visibility", "detection", "position", "top3", "sentiment"]
    value: float
    note: str | None = None


@app.get("/api/report/{property_id}/benchmarks")
def list_benchmarks(property_id: str):
    return fetch_all("""select label, kind, as_of, prompt_set, dimension, dim_key, metric, value, is_derived, note
                        from benchmarks where property_id = %s
                        order by kind, label, prompt_set, dimension, dim_key, metric""", (property_id,))


@app.put("/api/report/{property_id}/benchmarks")
def upsert_benchmark(property_id: str, b: Benchmark):
    with connect() as conn:
        conn.execute("""insert into benchmarks (property_id, label, kind, as_of, prompt_set, dimension, dim_key,
                                                metric, value, note)
                        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        on conflict (property_id, label, prompt_set, dimension, dim_key, metric)
                        do update set value = excluded.value, kind = excluded.kind, as_of = excluded.as_of,
                                      note = excluded.note, is_derived = false""",
                     (property_id, b.label, b.kind, b.as_of, b.prompt_set, b.dimension, b.dim_key,
                      b.metric, b.value, b.note))
        conn.commit()
    return {"ok": True}


@app.get("/api/report/{property_id}/settings")
def report_settings(property_id: str):
    import os
    prop = fetch_one("select name, website_url, aliases, ignored_names, own_domains from properties where id = %s",
                     (property_id,))
    return {
        "property": prop,
        "competitor_groups": fetch_all("""select name, display_name, aliases, is_tracked, sort_order
                                          from competitor_groups where property_id = %s order by sort_order""",
                                       (property_id,)),
        "neutral_exclusion_terms": [r["term"] for r in fetch_all(
            "select term from neutral_exclusion_terms where property_id = %s order by term", (property_id,))],
        "prompts": fetch_all("""select p.prompt_text, i.name as intent, p.is_neutral, p.status
                                from prompts p join intents i on i.id = p.intent_id
                                where i.property_id = %s and p.status = 'tracked' order by i.name, p.prompt_text""",
                             (property_id,)),
        "llm": {"provider": os.environ.get("GEO_LLM_PROVIDER", "groq"),
                "model": os.environ.get("GEO_LLM_MODEL", "openai/gpt-oss-20b"),
                "key_set": bool(os.environ.get("GROQ_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
                                or os.environ.get("OPENAI_API_KEY"))},
    }
