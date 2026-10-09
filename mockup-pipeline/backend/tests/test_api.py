"""HTTP API: auth, roles, CSRF header, index endpoints."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app import auth
from app.api import main
from app.db import get_session
from app.models import User

H = {"X-Requested-With": "fetch"}


@pytest.fixture
def client(engine, seeded, monkeypatch):
    factory = sessionmaker(bind=engine, expire_on_commit=False)

    def override():
        with factory() as s:
            yield s

    main.app.dependency_overrides[get_session] = override
    monkeypatch.setattr(main, "get_engine", lambda: engine)
    seeded.add_all([
        User(email="admin@example.com", role="admin", password_hash=auth.hash_password("admin-password-1")),
        User(email="op@example.com", role="manager", password_hash=auth.hash_password("operator-password-1")),
    ])
    seeded.commit()
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def login(c, email="admin@example.com", password="admin-password-1"):
    r = c.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok", "db": True}


def test_login_logout_and_me(client):
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/session").json() == {"user": None}
    assert login(client)["role"] == "admin"
    assert client.get("/api/auth/session").json()["user"]["email"] == "admin@example.com"
    assert client.get("/api/auth/me").json()["email"] == "admin@example.com"
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401


def test_wrong_password_and_lockout(client):
    for _ in range(auth.MAX_FAILED):
        assert client.post("/api/auth/login", json={"email": "op@example.com", "password": "nope"}).status_code == 401
    r = client.post("/api/auth/login", json={"email": "op@example.com", "password": "operator-password-1"})
    assert r.status_code == 429


def test_write_needs_csrf_header_and_admin(client):
    login(client, "op@example.com", "operator-password-1")
    assert client.get("/api/index/pouch_type").status_code == 200  # managers can read
    body = {"data": {"client_name": "X"}, "reason": "r"}
    assert client.put("/api/index/client/x", json=body, headers=H).status_code == 403  # managers do not edit the index
    client.post("/api/auth/logout")
    login(client)
    assert client.put("/api/index/client/x", json=body).status_code == 403  # no CSRF header
    assert client.put("/api/index/client/x", json=body, headers=H).status_code == 200


def test_index_crud_and_history(client):
    login(client)
    kinds = {k["kind"]: k["count"] for k in client.get("/api/index/kinds").json()}
    assert kinds["pouch_type"] == 10 and kinds["keyline_template"] == 10
    entry = client.get("/api/index/output_preset/ecommerce").json()
    assert entry["version"] == 1 and "views:" in entry["yaml"]
    new_yaml = entry["yaml"].replace("width_px: 2000", "width_px: 2200")
    r = client.put("/api/index/output_preset/ecommerce", json={"yaml": new_yaml, "reason": "sharper"}, headers=H)
    assert r.status_code == 200 and r.json()["version"] == 2
    hist = client.get("/api/index/output_preset/ecommerce/history").json()
    assert [(h["version"], h["author"]) for h in hist] == [(2, "admin@example.com"), (1, "system")]
    assert "+width_px: 2200" in client.get("/api/index/output_preset/ecommerce/diff?a=1&b=2").text
    bad = client.put("/api/index/output_preset/ecommerce", json={"data": {"name": "x", "views": []}, "reason": "r"}, headers=H)
    assert bad.status_code == 422 and bad.json()["detail"]["problems"]


def test_new_default_preset_moves_the_default(client):
    login(client)
    data = client.get("/api/index/output_preset/showcase").json()["data"]
    r = client.put("/api/index/output_preset/showcase", json={"data": {**data, "is_default": True}, "reason": "showcase first"}, headers=H)
    assert r.status_code == 200, r.text
    old = client.get("/api/index/output_preset/ecommerce").json()
    assert old["data"]["is_default"] is False and old["meta"]["reason"] == "showcase first (default moved to showcase)"


def test_rule_tester(client):
    login(client, "op@example.com", "operator-password-1")
    sheet = client.get("/api/index/sample-spec").json()
    out = client.post("/api/index/test", json={"spec_sheet": sheet}, headers=H).json()
    assert out["match"]["pouch_type"] == "stand_up_bottom_gusset"
    assert out["keyline"]["fields"]["gusset_depth_mm"] == {"value": 60.0, "source": "pouch_type", "detail": "formula: spec.gusset_full_width_mm / 2", "unit": "mm"}
    assert out["keyline_version"] == 1


def test_import_export(client):
    login(client)
    text = client.get("/api/index/export").text
    dry = client.post("/api/index/import", json={"yaml": text.replace("width_px: 2000", "width_px: 1900", 1)}, headers=H).json()
    assert dry["applied"] is False and len(dry["updated"]) == 1
    applied = client.post("/api/index/import", json={"yaml": text, "reason": "restore", "dry_run": False}, headers=H).json()
    assert applied["applied"] and applied["updated"] == []


def test_user_admin_and_last_admin_guard(client):
    login(client)
    r = client.post("/api/users", json={"email": "new@example.com", "role": "designer", "password": "long-enough-1"}, headers=H)
    assert r.status_code == 200
    assert client.post("/api/users", json={"email": "x@example.com", "role": "designer", "password": "short"}, headers=H).status_code == 422
    admin_id = next(u["id"] for u in client.get("/api/users").json() if u["email"] == "admin@example.com")
    assert client.patch(f"/api/users/{admin_id}", json={"role": "designer"}, headers=H).status_code == 409
