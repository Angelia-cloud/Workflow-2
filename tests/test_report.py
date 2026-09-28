"""The report endpoint: every section present, and numbers follow the documented formula."""
from fastapi.testclient import TestClient

from app.db import connect
from app.main import app

client = TestClient(app)


def _pid():
    with connect() as conn:
        return str(conn.execute("select id from properties limit 1").fetchone()["id"])


def test_report_sections_and_formula():
    pid = _pid()
    r = client.get(f"/api/report/{pid}")
    assert r.status_code == 200, r.text
    d = r.json()
    for key in ("overall", "trend", "engines", "intents", "competitors", "neutral_vs_benchmark",
                "intent_competition", "sources", "insights", "period"):
        assert key in d, key
    vis = next(o for o in d["overall"] if o["metric"] == "visibility")["current"]
    with connect() as conn:
        expected = conn.execute("""
            select round(avg(case when brand_found then 100.0/(1+0.1*(own_brand_rank-1)) else 0 end), 2) v
            from v_measurements_flat
            where (measured_at at time zone 'Australia/Sydney')::date between %s and %s""",
            (d["period"]["from"], d["period"]["to"])).fetchone()["v"]
    assert abs(vis - float(expected)) < 0.01
    assert d["competitors"][0]["is_self"]


def test_all_names_mode_and_notes():
    pid = _pid()
    rs = client.get(f"/api/report/{pid}").json()
    al = client.get(f"/api/report/{pid}?names=all").json()
    det = lambda d: next(o for o in d["overall"] if o["metric"] == "detection")["current"]
    assert det(al) >= det(rs)   # counting every hotel name can only find more
    key = rs["period"]["key"]
    assert client.put(f"/api/report/{pid}/notes", json={"period_key": key, "section": "monitor_next",
                                                         "body": "test note", "updated_by": "test"}).status_code == 200
    assert client.get(f"/api/report/{pid}").json()["notes"]["monitor_next"]["body"] == "test note"
    with connect() as conn:
        conn.execute("delete from report_notes where updated_by = 'test'"); conn.commit()
