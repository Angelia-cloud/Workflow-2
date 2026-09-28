"""Diagnosis agent: measurement in Supabase → draft diagnosis + recommendations.

    INPUT  build_brief()   gathers one measurement and its context from the DB
    BRAIN  system_prompt.md + the brief → LLM → DiagnosisOutput (validated)
    OUTPUT save()          writes diagnoses / diagnosis_evidence / recommendations
                           as drafts (status 'draft' / 'proposed') for human review

CLI:
    python -m agents.diagnosis.agent --measurement <uuid>
    python -m agents.diagnosis.agent --auto 5            # latest misses, not yet diagnosed
    python -m agents.diagnosis.agent --auto 5 --dry-run  # print, don't save
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.db import connect

from ..llm import LLM
from .schema import DiagnosisOutput

SYSTEM_PROMPT = (Path(__file__).parent / "system_prompt.md").read_text(encoding="utf-8")
import os
# kept small enough for Groq's free tier (8K tokens per minute per request budget)
ANSWER_CHARS = int(os.environ.get("GEO_BRIEF_ANSWER_CHARS", "3500"))
MAX_EVIDENCE = int(os.environ.get("GEO_BRIEF_MAX_EVIDENCE", "15"))
URL_CHARS = 140


def _domain_is_own(domain: str | None, own: list[str]) -> bool:
    d = (domain or "").lower()
    return any(d == o or d.endswith("." + o) for o in own)


# ---------------------------------------------------------------------------
# INPUT
# ---------------------------------------------------------------------------
def build_brief(conn, measurement_id: str) -> dict:
    m = conn.execute("""
        select m.*, pr.prompt_text, pr.id as prompt_id, i.id as intent_id, i.name as intent,
               e.id as engine_id, e.name as engine,
               p.id as property_id, p.name as property_name, p.website_url, p.aliases, p.own_domains
        from measurements m
        join prompts pr on pr.id = m.prompt_id
        join intents i on i.id = pr.intent_id
        join properties p on p.id = i.property_id
        join engines e on e.id = m.engine_id
        where m.id = %s""", (measurement_id,)).fetchone()
    if not m:
        raise ValueError(f"measurement {measurement_id} not found")
    own = [d.lower() for d in (m["own_domains"] or [])]

    mentions = conn.execute("""
        select rank, brand_name_raw as brand, is_own_brand, sentiment, sentiment_reason,
               positive_keywords, negative_keywords
        from measurement_mentions where measurement_id = %s order by rank""", (measurement_id,)).fetchall()

    evidence = conn.execute("""
        select e.id::text as id, e.domain, e.url, e.attributed_to, c.name as competitor,
               e.evidence_type, e.confidence_score::float as confidence, e.excerpt
        from evidence e left join competitors c on c.id = e.competitor_id
        where e.measurement_id = %s
        order by (e.attributed_to = 'unattributed'), e.confidence_score desc
        limit %s""", (measurement_id, MAX_EVIDENCE)).fetchall()

    same_prompt = conn.execute("""
        select distinct on (engine) engine, measured_at::date as date,
               brand_found_any_alias as found, own_brand_rank as rank
        from v_measurements_flat where prompt_id = %s and engine <> %s
        order by engine, measured_at desc""", (m["prompt_id"], m["engine"])).fetchall()

    rates = conn.execute("""
        select round(avg(brand_found_any_alias::int) filter (where engine = %(eng)s), 3) as this_engine,
               round(avg(brand_found_any_alias::int), 3) as all_engines,
               count(*) as answers
        from v_measurements_flat where intent_id = %(intent)s""",
        {"eng": m["engine"], "intent": m["intent_id"]}).fetchone()

    top_comp = conn.execute("""
        select competitor, answers_mentioning, share_of_answers::float as share, avg_rank::float as avg_rank
        from v_competitor_share where property_id = %s and intent = %s
        order by answers_mentioning desc limit 5""", (m["property_id"], m["intent"])).fetchall()

    own_cites = conn.execute("""
        select count(*) filter (where e.domain = any(%(own)s) or e.attributed_to = 'own_brand') as own,
               count(*) as total
        from evidence e join v_measurements_flat f on f.measurement_id = e.measurement_id
        where f.intent_id = %(intent)s""", {"own": own or [""], "intent": m["intent_id"]}).fetchone()

    answer = m["response_text"] or ""
    checks = {
        "found_rankscale": m["brand_found"],
        "found_any_alias": bool(m["brand_found_any_alias"]),
        "own_brand_names_in_answer": [x["brand"] for x in mentions if x["is_own_brand"]],
        "own_domain_cited_in_answer": any(_domain_is_own(e["domain"], own) for e in evidence),
        "found_on_other_engines": [s["engine"] for s in same_prompt if s["found"]],
        "missing_on_other_engines": [s["engine"] for s in same_prompt if not s["found"]],
        "intent_visibility_this_engine": rates["this_engine"],
        "intent_visibility_all_engines": rates["all_engines"],
        "answer_truncated": len(answer) > ANSWER_CHARS,
    }
    return {
        "PROPERTY": {"name": m["property_name"], "website": m["website_url"],
                     "aliases": m["aliases"], "own_domains": own},
        "MEASUREMENT": {"id": str(m["id"]), "prompt": m["prompt_text"], "intent": m["intent"],
                        "engine": m["engine"], "date": str(m["measured_at"].date()),
                        "brand_found": bool(m["brand_found_any_alias"]), "own_rank": m["own_brand_rank"],
                        "own_sentiment": float(m["own_brand_sentiment"]) if m["own_brand_sentiment"] is not None else None,
                        "own_sentiment_reason": m["own_brand_sentiment_reason"],
                        "brands_total": m["brands_total"], "used_web_search": m["used_web_search"]},
        "ANSWER": answer[:ANSWER_CHARS],
        "RANKED_BRANDS": [{k: v for k, v in {**x, "sentiment": float(x["sentiment"]) if x["sentiment"] is not None else None}.items()
                           if v not in (None, "", [])} for x in mentions],
        "EVIDENCE": [{k: (v[:URL_CHARS] if k == "url" and isinstance(v, str) else v)
                      for k, v in e.items() if v not in (None, "") and k != "evidence_type"} for e in evidence],
        "CONTEXT": {"same_prompt_other_engines": [{**s, "date": str(s["date"])} for s in same_prompt],
                    "intent_visibility": {k: (float(v) if v is not None else None) for k, v in rates.items()},
                    "top_competitors_for_intent": top_comp,
                    "own_citations_for_intent": own_cites},
        "CHECKS": checks,
    }


# ---------------------------------------------------------------------------
# BRAIN
# ---------------------------------------------------------------------------
def diagnose(brief: dict, llm: LLM) -> DiagnosisOutput:
    out = llm.json(SYSTEM_PROMPT, json.dumps(brief, default=str, ensure_ascii=False), DiagnosisOutput)
    valid = {e["id"] for e in brief["EVIDENCE"]}
    # drop any evidence ID the model made up
    out.supporting_evidence_ids = [i for i in out.supporting_evidence_ids if i in valid]
    out.contradicting_evidence_ids = [i for i in out.contradicting_evidence_ids if i in valid]
    for r in out.recommendations:
        r.evidence_ids = [i for i in r.evidence_ids if i in valid]
    return out


# ---------------------------------------------------------------------------
# OUTPUT
# ---------------------------------------------------------------------------
def save(conn, measurement_id: str, out: DiagnosisOutput, llm_label: str) -> dict:
    intel = conn.execute("""
        select intel.id from intelligence intel
        join prompts pr on pr.intent_id = intel.intent_id
        join measurements m on m.prompt_id = pr.id and m.engine_id = intel.engine_id
        where m.id = %s order by intel.created_at desc limit 1""", (measurement_id,)).fetchone()
    root = out.root_cause
    if out.open_questions:
        root += "\n\nTo verify: " + " | ".join(out.open_questions)
    d = conn.execute("""
        insert into diagnoses (measurement_id, intelligence_id, diagnosis_type, root_cause, severity,
                               confidence_score, status, generated_by)
        values (%s, %s, %s, %s, %s, %s, 'draft', 'agent') returning id""",
        (measurement_id, intel["id"] if intel else None, out.diagnosis_type,
         f"{out.summary}\n\n{root}", out.severity, round(out.confidence, 2))).fetchone()
    for ev, role in [(i, "supporting") for i in out.supporting_evidence_ids] + \
                    [(i, "contradicting") for i in out.contradicting_evidence_ids]:
        conn.execute("""insert into diagnosis_evidence (diagnosis_id, evidence_id, role)
                        values (%s, %s, %s) on conflict do nothing""", (d["id"], ev, role))
    rec_ids = []
    for r in out.recommendations:
        detail = r.detail + (f"\n\nEvidence: {', '.join(r.evidence_ids)}" if r.evidence_ids else "")
        rec_ids.append(str(conn.execute("""
            insert into recommendations (measurement_id, diagnosis_id, title, detail, action_type,
                                         priority, expected_impact, status)
            values (%s, %s, %s, %s, %s, %s, %s, 'proposed') returning id""",
            (measurement_id, d["id"], r.title, detail, r.action_type, r.priority,
             r.expected_impact)).fetchone()["id"]))
    conn.execute("""insert into activity_history (entity_table, entity_id, action, actor, changes)
                    values ('diagnoses', %s, 'update', %s, %s)""",
                 (d["id"], f"diagnosis-agent ({llm_label})", json.dumps({"note": "generated by agent"})))
    return {"diagnosis_id": str(d["id"]), "recommendation_ids": rec_ids}


def select_targets(conn, limit: int) -> list[str]:
    """Latest answer per prompt × engine where the hotel is missing and nothing is diagnosed yet."""
    rows = conn.execute("""
        with latest as (
          select distinct on (prompt_id, engine) measurement_id, brand_found_any_alias
          from v_measurements_flat order by prompt_id, engine, measured_at desc)
        select l.measurement_id from latest l
        where not l.brand_found_any_alias
          and not exists (select 1 from diagnoses d where d.measurement_id = l.measurement_id)
        limit %s""", (limit,)).fetchall()
    return [str(r["measurement_id"]) for r in rows]


def run(measurement_id: str, llm: LLM | None = None, dry_run: bool = False) -> dict:
    llm = llm or LLM()
    with connect() as conn:
        brief = build_brief(conn, measurement_id)
        out = diagnose(brief, llm)
        result = {"measurement_id": measurement_id, "output": out.model_dump()}
        if out.diagnosis_needed and not dry_run:
            result.update(save(conn, measurement_id, out, llm.label))
            conn.commit()
        return result


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--measurement")
    ap.add_argument("--auto", type=int, help="diagnose up to N undiagnosed misses")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.measurement:
        ids = [a.measurement]
    else:
        with connect() as conn:
            ids = select_targets(conn, a.auto or 1)
    llm = LLM()
    for mid in ids:
        print(json.dumps(run(mid, llm, a.dry_run), indent=2, default=str))


if __name__ == "__main__":
    main()
