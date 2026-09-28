"""Load validated rows into the V1 tables.

Flow (one transaction — all or nothing):
  1. take an advisory lock so two uploads can't interleave
  2. empty stg_rankscale_export and COPY the clean rows into it
  3. run db/03_load_rankscale.sql (the same script used manually in Supabase)
  4. count what was added, empty the staging table, record the batch
"""
from __future__ import annotations

import json
import uuid

from psycopg import sql as pgsql

from .db import connect, sql_file
from .ingest import KEEP, IngestReport

LOCK_KEY = 874203  # arbitrary constant for pg_advisory_xact_lock

COUNT_SQL = """
select (select count(*) from measurements)          as measurements,
       (select count(*) from measurement_mentions)  as mentions,
       (select count(*) from evidence)              as evidence,
       (select count(*) from prompts)               as prompts,
       (select count(*) from competitors)           as competitors
"""


def own_brand_match(name: str, aliases: list[str], prop_name: str) -> bool:
    """Python twin of public.is_own_brand() — used before anything is written."""
    n = (name or "").strip().lower()
    for a in list(aliases or []) + [prop_name]:
        a = a.strip().lower()
        if a.endswith("*") and n.startswith(a[:-1]):
            return True
        if n == a:
            return True
    return False


def check_brand_references(conn, rows: list[dict], rep: IngestReport) -> None:
    props = conn.execute("select name, aliases from properties").fetchall()
    refs = {r["brand_reference"] for r in rows}
    unmatched = [ref for ref in refs
                 if not any(own_brand_match(ref, p["aliases"], p["name"]) for p in props)]
    if unmatched and props:
        n = sum(1 for r in rows if r["brand_reference"] in unmatched)
        rep.warnings.append({"message": f"{n} rows are for a brand that isn't set up as a property yet "
                                        "and will be skipped. Add the property (with aliases) first.",
                             "brand_references": sorted(unmatched)})


def load_rows(rows: list[dict], rep: IngestReport, uploaded_by: str | None = None) -> dict:
    batch_id = uuid.uuid4()
    loader_sql = sql_file("03_load_rankscale.sql")
    with connect() as conn:
        with conn.transaction():
            conn.execute("select pg_advisory_xact_lock(%s)", (LOCK_KEY,))
            before = conn.execute(COUNT_SQL).fetchone()
            conn.execute("truncate public.stg_rankscale_export")
            cols = pgsql.SQL(", ").join(pgsql.Identifier(c) for c in KEEP)
            copy_stmt = pgsql.SQL("copy public.stg_rankscale_export ({}) from stdin").format(cols)
            with conn.cursor().copy(copy_stmt) as cp:
                for r in rows:
                    cp.write_row([r[c] for c in KEEP])
            conn.execute("select set_config('geo.import_batch', %s, true)", (str(batch_id),))
            conn.execute(loader_sql)
            # tag new prompts as neutral / brand-location (07_report.sql), if that migration has run
            if conn.execute("select to_regproc('public.seed_coogee_report') is not null as ok").fetchone()["ok"]:
                conn.execute("select public.seed_coogee_report()")          # competitor set, benchmarks
            if conn.execute("select to_regproc('public.classify_neutral_prompts') is not null as ok").fetchone()["ok"]:
                conn.execute("select public.classify_neutral_prompts()")
            after = conn.execute(COUNT_SQL).fetchone()
            conn.execute("truncate public.stg_rankscale_export")
            added = {k: after[k] - before[k] for k in after}
            conn.execute(
                """insert into import_batches (id, filename, uploaded_by, status, rows_in_file, rows_valid,
                                               rows_rejected, measurements_added, mentions_added,
                                               evidence_added, report)
                   values (%s, %s, %s, 'loaded', %s, %s, %s, %s, %s, %s, %s)""",
                (batch_id, rep.filename, uploaded_by, rep.rows_in_file, rep.rows_valid, rep.rows_rejected,
                 added["measurements"], added["mentions"], added["evidence"],
                 json.dumps(rep.as_dict(), default=str)))
    return {"batch_id": str(batch_id), "added": added}


def record_rejected(rep: IngestReport, uploaded_by: str | None = None) -> str:
    batch_id = uuid.uuid4()
    with connect() as conn:
        conn.execute(
            """insert into import_batches (id, filename, uploaded_by, status, rows_in_file, rows_valid,
                                           rows_rejected, report)
               values (%s, %s, %s, 'rejected', %s, %s, %s, %s)""",
            (batch_id, rep.filename, uploaded_by, rep.rows_in_file, rep.rows_valid, rep.rows_rejected,
             json.dumps(rep.as_dict(), default=str)))
        conn.commit()
    return str(batch_id)
