"""End-to-end test of the import gateway against a real Postgres.
Run: DATABASE_URL=... RANKSCALE_FILE=path/to/export.csv python -m pytest -q tests/test_import.py
"""
import os
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)
RAW = os.environ.get("RANKSCALE_FILE", "sample_data/rankscale_export_sample.csv")


def test_rejects_non_rankscale_file():
    r = client.post("/api/imports", files={"file": ("x.csv", b"a,b\n1,2\n")}, data={"dry_run": "true"})
    assert r.status_code == 422
    assert "required columns" in r.json()["detail"]["message"]


def test_dry_run_then_load_then_reload_is_idempotent():
    raw = open(RAW, "rb").read()
    r = client.post("/api/imports", files={"file": ("export.csv", raw)}, data={"dry_run": "true"})
    assert r.status_code == 200, r.text
    rep = r.json()["report"]
    assert rep["ok"] and rep["rows_rejected"] == 0
    r1 = client.post("/api/imports", files={"file": ("export.csv", raw)}, data={"uploaded_by": "test"})
    assert r1.status_code == 200, r1.text
    assert r1.json()["added"]["measurements"] >= 0          # 0 if this file was loaded before
    r2 = client.post("/api/imports", files={"file": ("export.csv", raw)}, data={"uploaded_by": "test"})
    assert r2.json()["added"]["measurements"] == 0          # nothing duplicated
    assert len(client.get("/api/imports").json()) >= 2
