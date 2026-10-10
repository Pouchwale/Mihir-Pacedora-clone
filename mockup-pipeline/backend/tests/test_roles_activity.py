"""Roles (admin, head of design, designer, manager), the Users page's account controls, and the
activity log and upload copies in the data folder."""

import json
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import activity, auth
from app.config import get_settings
from app.models import User
from tests.test_api import H, client, login  # noqa: F401 - fixture re-export

PASSWORDS = {r: f"{r}-password-1" for r in ("head_designer", "designer", "manager")}


@pytest.fixture
def staff(client, seeded, tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "data_dir", tmp_path / "data")  # a fresh data folder per test
    seeded.add_all([User(email=f"{r}@example.com", role=r, password_hash=auth.hash_password(p)) for r, p in PASSWORDS.items()])
    seeded.commit()
    return client


def as_role(c, role):
    c.post("/api/auth/logout")
    return login(c, f"{role}@example.com", PASSWORDS[role])


def _today() -> list[dict]:
    path = Path(get_settings().data_dir) / "logs" / "activity" / f"{date.today().isoformat()}.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_what_each_role_may_change(staff):
    c = staff
    client_entry = {"data": {"client_name": "X"}, "reason": "r"}
    as_role(c, "designer")
    keyline = c.get("/api/index/keyline_template/stand_up_bottom_gusset").json()
    assert keyline["data"]  # everyone reads the index

    # designer: the index, but not keyline / dieline values or workflows
    assert c.put("/api/index/client/x", json=client_entry, headers=H).status_code == 200
    r = c.put("/api/index/keyline_template/stand_up_bottom_gusset", json={"data": keyline["data"], "reason": "r"}, headers=H)
    assert r.status_code == 403 and "keyline" in r.json()["detail"]
    for kind in ("pouch_type", "standard_size"):
        assert c.put(f"/api/index/{kind}/x", json={"data": {}, "reason": "r"}, headers=H).status_code == 403
    graph = c.get("/api/workflows/default").json()["published"]["graph"]
    assert c.put("/api/workflows/default/draft", json={"graph": graph}, headers=H).status_code == 403
    assert c.post("/api/index/import", json={"yaml": ""}, headers=H).status_code == 403
    # an item override is the designer's, except its keyline values
    assert c.put("/api/index/item_override/fgpo1", json={"data": {"notes": "n"}, "reason": "r"}, headers=H).status_code == 200
    r = c.put("/api/index/item_override/fgpo1", json={"data": {"keyline_overrides": {"zipper_offset_from_top_mm": 30}}, "reason": "r"}, headers=H)
    assert r.status_code == 403
    assert c.get("/api/users").status_code == 403 and c.get("/api/activity").status_code == 403
    assert set(c.get("/api/auth/me").json()["permissions"]) == {"edit_index"}

    # head of design: keyline values and workflows too, but no users or activity log
    as_role(c, "head_designer")
    r = c.put("/api/index/keyline_template/stand_up_bottom_gusset", json={"data": keyline["data"], "reason": "same"}, headers=H)
    assert r.status_code == 200, r.text
    assert c.put("/api/workflows/default/draft", json={"graph": graph}, headers=H).status_code == 200
    assert c.get("/api/users").status_code == 403 and c.get("/api/activity").status_code == 403

    # manager: reads everything and sees the activity log; changes nothing in the index
    as_role(c, "manager")
    assert c.put("/api/index/client/y", json=client_entry, headers=H).status_code == 403
    assert c.get("/api/activity").status_code == 200 and c.get("/api/users").status_code == 403
    assert {r["role"] for r in c.get("/api/roles").json()} == {"admin", "head_designer", "designer", "manager"}


def test_admin_controls_accounts_and_every_change_is_logged(staff):
    c = staff
    login(c)
    users = {u["email"]: u for u in c.get("/api/users").json()}
    d = users["designer@example.com"]

    # rename the sign-in email and name, change the role: the user's open sessions end
    other = TestClient(c.app)  # the designer's own browser
    login(other, "designer@example.com", PASSWORDS["designer"])
    r = c.patch(f"/api/users/{d['id']}", json={"email": "Lead@Example.com", "name": "Lead", "role": "head_designer"}, headers=H)
    assert r.status_code == 200 and (r.json()["email"], r.json()["role"]) == ("lead@example.com", "head_designer")
    assert other.get("/api/auth/me").status_code == 401
    assert c.patch(f"/api/users/{d['id']}", json={"email": "manager@example.com"}, headers=H).status_code == 409

    # lock-out after wrong passwords, cleared by the admin; a new password works, the old does not
    for _ in range(auth.MAX_FAILED):
        other.post("/api/auth/login", json={"email": "lead@example.com", "password": "wrong"})
    assert next(u for u in c.get("/api/users").json() if u["id"] == d["id"])["locked"]
    assert c.patch(f"/api/users/{d['id']}", json={"unlock": True, "password": "brand-new-pass-1"}, headers=H).json()["locked"] is False
    assert other.post("/api/auth/login", json={"email": "lead@example.com", "password": PASSWORDS["designer"]}).status_code == 401
    login(other, "lead@example.com", "brand-new-pass-1")

    # deactivate: signed out at once and cannot sign in; sign-out-everywhere for an active user
    assert c.patch(f"/api/users/{d['id']}", json={"active": False}, headers=H).json()["active"] is False
    assert other.get("/api/auth/me").status_code == 401
    assert other.post("/api/auth/login", json={"email": "lead@example.com", "password": "brand-new-pass-1"}).status_code == 401
    m = users["manager@example.com"]
    login(other, "manager@example.com", PASSWORDS["manager"])
    assert c.post(f"/api/users/{m['id']}/sign-out", headers=H).json()["sessions_ended"] == 1
    assert other.get("/api/auth/me").status_code == 401

    log = _today()
    changed = [e for e in log if e["action"] == "user changed" and e["user"] == "admin@example.com"]
    assert changed[0]["changes"]["email"] == ["designer@example.com", "lead@example.com"]
    assert any(e["changes"].get("credentials_reset") for e in changed)
    assert any(e["action"] == "sign-in failed" and e["email"] == "lead@example.com" for e in log)
    assert any(e["action"] == "user signed out by admin" for e in log)
    text = json.dumps(log)
    assert "brand-new-pass-1" not in text and PASSWORDS["designer"] not in text  # never a password
    # every API call is a line too, with who made it
    assert any(e["action"] == "request" and e["method"] == "PATCH" and e["user"] == "admin@example.com" for e in log)

    # the admin reads it on the activity page: filtered by user, reads hidden unless asked
    out = c.get("/api/activity", params={"user": "admin@example.com"}).json()
    assert out["entries"] and all(e["user"] == "admin@example.com" for e in out["entries"])
    assert not any(e.get("method") == "GET" for e in out["entries"])
    assert any(e.get("method") == "GET" for e in c.get("/api/activity", params={"reads": True}).json()["entries"])
    c.post("/api/activity", json={"page": "/jobs"}, headers=H)
    assert c.get("/api/activity", params={"action": "page"}).json()["entries"][0]["page"] == "/jobs"


def test_upload_copies_and_share_tokens_never_logged(staff):
    user = User(email="designer@example.com", role="designer")
    path = activity.keep_upload(user, "../FGPO1 Front App.pdf", b"%PDF-1.4", 12)
    assert path.read_bytes() == b"%PDF-1.4" and path.parent.name == "designer@example.com"
    assert path.name.endswith("_b12_FGPO1_Front_App.pdf") and Path(get_settings().data_dir).resolve() in path.resolve().parents
    activity.record("request", None, None, path="/api/jobs/1/scene", query={"token": "1.2.secret"})
    assert _today()[-1]["query"] == {"token": "***"}


def test_activity_pages_and_output_folder(staff):
    c = staff
    login(c)
    for i in range(25):
        c.post("/api/activity", json={"page": f"/jobs/{i}"}, headers=H)
    first = c.get("/api/activity", params={"action": "page", "page_size": 10}).json()
    assert (first["total"], first["pages"], len(first["entries"])) == (25, 3, 10)
    assert first["entries"][0]["page"] == "/jobs/24"  # newest first
    last = c.get("/api/activity", params={"action": "page", "page_size": 10, "page": 3}).json()
    assert [e["page"] for e in last["entries"]] == [f"/jobs/{i}" for i in range(4, -1, -1)]
    assert c.get("/api/activity", params={"page": 0}).status_code == 422

    # a finished job's mockups as plain files; a rerun replaces the folder (nothing stale is left)
    folder = activity.save_outputs("FGPO7031", 277, [("renders/a_front.png", b"1"), ("renders/a_back.png", b"2"), ("../x.json", b"3")])
    assert folder.name == "FGPO7031_job277" and folder.parent.name == "Output Mockups"
    assert (folder / "renders" / "a_back.png").read_bytes() == b"2" and (folder / "x.json").exists()
    activity.save_outputs("FGPO7031", 277, [("renders/a_front.png", b"9")])
    assert sorted(p.name for p in (folder / "renders").iterdir()) == ["a_front.png"] and not (folder / "x.json").exists()


def test_timestamps_leave_in_utc_with_their_zone(staff):
    """SQLite keeps no zone: read back, a time must still say UTC, or browsers show it as local time."""
    c = staff
    login(c)
    me = c.get("/api/auth/me").json()
    for value in (me["created_at"], me["last_login_at"]):
        assert value.endswith(("+00:00", "Z")), value
    assert all(u["created_at"].endswith(("+00:00", "Z")) for u in c.get("/api/users").json())


def test_jobs_are_their_uploaders_and_errors_reach_the_admin(staff, seeded):
    from app.models import Job, UploadedFile

    c = staff
    ids = {u.email: u.id for u in seeded.query(User)}
    files = {}
    for who in ("designer@example.com", "manager@example.com"):
        f = UploadedFile(filename=f"{who}.pdf", sha256=who, size=1, storage_key="x", uploaded_by_id=ids[who])
        seeded.add(f)
        seeded.flush()
        files[who] = f.id
        seeded.add(Job(file_id=f.id, item_code="FGPO1", status="DONE", current_step="done", inputs={}, created_by_id=ids[who]))
    seeded.commit()
    jobs = {j.created_by_id: j.id for j in seeded.query(Job)}
    mine, theirs = jobs[ids["designer@example.com"]], jobs[ids["manager@example.com"]]

    # a designer lists, opens and acts on their own jobs only; the other's is "not found" everywhere
    as_role(c, "designer")
    listed = c.get("/api/jobs").json()
    assert [j["id"] for j in listed["jobs"]] == [mine] and listed["counts"] == {"DONE": 1} and listed["jobs"][0]["created_by"] == "designer@example.com"
    for path in (f"/api/jobs/{theirs}", f"/api/jobs/{theirs}/scene", f"/api/jobs/{theirs}/download.zip", f"/api/uploads/{files['manager@example.com']}/pdf"):
        assert c.get(path).status_code == 404, path
    assert c.post(f"/api/jobs/{theirs}/rerun", json={"from_step": "render"}, headers=H).status_code == 404
    assert c.get(f"/api/jobs?user={ids['manager@example.com']}").json()["total"] == 1  # `user` is ignored: still only their own
    assert c.get("/api/users/summary").status_code == 403

    # "Raise an error": on a job (its state kept) or anywhere, the note optional; never on someone else's job
    r = c.post("/api/errors", json={"job_id": mine, "message": "the back looks mirrored", "page": f"/jobs/{mine}"}, headers=H)
    assert r.status_code == 200 and r.json()["context"]["status"] == "DONE" and r.json()["item_code"] == "FGPO1"
    assert c.post("/api/errors", json={"page": "/upload"}, headers=H).json()["message"] == ""
    assert c.post("/api/errors", json={"job_id": theirs}, headers=H).status_code == 404
    assert len(c.get("/api/errors").json()["reports"]) == 2  # their own reports
    assert c.patch(f"/api/errors/{r.json()['id']}", json={"status": "resolved"}, headers=H).status_code == 403
    as_role(c, "manager")
    assert c.get("/api/errors").json()["reports"] == []

    # the admin: every job, one user's jobs, the per-user summary, every report to handle
    c.post("/api/auth/logout")
    login(c)
    assert c.get("/api/jobs").json()["total"] == 2
    assert [j["id"] for j in c.get(f"/api/jobs?user={ids['manager@example.com']}").json()["jobs"]] == [theirs]
    assert c.get(f"/api/jobs/{theirs}").status_code == 200
    summary = c.get("/api/users/summary").json()["users"][str(ids["designer@example.com"])]
    assert (summary["jobs"], summary["files"], summary["errors"], summary["errors_open"]) == ({"DONE": 1}, 1, 2, 2)
    reports = c.get("/api/errors").json()
    assert reports["counts"] == {"open": 2, "resolved": 0} and {x["user"] for x in reports["reports"]} == {"designer@example.com"}
    done = c.patch(f"/api/errors/{r.json()['id']}", json={"status": "resolved", "admin_note": "fixed the swap"}, headers=H).json()
    assert (done["status"], done["resolved_by"], done["admin_note"]) == ("resolved", "admin@example.com", "fixed the swap")
    assert c.get("/api/errors?status=resolved").json()["reports"][0]["id"] == r.json()["id"]
    assert any(e["action"] == "error raised" for e in _today())


def test_admin_gives_one_person_a_right_and_logs_it(staff):
    """Admin -> Users -> Access: a designer given keyline / workflow rights may use them at once;
    the change and every index value it changes are logged with their old and new values."""
    c = staff
    login(c)
    designer = next(u for u in c.get("/api/users").json() if u["email"] == "designer@example.com")
    r = c.patch(f"/api/users/{designer['id']}", json={"permissions": {"edit_keyline": True, "manage_users": True}}, headers=H)
    assert r.status_code == 422  # managing users stays with the admin role
    r = c.patch(f"/api/users/{designer['id']}", json={"permissions": {"edit_keyline": True}}, headers=H)
    assert r.json()["permission_overrides"] == {"edit_keyline": True} and "edit_keyline" in r.json()["permissions"]
    assert any(e["action"] == "user changed" and e["changes"].get("access.edit_keyline") == [False, True] for e in _today())

    as_role(c, "designer")
    assert c.put("/api/index/standard_size/x", json={"data": {"name": "x"}, "reason": "r"}, headers=H).status_code in (200, 422)  # allowed now (422 = schema)
    c.put("/api/index/client/x", json={"data": {"client_name": "A", "notes": "one"}, "reason": "first"}, headers=H)
    c.put("/api/index/client/x", json={"data": {"client_name": "A", "notes": "two"}, "reason": "second"}, headers=H)
    changed = [e for e in _today() if e["action"] == "index changed" and e["key"] == "x"][-1]
    assert changed["changes"] == [{"path": "notes", "old": "one", "new": "two"}]
    assert c.get("/api/index/client/x/history").json()[0]["changes"] == [{"path": "notes", "old": "one", "new": "two"}]

    login(c)  # back to the role's rights
    c.patch(f"/api/users/{designer['id']}", json={"permissions": {"edit_keyline": None}}, headers=H)
    as_role(c, "designer")
    assert "edit_keyline" not in c.get("/api/auth/me").json()["permissions"]


def test_raiser_is_told_when_the_admin_solves_their_error(staff):
    c = staff
    as_role(c, "designer")
    report = c.post("/api/errors", json={"message": "the gusset is wrong"}, headers=H).json()
    assert c.get("/api/errors/notifications").json()["unread"] == 0
    login(c)
    c.patch(f"/api/errors/{report['id']}", json={"status": "resolved", "admin_note": "fixed"}, headers=H)
    as_role(c, "designer")
    n = c.get("/api/errors/notifications").json()
    assert n["unread"] == 1 and n["items"][0]["admin_note"] == "fixed" and n["items"][0]["resolved_by"] == "admin@example.com"
    c.post("/api/errors/notifications/seen", headers=H)
    assert c.get("/api/errors/notifications").json()["unread"] == 0
