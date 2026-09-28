"""Parse, clean and validate a Rankscale export before it touches the database.

Rankscale's "CSV" download is really UTF-16, tab-separated text with line
breaks inside some fields. This module accepts that format, and also plain
UTF-8 comma-separated files (e.g. one re-saved from Excel or produced by
scripts/convert_rankscale.py), and returns clean rows plus a report.
"""
from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from datetime import datetime

# ---------------------------------------------------------------------------
# Column rules (see docs/data_spec.md for the reasoning behind each)
# ---------------------------------------------------------------------------
REQUIRED = [
    "timestamp", "brand_reference", "topic_name", "query", "ai_engine",
    "brand_found", "result_text",
]
RANKS = range(1, 16)
RANK_FIELDS = ["brandname", "citations", "sentiment", "sentiment_reason",
               "positive_keywords", "neutral_keywords", "negative_keywords"]

# every column the loader (db/03_load_rankscale.sql) reads; others are dropped
KEEP = [
    "timestamp", "brand_reference", "topic_name", "query", "ai_engine",
    "ai_overview", "chatgpt_websearch", "chatgpt_model",
    "web_search_queries", "related_prompts", "result_text",
    "brands_total", "brand_found", "brand_name_mentioned", "brand_rank",
    "brand_citations", "sentiment", "sentiment_reason",
    "positive_keywords", "neutral_keywords", "negative_keywords",
    "other_citations",
    "visibility_score_latest", "visibility_score_24h", "visibility_score_7d", "visibility_score_30d",
] + [f"rank{i}_{f}" for i in RANKS for f in RANK_FIELDS]

BOOL_COLS = {"ai_overview", "chatgpt_websearch", "brand_found"}
INT_COLS = {"brands_total", "brand_rank"}
NUM_COLS = {"sentiment", "visibility_score_latest", "visibility_score_24h",
            "visibility_score_7d", "visibility_score_30d"} | {f"rank{i}_sentiment" for i in RANKS}
NULLS = {"-", "N/A", "n/a", "NA", "null", "NULL", "None", ""}

MAX_REJECT_SHARE = 0.10   # refuse the whole file if more than 10% of rows are bad


@dataclass
class IngestReport:
    filename: str
    encoding: str = ""
    delimiter: str = ""
    rows_in_file: int = 0
    rows_valid: int = 0
    rows_rejected: int = 0
    columns_dropped: list[str] = field(default_factory=list)
    columns_missing_optional: list[str] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)      # file-level or row-level problems
    warnings: list[dict] = field(default_factory=list)
    summary: dict = field(default_factory=dict)            # engines, intents, date range…

    @property
    def ok(self) -> bool:
        return not any(e.get("level") == "file" for e in self.errors)

    def as_dict(self) -> dict:
        d = self.__dict__.copy()
        d["ok"] = self.ok
        d["errors"] = self.errors[:200]
        d["warnings"] = self.warnings[:200]
        return d


# ---------------------------------------------------------------------------
def decode(raw: bytes) -> tuple[str, str]:
    """Return (text, encoding). Handles UTF-16 (with/without BOM), UTF-8, UTF-8-BOM."""
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16"), "utf-16"
    # UTF-16 without BOM: every other byte is NUL in mostly-ASCII text
    sample = raw[:4000]
    if sample and sample.count(b"\x00") > len(sample) // 4:
        enc = "utf-16-le" if sample[1:2] == b"\x00" else "utf-16-be"
        return raw.decode(enc), enc
    try:
        return raw.decode("utf-8-sig"), "utf-8"
    except UnicodeDecodeError:
        return raw.decode("cp1252"), "cp1252"


def clean_value(col: str, val: str) -> str | None:
    val = (val or "").strip()
    if val in NULLS:
        return None
    if col == "result_text" and val.startswith("'"):
        val = val[1:]                     # Excel formula guard Rankscale adds
    if col in BOOL_COLS:
        low = val.lower()
        if low in ("yes", "true", "1"):
            return "true"
        if low in ("no", "false", "0"):
            return "false"
        raise ValueError(f"expected yes/no, got {val!r}")
    if col in INT_COLS:
        if not re.fullmatch(r"-?\d+", val):
            raise ValueError(f"expected a whole number, got {val!r}")
    if col in NUM_COLS:
        try:
            float(val)
        except ValueError:
            raise ValueError(f"expected a number, got {val!r}") from None
    if col == "timestamp":
        try:
            datetime.fromisoformat(val.replace("Z", "+00:00"))
        except ValueError:
            raise ValueError(f"expected an ISO timestamp, got {val!r}") from None
    return val


def parse_rankscale(raw: bytes, filename: str = "upload.csv") -> tuple[list[dict], IngestReport]:
    rep = IngestReport(filename=filename)
    text, rep.encoding = decode(raw)
    first_line = text.split("\n", 1)[0]
    rep.delimiter = "\t" if first_line.count("\t") > first_line.count(",") else ","
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=rep.delimiter)
    try:
        header = [h.strip().lstrip("﻿") for h in next(reader)]
    except StopIteration:
        rep.errors.append({"level": "file", "message": "The file is empty."})
        return [], rep

    missing = [c for c in REQUIRED if c not in header]
    if missing:
        rep.errors.append({"level": "file",
                           "message": "This doesn't look like a Rankscale export — required columns are missing.",
                           "columns": missing})
        return [], rep
    rep.columns_dropped = [c for c in header if c not in KEEP]
    rep.columns_missing_optional = [c for c in KEEP if c not in header]
    idx = {c: header.index(c) for c in KEEP if c in header}

    rows: list[dict] = []
    for line_no, r in enumerate(reader, start=2):
        if not any(x.strip() for x in r):
            continue
        rep.rows_in_file += 1
        if len(r) != len(header):
            rep.rows_rejected += 1
            rep.errors.append({"level": "row", "row": line_no,
                               "message": f"has {len(r)} columns, expected {len(header)}"})
            continue
        clean, problems = {}, []
        for c in KEEP:
            if c not in idx:
                clean[c] = None
                continue
            try:
                clean[c] = clean_value(c, r[idx[c]])
            except ValueError as e:
                problems.append(f"{c}: {e}")
        for c in REQUIRED:
            if c != "result_text" and not clean.get(c):
                problems.append(f"{c} is empty")
        if problems:
            rep.rows_rejected += 1
            rep.errors.append({"level": "row", "row": line_no, "message": "; ".join(problems)})
            continue
        rows.append(clean)

    rep.rows_valid = len(rows)
    if rep.rows_in_file == 0:
        rep.errors.append({"level": "file", "message": "The file has a header but no data rows."})
    elif rep.rows_rejected / rep.rows_in_file > MAX_REJECT_SHARE:
        rep.errors.append({"level": "file",
                           "message": f"{rep.rows_rejected} of {rep.rows_in_file} rows failed validation "
                                      f"(limit {MAX_REJECT_SHARE:.0%}); nothing was loaded."})

    if rows:
        ts = sorted(r["timestamp"] for r in rows)
        answers = {(r["query"], r["ai_engine"], r["timestamp"]) for r in rows}
        rep.summary = {
            "date_from": ts[0], "date_to": ts[-1],
            "brand_references": sorted({r["brand_reference"] for r in rows}),
            "engines": sorted({r["ai_engine"] for r in rows}),
            "intents": sorted({r["topic_name"] for r in rows}),
            "prompts": len({r["query"] for r in rows}),
            "distinct_answers": len(answers),
            "duplicate_rows_merged": len(rows) - len(answers),
        }
        if len(rows) > len(answers):
            rep.warnings.append({"message": f"{len(rows) - len(answers)} rows repeat an answer already in the "
                                            "file (Rankscale writes one row per brand name it spots). "
                                            "They are merged, not double-counted."})
    return rows, rep
