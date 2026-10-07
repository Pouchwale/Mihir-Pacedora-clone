"""The users' data folder (settings.data_dir): readable upload copies and permanent logs.

    <data_dir>/uploads/2026-10-07/designer@pouchwale.com/143012_b57_FGPO7031_Front_App.pdf
    <data_dir>/Output Mockups/FGPO7031_job277/renders/*.png, model/*.glb, ...   each finished job's mockups
    <data_dir>/logs/activity/2026-10-07.jsonl   who did what: every request, sign-in, page, change
    <data_dir>/logs/server/2026-10-07.log       the server's own log (errors, job steps)

Each line is opened, appended and closed (activity lines are also fsync'ed), so the file on disk
is complete after any line: a shutdown, restart or crash loses nothing, and the API, the worker and
the renderer can all write to the same day's file. Files are never rotated or deleted here.
"""

import json
import logging
import os
import re
import shutil
import threading
from datetime import date, datetime, timezone
from pathlib import Path

from app.config import get_settings

_lock = threading.Lock()
SAFE = re.compile(r"[^A-Za-z0-9._@+-]+")
# never written to a log, whatever a request carries
SECRET_KEYS = {"password", "token", "secret", "authtoken"}


def _dir(*parts: str) -> Path:
    path = Path(get_settings().data_dir).joinpath(*parts)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _append(path: Path, line: str, sync: bool) -> None:
    with _lock, open(path, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")
        fh.flush()
        if sync:
            os.fsync(fh.fileno())


def scrub(value):
    """A copy with password / token values replaced, at any depth."""
    if isinstance(value, dict):
        return {k: "***" if any(s in k.lower() for s in SECRET_KEYS) else scrub(v) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value


def record(action: str, user=None, request=None, **fields) -> None:
    """One activity line. `user` is a User (or None: not signed in); `request` adds the address."""
    entry = {"ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), "action": action,
             "user": getattr(user, "email", None), "role": getattr(user, "role", None)}
    if request is not None:
        entry["ip"] = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (request.client.host if request.client else None)
    entry.update(scrub(fields))
    try:
        _append(_dir("logs", "activity") / f"{date.today().isoformat()}.jsonl", json.dumps(entry, default=str), sync=True)
    except OSError:
        logging.getLogger(__name__).exception("activity log not written")  # never fail the request over its log


def keep_upload(user, filename: str, data: bytes, batch_id: int | None = None) -> Path | None:
    """A readable copy of an uploaded file in the user's folder for the day."""
    name = SAFE.sub("_", Path(filename).name).strip("._") or "upload"
    stamp = datetime.now().strftime("%H%M%S")
    folder = _dir("uploads", date.today().isoformat(), SAFE.sub("_", getattr(user, "email", None) or "unknown"))
    path = folder / (f"{stamp}_b{batch_id}_{name}" if batch_id else f"{stamp}_{name}")
    try:
        path.write_bytes(data)
        return path
    except OSError:
        logging.getLogger(__name__).exception("upload copy not written", extra={"fields": {"file": filename}})
        return None


OUTPUTS = "Output Mockups"


def save_outputs(item_code: str | None, job_id: int, files: list[tuple[str, bytes]]) -> Path | None:
    """A finished job's mockups as plain files: <data_dir>/Output Mockups/<item>_job<id>/<name>.
    A rerun replaces the folder, so it always holds the job's latest result and nothing stale."""
    folder = _dir(OUTPUTS) / f"{SAFE.sub('_', item_code or 'item').strip('._') or 'item'}_job{job_id}"
    try:
        if folder.exists():
            shutil.rmtree(folder)
        for name, data in files:
            parts = [SAFE.sub("_", p).strip("._") or "file" for p in Path(name).parts if p not in ("", ".", "..")]
            path = folder.joinpath(*parts)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        return folder
    except OSError:
        logging.getLogger(__name__).exception("output mockups not written", extra={"fields": {"job": job_id}})
        return None


def read(day: str, user: str | None = None, action: str | None = None, reads: bool = False,
         offset: int = 0, limit: int = 100) -> tuple[list[dict], int, list[str]]:
    """One page of the day's activity, newest first, with the number of matching lines and every
    user seen that day. `reads` False hides plain page-data reads (GET requests)."""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        raise ValueError("day must be YYYY-MM-DD")
    path = Path(get_settings().data_dir) / "logs" / "activity" / f"{day}.jsonl"
    if not path.exists():
        return [], 0, []
    matches, users = [], set()
    needle = (action or "").lower()
    for line in reversed(path.read_text(encoding="utf-8", errors="replace").splitlines()):
        try:
            e = json.loads(line)
        except ValueError:
            continue  # a line cut by a power loss mid-write
        if e.get("user"):
            users.add(e["user"])
        if user and e.get("user") != user:
            continue
        if needle and needle not in (e.get("action") or "").lower() and needle not in (e.get("path") or "").lower() and needle not in str(e.get("page") or "").lower():
            continue
        if not reads and e.get("action") == "request" and e.get("method") == "GET":
            continue
        matches.append(e)
    return matches[offset:offset + limit], len(matches), sorted(users)


def days() -> list[str]:
    folder = Path(get_settings().data_dir) / "logs" / "activity"
    return sorted((p.stem for p in folder.glob("*.jsonl")), reverse=True) if folder.exists() else []


class DailyFileHandler(logging.Handler):
    """The server log, one file a day in <data_dir>/logs/server (flushed per line; no rotation)."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            _append(_dir("logs", "server") / f"{date.today().isoformat()}.log", self.format(record), sync=False)
        except Exception:  # noqa: BLE001 - a log line must never break the app
            self.handleError(record)
