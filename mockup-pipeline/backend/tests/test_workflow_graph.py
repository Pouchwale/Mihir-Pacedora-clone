"""The visual workflow end to end: jobs walk the seeded graph and record their path; drafts,
validation, publishing and test runs through the editor API; REVIEW and FETCH nodes pause."""

import copy

import pytest

from app.render import headless
from tests.conftest import SAMPLE, needs_poppler, needs_tesseract
from tests.test_workflow import H, _upload, app_client, fake_render  # noqa: F401 - fixture re-export

pytestmark = [needs_poppler, needs_tesseract]


def _login_admin(c):
    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"email": "admin@example.com", "password": "admin-password-1"}).raise_for_status()


def test_job_walks_the_default_graph_and_records_its_path(app_client, monkeypatch):
    monkeypatch.setattr(headless, "render", fake_render)
    c = app_client
    job_id = _upload(c)["jobs"][0]
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "NEEDS_REVIEW" and d["review"]["code"] == "missing_panels"
    wf = d["workflow"]
    assert (wf["key"], wf["version"], wf["kind"]) == ("default", 1, "job")
    assert d["job"]["workflow_key"] == "default" and d["job"]["workflow_version"] == 1
    path = {p["node"]: p for p in wf["path"]}
    assert [p["node"] for p in wf["path"]] == ["start", "prepare", "d_form", "fetch_core", "d_seal", "set_standup", "validate", "keyline", "panels"]
    assert path["d_form"]["branch"] == "ELSE" and path["d_seal"]["branch"] == "Stand-up + bottom gusset"
    assert path["fetch_core"]["status"] == "passed" and "sealing_type" in path["fetch_core"]["reason"]
    assert [s["step"] for s in path["prepare"]["steps"]] == ["ingest", "trim_artwork", "extract_specs"]
    assert path["panels"]["status"] == "review" and d["review"]["node"] == "panels" and d["job"]["current_node"] == "panels"
    assert d["outputs"]["match_pouch_type"]["source"] == "workflow"
    assert len(wf["graph"]["nodes"]) == 22

    # the operator continues: the second walk keeps every finished step and ends at END
    r = c.post(f"/api/jobs/{job_id}/review", json={"action": "panels", "panel_choices": {"back": {"substitute": "front"}, "gusset": {"substitute": "plain", "color": "#29224b"}}}, headers=H)
    assert r.status_code == 200
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "DONE", (d["job"], d.get("review"))
    path = {p["node"]: p for p in d["workflow"]["path"]}
    assert path["prepare"]["cached"] and path["validate"]["cached"] and path["end"]["status"] == "passed"
    assert [s["step"] for s in path["render"]["steps"]] == ["render", "export"]

    # rerun from a node: everything from its first step is redone, the rest stays cached
    r = c.post(f"/api/jobs/{job_id}/rerun", json={"from_node": "build"}, headers=H)
    assert r.status_code == 200
    d = c.get(f"/api/jobs/{job_id}").json()
    path = {p["node"]: p for p in d["workflow"]["path"]}
    assert d["job"]["status"] == "DONE" and path["panels"]["cached"] and not path["build"]["cached"]
    assert d["steps"][7]["step"] == "build_geometry" and d["steps"][7]["attempt"] == 2


def test_editor_draft_validate_publish_and_test_run(app_client, monkeypatch):
    monkeypatch.setattr(headless, "render", fake_render)
    c = app_client
    meta = c.get("/api/workflows/meta").json()
    assert {t["type"] for t in meta["node_types"]} >= {"start", "decision", "fetch", "review", "sub_workflow", "end"}
    assert "pouch_height_mm" in {f["key"] for f in meta["fields"]} and "stand_up_bottom_gusset" in meta["pouch_types"]
    lst = c.get("/api/workflows").json()
    assert [(w["key"], w["published"]["version"], w["draft"]) for w in lst] == [("default", 1, None), ("phase1", 1, None), ("phase2", 1, None), ("phase3", 1, None), ("phase4", 1, None)]
    published = c.get("/api/workflows/default").json()["published"]["graph"]

    # designers may look but not save workflows
    assert c.put("/api/workflows/default/draft", json={"graph": published}, headers=H).status_code == 403
    _login_admin(c)

    # a REVIEW node before the pouch-type decision, with two labelled branches
    draft = copy.deepcopy(published)
    draft["name"] = "Default with a check"
    draft["nodes"].append({"id": "check", "type": "review", "label": "Check the sheet", "message": "Look at the spec table before the type is chosen"})
    draft["edges"] = [e for e in draft["edges"] if e["id"] != "e2"] + [
        {"id": "e2", "source": "prepare", "target": "check"},
        {"id": "c1", "source": "check", "target": "d_form", "label": "Looks right"},
        {"id": "c2", "source": "check", "target": "set_auto", "label": "Skip the tree: match rules"},
    ]
    r = c.put("/api/workflows/default/draft", json={"graph": draft}, headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["draft"]["updated_by"] == "admin@example.com" and body["problems"] == [] and body["published"]["version"] == 1
    assert c.get("/api/workflows").json()[0]["name"] == "Default with a check"

    # validation reports problems without publishing
    broken = copy.deepcopy(draft)
    broken["edges"] = [e for e in broken["edges"] if e["id"] != "e14"]
    p = c.post("/api/workflows/default/validate", json={"graph": broken}, headers=H).json()["problems"]
    assert any("ELSE" in x for x in p)
    assert c.post("/api/workflows/default/publish", json={"reason": "x", "graph": broken}, headers=H).status_code == 422
    laid = c.post("/api/workflows/default/layout", json={"graph": draft}, headers=H).json()["graph"]
    assert {n["id"] for n in laid["nodes"]} == {n["id"] for n in draft["nodes"]}

    # test mode: run a PDF through the draft; the job is a test job, hidden from the jobs list
    with open(SAMPLE, "rb") as fh:
        r = c.post("/api/workflows/default/test", data={"graph": __import__("json").dumps(draft)}, files={"file": (SAMPLE.name, fh, "application/pdf")}, headers=H)
    assert r.status_code == 200, r.text
    test_id = r.json()["job_id"]
    d = c.get(f"/api/jobs/{test_id}").json()
    assert d["job"]["kind"] == "test" and d["job"]["status"] == "NEEDS_REVIEW"
    assert d["review"]["details"]["form"] == "workflow_review" and d["review"]["node"] == "check"
    assert [ch["label"] for ch in d["review"]["details"]["choices"]] == ["Looks right", "Skip the tree: match rules"]
    assert d["workflow"]["kind"] == "test" and d["workflow"]["graph"]["name"] == "Default with a check"
    assert test_id not in {j["id"] for j in c.get("/api/jobs").json()["jobs"]}
    assert test_id in {j["id"] for j in c.get("/api/jobs?kind=test").json()["jobs"]}
    # picking a branch is required when there are several
    assert c.post(f"/api/jobs/{test_id}/review", json={"action": "workflow_review"}, headers=H).status_code == 422
    r = c.post(f"/api/jobs/{test_id}/review", json={"action": "workflow_review", "edge": "c2", "note": "rules are fine"}, headers=H)
    assert r.status_code == 200
    d = c.get(f"/api/jobs/{test_id}").json()
    path = {p["node"]: p for p in d["workflow"]["path"]}
    assert path["check"]["status"] == "passed" and path["check"]["branch"] == "Skip the tree: match rules" and "rules are fine" in path["check"]["reason"]
    assert [p["node"] for p in d["workflow"]["path"]][:5] == ["start", "prepare", "check", "set_auto", "validate"]
    assert d["outputs"]["match_pouch_type"]["source"] == "matched" and d["job"]["pouch_type"] == "stand_up_bottom_gusset"
    assert d["review"]["code"] == "missing_panels"  # then the usual pause
    # rerunning from the review node asks again
    assert c.post(f"/api/jobs/{test_id}/rerun", json={"from_node": "check"}, headers=H).status_code == 200
    assert c.get(f"/api/jobs/{test_id}").json()["review"]["details"]["form"] == "workflow_review"

    # publish: a new index version; the draft is gone; new jobs pin version 2
    r = c.post("/api/workflows/default/publish", json={"reason": "add the check"}, headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["published"]["version"] == 2 and r.json()["draft"] is None
    hist = c.get("/api/index/workflow/default/history").json()
    assert [(h["version"], h["reason"]) for h in hist] == [(2, "add the check"), (1, "seed")]
    job_id = _upload(c)["jobs"][0]
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["workflow_version"] == 2 and d["review"]["details"]["form"] == "workflow_review"
    # a discarded draft leaves the published graph alone
    c.put("/api/workflows/default/draft", json={"graph": published}, headers=H)
    assert c.delete("/api/workflows/default/draft", headers=H).json()["draft"] is None


def test_fetch_node_pauses_for_missing_or_weak_fields(app_client, monkeypatch):
    monkeypatch.setattr(headless, "render", fake_render)
    c = app_client
    _login_admin(c)
    graph = {
        "name": "strict", "nodes": [
            {"id": "s", "type": "start"}, {"id": "p", "type": "prepare"},
            {"id": "f", "type": "fetch", "label": "Needs a perfect client name", "fields": [{"key": "client_name", "min_confidence": 1.0}, {"key": "b2b_width_mm"}]},
            {"id": "e", "type": "end"}],
        "edges": [{"id": "1", "source": "s", "target": "p"}, {"id": "2", "source": "p", "target": "f"}, {"id": "3", "source": "f", "target": "e"}],
    }
    with open(SAMPLE, "rb") as fh:
        r = c.post("/api/workflows/strict/test", data={"graph": __import__("json").dumps(graph)}, files={"file": (SAMPLE.name, fh, "application/pdf")}, headers=H)
    assert r.status_code == 200, r.text
    d = c.get(f"/api/jobs/{r.json()['job_id']}").json()
    review = d["review"]
    assert d["job"]["status"] == "NEEDS_REVIEW" and review["code"] == "fetch_fields" and review["details"]["form"] == "specs"
    assert [i["field"] for i in review["details"]["issues"]] == ["client_name"]
    assert review["details"]["sheet"]["spec_table"]["client_name"]["value"] == "Crystal Enterprises"
    # the operator confirms the value (confidence 1.0): the walk continues to END
    r = c.post(f"/api/jobs/{d['job']['id']}/review", json={"action": "specs", "corrections": {"spec_table.client_name": "Crystal Enterprises"}}, headers=H)
    assert r.status_code == 200
    d = c.get(f"/api/jobs/{d['job']['id']}").json()
    assert d["job"]["status"] == "DONE" and [p["node"] for p in d["workflow"]["path"]] == ["s", "p", "f", "e"]


@pytest.mark.parametrize("bad, message", [
    ({"nodes": [{"id": "s", "type": "start"}], "edges": []}, "no outgoing"),
    ({"nodes": [{"id": "s", "type": "start"}, {"id": "e", "type": "end"}], "edges": [{"id": "1", "source": "s", "target": "e"}, {"id": "1", "source": "s", "target": "e"}]}, "unique"),
])
def test_test_run_refuses_invalid_graphs(app_client, bad, message):
    c = app_client
    with open(SAMPLE, "rb") as fh:
        r = c.post("/api/workflows/x/test", data={"graph": __import__("json").dumps({"name": "x", **bad})}, files={"file": (SAMPLE.name, fh, "application/pdf")}, headers=H)
    assert r.status_code == 422 and message in " ".join(r.json()["detail"]["problems"])
