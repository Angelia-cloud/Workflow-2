"""Agent pipelines tested end to end against the real database, with a stub LLM
standing in for the model (so the test is free and deterministic).
The stub still has to return JSON that passes the same schemas the real model must pass."""
import json

from agents.diagnosis import agent as diag
from agents.diagnosis.schema import DiagnosisOutput
from agents.llm import LLM
from agents.prompt_generation import pipeline
from agents.prompt_generation.schema import DraftPrompts, IntentMap, PromptReviews
from app.db import connect


def diagnosis_stub(system, user, schema):
    assert schema is DiagnosisOutput and "GEO Diagnosis Agent" in system
    brief = json.loads(user)
    ev = [e["id"] for e in brief["EVIDENCE"]][:3]
    return {"diagnosis_needed": True, "summary": "Engine favoured venues whose pages name the occasion.",
            "diagnosis_type": "content_gap" if ev else "citation_gap",
            "root_cause": f"Winning venues cite occasion pages [{ev[0]}]." if ev else "No sources were cited at all.",
            "severity": "high", "confidence": 0.7, "supporting_evidence_ids": ev + ["not-a-real-id"],
            "recommendations": [{"title": "Publish an occasion page", "detail": "Name the occasion explicitly.",
                                 "action_type": "content", "priority": "high",
                                 "expected_impact": "Visibility on occasion prompts", "evidence_ids": ev[:1]}],
            "open_questions": ["Does a celebrations page already exist?"]}


def test_diagnosis_agent_writes_drafts():
    with connect() as conn:
        # pick an undiagnosed miss that has cited sources (some answers cite none)
        target = next(t for t in diag.select_targets(conn, 200) if conn.execute(
            "select 1 from evidence where measurement_id = %s limit 1", (t,)).fetchone())
        brief = diag.build_brief(conn, target)
    assert brief["EVIDENCE"] and brief["CHECKS"]["found_any_alias"] is False
    res = diag.run(target, LLM(provider="stub", stub=diagnosis_stub))
    assert res["diagnosis_id"] and len(res["recommendation_ids"]) == 1
    assert "not-a-real-id" not in res["output"]["supporting_evidence_ids"]   # invented IDs are dropped
    with connect() as conn:
        d = conn.execute("select status, generated_by from diagnoses where id = %s", (res["diagnosis_id"],)).fetchone()
        n = conn.execute("select count(*) c from diagnosis_evidence where diagnosis_id = %s", (res["diagnosis_id"],)).fetchone()
    assert d["status"] == "draft" and d["generated_by"] == "agent"
    assert n["c"] == len(set(res["output"]["supporting_evidence_ids"]))


def prompt_stub(system, user, schema):
    data = json.loads(user)
    if schema is IntentMap:
        return {"intents": [
            {"name": "Romance & Events", "is_new": False, "description": "Couples and celebrations",
             "personas": ["parent planning a baby shower"], "occasions_or_needs": ["baby shower", "40th birthday"],
             "priority": "high", "reason": "lowest visibility", "prompts_to_generate": 3},
            {"name": "Accessible Stays", "is_new": True, "description": "Travellers needing accessible rooms",
             "personas": ["wheelchair user on a beach holiday"], "occasions_or_needs": ["accessible ocean-view room"],
             "priority": "medium", "reason": "hotel has accessible rooms", "prompts_to_generate": 2}]}
    if schema is DraftPrompts:
        name = data["INTENT"]["name"]
        base = {"Romance & Events": [
                    "Where can I host a baby shower for 30 guests in Sydney with ocean views and a private room?",
                    "Where can I host a baby shower in Sydney at an oceanfront restaurant or hotel venue?",  # duplicate
                    "Which InterContinental in Sydney is best for a 40th birthday dinner by the beach?"],   # brand leak
                "Accessible Stays": [
                    "Which Sydney beachfront hotels have wheelchair-accessible rooms with ocean views and step-free beach access?",
                    "hotel sydney accessible"]}[name]                                                         # too short
        return {"prompts": [{"prompt_text": t, "intent": name, "prompt_type": "occasion", "persona": "p",
                             "rationale": "r"} for t in base]}
    if schema is PromptReviews:
        return {"reviews": [{"index": p["index"], "decision": "keep", "realism": 0.9, "intent_fit": 0.9,
                             "measurability": 0.8, "reason": "fine"} for p in data["PROMPTS"]]}
    raise AssertionError(schema)


def test_prompt_generation_pipeline_and_export():
    with connect() as conn:   # start clean: remove anything a previous test run generated
        conn.execute("delete from prompts where source = 'prompt_agent' and generation_run_id in "
                     "(select id from prompt_generation_runs where created_by = 'test')")
        conn.execute("delete from prompt_generation_runs where created_by = 'test'")
        conn.execute("delete from intents i where name = 'Accessible Stays' and not exists "
                     "(select 1 from prompts p where p.intent_id = i.id)")
        conn.commit()
        pid = str(conn.execute("select id from properties limit 1").fetchone()["id"])
    res = pipeline.generate(pid, total=5, llm=LLM(provider="stub", stub=prompt_stub), created_by="test")
    decisions = [p["decision"] for p in res["prompts"]]
    assert decisions == ["keep", "reject", "reject", "keep", "reject"], decisions   # dup, leak, too short caught
    # the exact duplicate of a tracked prompt can't be stored twice; the other 4 are saved (2 as rejected)
    assert res["saved"] == 4 and res["summary"]["kept"] == 2
    cands = [p for p in res["prompts"] if p["decision"] == "keep"]
    with connect() as conn:
        ids = [r["id"] for r in conn.execute(
            "select id from prompts where generation_run_id = %s and status = 'candidate'", (res["run_id"],)).fetchall()]
        assert len(ids) == 2
        conn.execute("update prompts set status = 'approved' where id = any(%s)", (ids,)); conn.commit()
        assert conn.execute("select count(*) c from intents where name = 'Accessible Stays'").fetchone()["c"] == 1
    csv_text = pipeline.export_rankscale_csv(pid, ("approved",), run_id=res["run_id"])
    lines = csv_text.strip().splitlines()
    assert lines[0] == "search_term,topic,tags" and len(lines) == 3
    assert cands[0]["prompt_text"] in csv_text


def test_diagnosis_agent_handles_answer_without_sources():
    with connect() as conn:
        target = next(t for t in diag.select_targets(conn, 500) if not conn.execute(
            "select 1 from evidence where measurement_id = %s limit 1", (t,)).fetchone())
    res = diag.run(target, LLM(provider="stub", stub=diagnosis_stub), dry_run=True)
    assert res["output"]["diagnosis_type"] == "citation_gap" and res["output"]["supporting_evidence_ids"] == []
