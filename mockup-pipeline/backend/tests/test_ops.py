"""Operations: backups and the last administrator."""

import sqlite3
from datetime import date

from app import backup
from app.config import get_settings
from tests.test_api import client, login  # noqa: F401 - fixture re-export
from tests.test_workflow import H






def test_backup_copies_the_database_and_mirrors_files(tmp_path, monkeypatch):
    db = tmp_path / "live.db"
    conn = sqlite3.connect(db)
    conn.execute("create table t (x)")
    conn.execute("insert into t values (42)")
    conn.commit()
    conn.close()
    storage = tmp_path / "work" / "storage" / "jobs" / "1"
    storage.mkdir(parents=True)
    (storage / "front.png").write_bytes(b"png")
    s = get_settings()
    monkeypatch.setattr(s, "database_url", f"sqlite:///{db.as_posix()}")
    monkeypatch.setattr(s, "backup_dir", str(tmp_path / "bk"))
    monkeypatch.setattr(s, "work_dir", tmp_path / "work")
    from app import storage as storage_mod

    monkeypatch.setattr(storage_mod, "get_storage", lambda: storage_mod.LocalStorage(tmp_path / "work" / "storage"))
    first = backup.run_once()
    assert first["files_copied"] == 1
    conn = sqlite3.connect(tmp_path / "bk" / "db" / f"live-{date.today().isoformat()}.db")
    assert conn.execute("select x from t").fetchone() == (42,)
    conn.close()  # (Windows: an open file cannot be replaced by the next run)
    assert (tmp_path / "bk" / "storage" / "jobs" / "1" / "front.png").read_bytes() == b"png"
    assert backup.run_once()["files_copied"] == 0  # (nothing changed: nothing copied again)




def test_the_last_administrator_cannot_be_removed(client):
    login(client)
    me = client.get("/api/auth/me").json()
    assert [u["email"] for u in client.get("/api/users").json() if u["role"] == "admin"] == [me["email"]]
    r = client.patch(f"/api/users/{me['id']}", json={"role": "designer"}, headers=H)
    assert r.status_code == 409 and "administrator" in r.json()["detail"]
