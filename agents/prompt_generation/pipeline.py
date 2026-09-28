"""Upstream workflow: three agents that generate new prompts for Rankscale to track.

    Agent 1  Intent Mapper   brief + current visibility  → which intents need prompts, how many
    Agent 2  Prompt Writer   one call per intent          → draft traveller prompts
    Agent 3  Prompt QA       automatic checks + LLM review → keep / rewrite / reject, quality score

Results are saved to Supabase (prompt_generation_runs + prompts with status 'candidate'), a human
approves them in the UI, and export_rankscale_csv() writes the file you import into Rankscale.
When Rankscale's next export is uploaded, those prompts flip to status 'tracked' automatically.

CLI:
    python -m agents.prompt_generation.pipeline --total 30
    python -m agents.prompt_generation.pipeline --total 30 --dry-run
    python -m agents.prompt_generation.pipeline --export out/rankscale_import.csv --status approved
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
from pathlib import Path

from app.db import connect

from ..llm import LLM
from . import prompts as P
from .schema import DraftPrompt, DraftPrompts, IntentMap, PromptReviews

BRIEF_DIR = Path(__file__).parent / "briefs"
MIN_WORDS, MAX_WORDS = 8, 40
DUP_THRESHOLD = 0.72
STOP = set("a an the in on at for of to and or with is are i we my our can me should which what where "
           "that this be near from sydney hotel hotels".split())


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9']+", text.lower()) if t not in STOP}


def similarity(a: str, b: str) -> float:
    ta, tb = tokens(a), tokens(b)
    return len(ta & tb) / len(ta | tb) if ta and tb else 0.0


def load_brief(property_name: str) -> dict:
    path = BRIEF_DIR / f"{slug(property_name)}.json"
    if not path.exists():
        raise FileNotFoundError(f"No brief for {property_name!r} — create {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def load_context(conn, property_id: str) -> dict:
    prop = conn.execute("select id, name, aliases, ignored_names from properties where id = %s",
                        (property_id,)).fetchone()
    intents = conn.execute("""
        select i.id, i.name, i.description,
               (select count(*) from prompts p where p.intent_id = i.id and p.status <> 'rejected') as prompts,
               (select round(avg(brand_found_any_alias::int), 3) from v_measurements_flat f
                 where f.intent_id = i.id) as visibility
        from intents i where i.property_id = %s order by i.name""", (property_id,)).fetchall()
    existing = conn.execute("""
        select i.name as intent, p.prompt_text, p.status from prompts p
        join intents i on i.id = p.intent_id
        where i.property_id = %s and p.status <> 'rejected'""", (property_id,)).fetchall()
    comps = conn.execute("""
        select intent, competitor, share_of_answers::float as share from (
          select *, row_number() over (partition by intent order by answers_mentioning desc) rn
          from v_competitor_share where property_id = %s) x where rn <= 3""", (property_id,)).fetchall()
    for i in intents:
        i["visibility"] = float(i["visibility"]) if i["visibility"] is not None else None
        i["top_competitors"] = [c["competitor"] for c in comps if c["intent"] == i["name"]]
        i["id"] = str(i["id"])
    return {"property": prop, "intents": intents, "existing": existing}


def auto_checks(p: DraftPrompt, existing_texts: list[str], earlier: list[str], brand_names: list[str]) -> dict:
    words = len(p.prompt_text.split())
    text = p.prompt_text.lower()
    leak = [b for b in brand_names if b and b.rstrip("*").lower() in text]
    dup_existing = max(((similarity(p.prompt_text, e), e) for e in existing_texts), default=(0, None))
    dup_batch = max(((similarity(p.prompt_text, e), e) for e in earlier), default=(0, None))
    return {
        "word_count": words,
        "length_ok": MIN_WORDS <= words <= MAX_WORDS,
        "brand_leak": leak if p.prompt_type != "branded" else [],
        "closest_existing": {"similarity": round(dup_existing[0], 2), "text": dup_existing[1]},
        "closest_in_batch": {"similarity": round(dup_batch[0], 2), "text": dup_batch[1]},
        "duplicate": dup_existing[0] >= DUP_THRESHOLD or dup_batch[0] >= DUP_THRESHOLD,
    }


# ---------------------------------------------------------------------------
# the three agents
# ---------------------------------------------------------------------------
def agent1_intent_mapper(llm: LLM, brief: dict, ctx: dict, total: int, focus: str | None) -> IntentMap:
    user = json.dumps({
        "BRIEF": brief,
        "CURRENT_INTENTS": [{k: i[k] for k in ("name", "description", "prompts", "visibility", "top_competitors")}
                            for i in ctx["intents"]],
        "REQUEST": {"total_prompts": total, "focus": focus or "none"},
    }, ensure_ascii=False, default=str)
    return llm.json(P.INTENT_MAPPER, user, IntentMap)


def agent2_prompt_writer(llm: LLM, brief: dict, intent, existing: list[str]) -> list[DraftPrompt]:
    user = json.dumps({"INTENT": intent.model_dump(), "BRIEF": brief,
                       "EXISTING_PROMPTS": existing, "COUNT": intent.prompts_to_generate},
                      ensure_ascii=False)
    out = llm.json(P.PROMPT_WRITER, user, DraftPrompts)
    for d in out.prompts:
        d.intent = intent.name            # keep the mapper's intent name, whatever the writer echoed
    return out.prompts[: intent.prompts_to_generate]


def agent3_prompt_qa(llm: LLM, drafts: list[DraftPrompt], checks: list[dict]) -> PromptReviews:
    def brief_checks(c):  # only what the reviewer needs, to keep the request small
        return {"word_count": c["word_count"], "length_ok": c["length_ok"], "brand_leak": c["brand_leak"],
                "duplicate": c["duplicate"],
                "closest_existing_similarity": c["closest_existing"]["similarity"]}
    user = json.dumps({"PROMPTS": [{"index": n, "prompt_text": d.prompt_text, "intent": d.intent,
                                    "prompt_type": d.prompt_type, "CHECKS": brief_checks(checks[n])}
                                   for n, d in enumerate(drafts)]}, ensure_ascii=False)
    return llm.json(P.PROMPT_QA, user, PromptReviews)


# ---------------------------------------------------------------------------
# orchestration
# ---------------------------------------------------------------------------
def generate(property_id: str, total: int = 30, focus: str | None = None, llm: LLM | None = None,
             dry_run: bool = False, created_by: str | None = None) -> dict:
    llm = llm or LLM()
    with connect() as conn:
        ctx = load_context(conn, property_id)
        prop = ctx["property"]
        brief = load_brief(prop["name"])
        brand_names = list(prop["aliases"]) + [prop["name"], "InterContinental", "IHG"]

        # Agent 1
        imap = agent1_intent_mapper(llm, brief, ctx, total, focus)

        # Agent 2 + automatic checks
        existing_by_intent: dict[str, list[str]] = {}
        for e in ctx["existing"]:
            existing_by_intent.setdefault(e["intent"], []).append(e["prompt_text"])
        all_existing = [e["prompt_text"] for e in ctx["existing"]]
        drafts, checks = [], []
        for intent in imap.intents:
            for d in agent2_prompt_writer(llm, brief, intent, existing_by_intent.get(intent.name, [])):
                checks.append(auto_checks(d, all_existing, [x.prompt_text for x in drafts], brand_names))
                drafts.append(d)

        # Agent 3
        reviews = {r.index: r for r in agent3_prompt_qa(llm, drafts, checks).reviews}
        final = []
        for n, d in enumerate(drafts):
            r = reviews.get(n)
            c = checks[n]
            decision = r.decision if r else "reject"
            text = d.prompt_text
            if r and decision == "rewrite" and r.rewritten_text:
                text = r.rewritten_text.strip()
                c = auto_checks(DraftPrompt(**{**d.model_dump(), "prompt_text": text}),
                                all_existing, [f["prompt_text"] for f in final], brand_names)
            # automatic checks can overrule the model
            if c["brand_leak"] or c["duplicate"] or not c["length_ok"]:
                decision = "reject"
            score = round((r.realism + r.intent_fit + r.measurability) / 3, 2) if r else 0.0
            final.append({**d.model_dump(), "prompt_text": text, "decision": decision,
                          "quality_score": score, "review_reason": r.reason if r else "not reviewed",
                          "checks": c})

        kept = [f for f in final if f["decision"] != "reject"]
        summary = {"drafted": len(drafts), "kept": len(kept), "rejected": len(final) - len(kept),
                   "by_intent": {i.name: sum(1 for f in kept if f["intent"] == i.name) for i in imap.intents}}
        result = {"intent_map": imap.model_dump(), "prompts": final, "summary": summary}
        if dry_run:
            return result

        run = conn.execute("""
            insert into prompt_generation_runs (property_id, model, inputs, intent_map, summary, created_by)
            values (%s, %s, %s, %s, %s, %s) returning id""",
            (property_id, llm.label, json.dumps({"total": total, "focus": focus, "brief": brief["property_name"]}),
             json.dumps(imap.model_dump()), json.dumps(summary), created_by)).fetchone()
        for i in imap.intents:
            conn.execute("""insert into intents (property_id, name, description) values (%s, %s, %s)
                            on conflict (property_id, name) do nothing""",
                         (property_id, i.name, i.description))
        saved = 0
        for f in final:
            status = "candidate" if f["decision"] != "reject" else "rejected"
            cur = conn.execute("""
                insert into prompts (intent_id, prompt_text, source, status, generation_run_id,
                                     prompt_type, persona, rationale, quality_score, is_active)
                select id, %s, 'prompt_agent', %s, %s, %s, %s, %s, %s, false
                from intents where property_id = %s and name = %s
                on conflict (intent_id, prompt_text) do nothing""",
                (f["prompt_text"], status, run["id"], f["prompt_type"], f["persona"],
                 f"{f['rationale']} | QA: {f['review_reason']}", f["quality_score"], property_id, f["intent"]))
            saved += cur.rowcount
        conn.commit()
        result.update({"run_id": str(run["id"]), "saved": saved})
        return result


def export_rankscale_csv(property_id: str, statuses=("approved",), run_id: str | None = None,
                         mark_exported: bool = True) -> str:
    """CSV to import into Rankscale → Search Terms. One row per prompt: search term + topic.
    Check the column names against Rankscale's import screen; rename here if they differ."""
    with connect() as conn:
        rows = conn.execute("""
            select p.id, p.prompt_text, i.name as topic, p.prompt_type
            from prompts p join intents i on i.id = p.intent_id
            where i.property_id = %s and p.status = any(%s)
              and (%s::uuid is null or p.generation_run_id = %s::uuid)
            order by i.name, p.quality_score desc nulls last""",
            (property_id, list(statuses), run_id, run_id)).fetchall()
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["search_term", "topic", "tags"])
        for r in rows:
            w.writerow([r["prompt_text"], r["topic"], f"agent,{r['prompt_type'] or ''}".rstrip(",")])
        if mark_exported and rows:
            conn.execute("update prompts set status = 'exported' where id = any(%s)", ([r["id"] for r in rows],))
            conn.commit()
        return buf.getvalue()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--property", default="InterContinental Sydney Coogee Beach")
    ap.add_argument("--total", type=int, default=30)
    ap.add_argument("--focus")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--export", help="write a Rankscale import CSV to this path instead of generating")
    ap.add_argument("--status", default="approved", help="comma-separated statuses to export")
    a = ap.parse_args()
    with connect() as conn:
        pid = str(conn.execute("select id from properties where name = %s", (a.property,)).fetchone()["id"])
    if a.export:
        Path(a.export).write_text(export_rankscale_csv(pid, tuple(a.status.split(","))), encoding="utf-8")
        print(f"wrote {a.export}")
        return
    print(json.dumps(generate(pid, a.total, a.focus, dry_run=a.dry_run), indent=2, default=str))


if __name__ == "__main__":
    main()
