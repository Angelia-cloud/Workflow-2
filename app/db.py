"""Database access. Uses a direct Postgres connection to Supabase.

Set DATABASE_URL to the connection string from Supabase:
  Project → Connect → "Session pooler" (or "Direct connection") → URI
e.g. postgresql://postgres.<ref>:<password>@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parent.parent
DB_DIR = ROOT / "db"


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set — copy .env.example to .env and fill it in.")
    return url


@contextmanager
def connect():
    with psycopg.connect(database_url(), row_factory=dict_row, autocommit=False) as conn:
        yield conn


def fetch_all(sql: str, params: dict | tuple | None = None) -> list[dict]:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def fetch_one(sql: str, params: dict | tuple | None = None) -> dict | None:
    rows = fetch_all(sql, params)
    return rows[0] if rows else None


def sql_file(name: str) -> str:
    return (DB_DIR / name).read_text(encoding="utf-8")
