"""Nightly backup of everything the app cannot rebuild: the database and the stored files.

    <backup_dir>/db/dev-2026-10-14.db     one consistent copy of the SQLite database a night (sqlite3's own
                                           online backup: safe while jobs write), the last BACKUP_KEEP_DAYS kept
    <backup_dir>/storage/...               a mirror of .work/storage (uploads, renders, GLB): new and changed
                                           files are copied; nothing is ever deleted from the mirror, so a file
                                           removed by mistake can still be copied back
    <backup_dir>/env.backup                backend/.env (SECRET_KEY: without it the share links already sent stop working)

Runs at BACKUP_HOUR (local time) inside the API process, and on demand: `python -m app.cli backup`.
Each run logs "backup done" with what it copied, or "backup failed" with the reason.
Point BACKUP_DIR at another disk, a NAS share or a synced cloud folder (OneDrive, Dropbox): a backup on
the same disk does not survive the disk. Restore: README "Backups and restore".
Postgres (Render) has its own backups; there only the files are mirrored, and only from local storage.
"""

import logging
import shutil
import sqlite3
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from app.config import get_settings

log = logging.getLogger("backup")


def backup_dir() -> Path:
    s = get_settings()
    return Path(s.backup_dir) if s.backup_dir else Path(s.data_dir) / "backups"


def _db(target: Path) -> str | None:
    url = get_settings().database_url
    if not url.startswith("sqlite"):
        return None
    source = Path(url.split("///", 1)[-1])
    out = target / "db" / f"{source.stem}-{date.today().isoformat()}.db"
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    src, dst = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True), sqlite3.connect(tmp)
    try:
        src.backup(dst)  # (a consistent snapshot even while a job writes)
    finally:  # (closed before the rename: Windows will not rename a file still open)
        src.close()
        dst.close()
    tmp.replace(out)
    keep = get_settings().backup_keep_days
    for old in sorted(out.parent.glob(f"{source.stem}-*.db"))[:-keep or None]:
        old.unlink(missing_ok=True)
    return out.name


def _mirror(source: Path, target: Path) -> tuple[int, int]:
    """Copy new and changed files (by size and time); never delete from the target."""
    files = size = 0
    if not source.is_dir():
        return 0, 0
    for f in source.rglob("*"):
        if not f.is_file() or f.suffix == ".tmp":
            continue
        dst = target / f.relative_to(source)
        st = f.stat()
        if dst.exists():
            d = dst.stat()
            if d.st_size == st.st_size and d.st_mtime >= st.st_mtime:
                continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, dst)
        files += 1
        size += st.st_size
    return files, size


def run_once() -> dict:
    s = get_settings()
    target = backup_dir()
    target.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    result: dict = {"dir": str(target), "db": _db(target)}
    from app.storage import LocalStorage, get_storage

    storage = get_storage()
    if isinstance(storage, LocalStorage):
        result["files_copied"], copied = _mirror(storage.root, target / "storage")
        result["mb_copied"] = round(copied / 1e6, 1)
    env = Path(".env")
    if env.is_file():
        shutil.copy2(env, target / "env.backup")
    result["seconds"] = round(time.perf_counter() - started, 1)
    (target / "LAST_BACKUP.txt").write_text(f"{datetime.now().isoformat(timespec='seconds')} {result}\n", encoding="utf-8")
    log.info("backup done", extra={"fields": result})
    return result


def start() -> None:
    s = get_settings()
    if s.backup_hour < 0:
        log.warning("nightly backup is switched off (BACKUP_HOUR=-1)")
        return

    def loop() -> None:
        while True:
            now = datetime.now()
            due = now.replace(hour=s.backup_hour, minute=0, second=0, microsecond=0)
            if due <= now:
                due += timedelta(days=1)
            # a night missed (the PC was off): catch up a few minutes after start
            last = backup_dir() / "LAST_BACKUP.txt"
            if not last.exists() or time.time() - last.stat().st_mtime > 26 * 3600:
                due = min(due, now + timedelta(minutes=5))
            time.sleep(max(1.0, (due - now).total_seconds()))
            try:
                run_once()
            except Exception:  # noqa: BLE001 - logged; tried again the next night
                log.exception("backup failed", extra={"fields": {"dir": str(backup_dir())}})

    threading.Thread(target=loop, name="backup", daemon=True).start()
