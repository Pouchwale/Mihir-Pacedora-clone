"""Pausing, resuming and cancelling jobs: at once while queued, between steps while running."""

import pytest
from sqlalchemy import select

from app import db as app_db
from app.models import Job, JobStep
from app.render import headless
from app.workflow import queue
from app.workflow.steps import validate as validate_step
from tests.conftest import SAMPLE, needs_poppler, needs_tesseract
from tests.test_workflow import H, _upload, app_client, fake_render  # noqa: F401 - fixture re-export


def _session():
    """A session on the test database (the fixture makes app.db._factory return the test sessionmaker)."""
    return app_db._factory()()


def _set_control(job_id: int, value: str) -> None:
    """What an operator's click does while the worker is busy: a committed request in another session."""
    with _session() as s:
        job = s.get(Job, job_id)
        job.control = value
        s.commit()


def test_queued_job_pauses_and_cancels_at_once(app_client, engine, monkeypatch):
    runs = []
    monkeypatch.setattr(queue, "enqueue", lambda job_id, from_step=None, from_node=None: runs.append((job_id, from_step)))
    c = app_client
    job_id = _upload(c)["jobs"][0]  # queued, never picked up (queue stubbed)
    assert c.get(f"/api/jobs/{job_id}").json()["job"]["status"] == "QUEUED"
    assert c.post(f"/api/jobs/{job_id}/pause", headers=H).json()["status"] == "PAUSED"
    assert c.post(f"/api/jobs/{job_id}/pause", headers=H).status_code == 409  # not running any more
    assert c.post(f"/api/jobs/{job_id}/resume", headers=H).json()["status"] == "QUEUED"
    assert runs[-1] == (job_id, None)
    assert c.post(f"/api/jobs/{job_id}/cancel", headers=H).json()["status"] == "CANCELLED"
    assert c.post(f"/api/jobs/{job_id}/cancel", headers=H).status_code == 409
    assert c.post(f"/api/jobs/{job_id}/resume", headers=H).status_code == 409
    # a stale queue entry for a cancelled job runs nothing
    from app.workflow import engine as wf_engine

    assert wf_engine.run_job(job_id, engine=engine) == "CANCELLED"
    assert wf_engine.run_job(job_id, from_step="validate", engine=engine) == "CANCELLED"  # (an automatic answer's entry names a step)
    # the operator's answer to a review that is no longer waiting is refused, not applied
    assert c.post(f"/api/jobs/{job_id}/review", json={"action": "pouch_type", "pouch_type": "quad_seal"}, headers=H).status_code == 409
    # a rerun starts it again
    assert c.post(f"/api/jobs/{job_id}/rerun", json={"from_step": "ingest"}, headers=H).json()["status"] == "QUEUED"
    assert runs[-1] == (job_id, "ingest")
    events = [e["message"] for e in c.get(f"/api/jobs/{job_id}").json()["events"]]
    assert any(m.startswith("Paused") for m in events) and any(m.startswith("Cancelled") for m in events)


@needs_poppler
@needs_tesseract
def test_pause_between_steps_then_resume(app_client, monkeypatch):
    """The pause request lands while validate runs: the job stops before match_pouch_type with
    everything up to validate kept; Resume continues from there to the usual missing-panels pause."""
    monkeypatch.setattr(headless, "render", fake_render)
    original = validate_step.run

    def run_then_pause(ctx):
        out = original(ctx)
        _set_control(ctx.job.id, "pause")
        return out

    monkeypatch.setattr(validate_step, "run", run_then_pause)
    c = app_client
    job_id = _upload(c)["jobs"][0]
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "PAUSED", d["job"]
    done = {s["step"] for s in d["steps"] if s["status"] == "done"}
    assert done == {"ingest", "trim_artwork", "extract_specs", "validate"}
    path = {p["node"]: p["status"] for p in d["workflow"]["path"]}
    assert path["prepare"] == "passed" and path["fetch_core"] == "passed" and "keyline" not in path
    assert any(e["message"].startswith("Paused by the operator") for e in d["events"])
    # the review endpoint refuses while paused; adjust / rerun would restart, resume just continues
    assert c.post(f"/api/jobs/{job_id}/review", json={"action": "panels", "panel_choices": {}}, headers=H).status_code == 409
    monkeypatch.setattr(validate_step, "run", original)
    r = c.post(f"/api/jobs/{job_id}/resume", headers=H)
    assert r.status_code == 200
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "NEEDS_REVIEW" and d["review"]["code"] == "missing_panels"
    assert d["steps"][3]["step"] == "validate" and d["steps"][3]["attempt"] == 1  # not run again
    assert {p["node"]: p["cached"] for p in d["workflow"]["path"]}["validate"] is True


@needs_poppler
@needs_tesseract
def test_cancel_between_steps_then_rerun(app_client, monkeypatch):
    monkeypatch.setattr(headless, "render", fake_render)
    original = validate_step.run

    def run_then_cancel(ctx):
        out = original(ctx)
        _set_control(ctx.job.id, "cancel")
        return out

    monkeypatch.setattr(validate_step, "run", run_then_cancel)
    c = app_client
    job_id = _upload(c)["jobs"][0]
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "CANCELLED" and d["job"]["current_node"] is None
    assert d["review"] is None
    monkeypatch.setattr(validate_step, "run", original)
    assert c.post(f"/api/jobs/{job_id}/rerun", json={"from_step": "match_pouch_type"}, headers=H).status_code == 200
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "NEEDS_REVIEW" and d["review"]["code"] == "missing_panels"
    with _session() as s:
        assert s.scalar(select(JobStep).where(JobStep.job_id == job_id, JobStep.step == "validate")).attempt == 1


def test_list_counts_include_the_new_statuses(app_client, monkeypatch):
    monkeypatch.setattr(queue, "enqueue", lambda *a, **k: None)
    c = app_client
    job_id = _upload(c)["jobs"][0]
    c.post(f"/api/jobs/{job_id}/pause", headers=H)
    assert c.get("/api/jobs?status=PAUSED").json()["counts"].get("PAUSED") == 1
    c.post(f"/api/jobs/{job_id}/cancel", headers=H)
    assert [j["status"] for j in c.get("/api/jobs?status=CANCELLED").json()["jobs"]] == ["CANCELLED"]


@pytest.mark.parametrize("path", ["pause", "resume", "cancel"])
def test_controls_need_a_session(app_client, path):
    from fastapi.testclient import TestClient

    from app.api import main

    assert TestClient(main.app).post(f"/api/jobs/1/{path}", headers=H).status_code == 401



def test_jobs_list_is_paged(app_client, monkeypatch):
    """20 jobs per page, newest first, with the total for the pager."""
    monkeypatch.setattr(queue, "enqueue", lambda *a, **k: None)
    c = app_client
    first = _upload(c)["jobs"][0]
    with _session() as s:
        template = s.get(Job, first)
        for _ in range(24):  # 25 jobs in all
            s.add(Job(file_id=template.file_id, batch_id=template.batch_id, item_code=template.item_code, status="DONE", current_step="done", kind="job"))
        s.commit()
    page1 = c.get("/api/jobs").json()
    assert len(page1["jobs"]) == 20 and page1["total"] == 25 and page1["offset"] == 0
    page2 = c.get("/api/jobs?offset=20").json()
    assert len(page2["jobs"]) == 5 and page2["total"] == 25
    ids = [j["id"] for j in page1["jobs"]] + [j["id"] for j in page2["jobs"]]
    assert ids == sorted(ids, reverse=True) and len(set(ids)) == 25  # newest first, no job twice
    assert c.get("/api/jobs?status=DONE").json()["total"] == 24  # the total follows the filter
    assert c.get("/api/jobs?offset=40").json()["jobs"] == []
