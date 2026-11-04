"""Disk housekeeping for finished jobs, by the index's storage rules (kind `storage`, key `default`;
Indexing -> Storage & cleanup). Runs in a thread of the API process once an hour. Nothing is lost:

- `compact_after_days`: a job finished that long ago has every PNG under jobs/<id>/ rewritten with the
  strongest deflate. Same format, same mode, same ICC / dpi, every pixel identical (checked before the
  file is replaced); about a third smaller. A `.compacted` marker in the folder records it; a job that
  runs again (new files) is compacted again after the same delay.
- `pdf_cache_days`: the working copies of uploaded PDFs in .work/cache older than that are deleted. The
  upload itself stays in storage; StepContext.local_file copies it back the next time a job needs it.

Local storage only: on R2 / S3 the bucket's own lifecycle rules do this.
"""

import io
import logging
import threading
import time
from datetime import timedelta, timezone
from pathlib import Path

from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_engine
from app.index import store
from app.index.schemas import StorageRules
from app.models import Job, JobEvent, UploadedFile, utcnow
from app.storage import LocalStorage, get_storage

log = logging.getLogger("storage")
MARKER = ".compacted"
EVERY_S = 3600


def rules(session: Session) -> StorageRules:
    row = store.get_version(session, "storage", "default")
    return StorageRules.model_validate(row.data) if row else StorageRules()


def recompress_png(path: Path) -> int:
    """Rewrite one PNG at the strongest compression. Returns the bytes saved; 0 (file untouched) when the
    result would not be smaller or does not decode to exactly the same pixels."""
    before = path.stat().st_size
    with Image.open(path) as im:
        im.load()
        keep = {k: im.info[k] for k in ("icc_profile", "dpi", "transparency") if k in im.info}
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True, compress_level=9, **keep)
        after = buf.tell()
        if after >= before:
            return 0
        with Image.open(io.BytesIO(buf.getvalue())) as back:
            if back.mode != im.mode or back.convert("RGBA").tobytes() != im.convert("RGBA").tobytes():
                return 0
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(buf.getvalue())
    tmp.replace(path)
    return before - after


def compact_job(session: Session, job: Job, root: Path) -> int | None:
    folder = root / "jobs" / str(job.id)
    marker = folder / MARKER
    changed = (job.updated_at if job.updated_at.tzinfo else job.updated_at.replace(tzinfo=timezone.utc)).timestamp()
    if not folder.is_dir() or (marker.exists() and marker.stat().st_mtime >= changed):
        return None
    saved, files = 0, 0
    for png in folder.rglob("*.png"):
        try:
            got = recompress_png(png)
        except OSError:
            log.warning("png not recompressed", exc_info=True, extra={"fields": {"file": str(png)}})
            continue
        saved += got
        files += got > 0
    marker.write_text(utcnow().isoformat())
    session.add(JobEvent(job_id=job.id, level="audit", step=None, data={"files": files, "saved_bytes": saved},
                         message=f"Storage compacted: {files} PNG file(s) recompressed, {saved / 1e6:.1f} MB freed (every pixel kept)"))
    return saved


def prune_cache(session: Session, cache: Path, days: int) -> int:
    """Delete PDF working copies older than `days`, except those of jobs queued or running now."""
    busy = set(session.scalars(select(UploadedFile.sha256).join(Job, Job.file_id == UploadedFile.id).where(Job.status.in_(("QUEUED", "RUNNING")))))
    cutoff = time.time() - days * 86400
    freed = 0
    for f in cache.glob("*.pdf") if cache.is_dir() else []:
        if f.name[:64] in busy or f.stat().st_mtime > cutoff:
            continue
        try:
            size = f.stat().st_size
            f.unlink()
            freed += size
        except OSError:  # (open in a step right now: next round)
            pass
    return freed


def run_once() -> None:
    storage = get_storage()
    if not isinstance(storage, LocalStorage):
        return
    with Session(get_engine()) as session:
        r = rules(session)
        if r.compact_after_days:
            cutoff = utcnow() - timedelta(days=r.compact_after_days)
            total = 0
            for job in session.scalars(select(Job).where(Job.status.in_(("DONE", "FAILED", "CANCELLED")), Job.updated_at < cutoff)):
                try:
                    total += compact_job(session, job, storage.root) or 0
                    session.commit()
                except Exception:  # noqa: BLE001 - one job's files must not stop the others
                    session.rollback()
                    log.exception("compaction failed", extra={"fields": {"job": job.id}})
            if total:
                log.info("storage compacted", extra={"fields": {"saved_mb": round(total / 1e6, 1)}})
        if r.pdf_cache_days:
            freed = prune_cache(session, get_settings().work_dir / "cache", r.pdf_cache_days)
            if freed:
                log.info("pdf cache pruned", extra={"fields": {"freed_mb": round(freed / 1e6, 1)}})


def start() -> None:
    def loop() -> None:
        time.sleep(120)  # (let the server come up and resume its jobs first)
        while True:
            try:
                run_once()
            except Exception:  # noqa: BLE001 - never let the keeper die
                log.exception("storage housekeeping failed")
            time.sleep(EVERY_S)

    threading.Thread(target=loop, name="storage-compact", daemon=True).start()
