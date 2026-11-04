"""FastAPI application: API under /api, the built React app everywhere else."""

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app import logging_setup
from app.api import auth_routes, error_routes, index_routes, job_routes, tunnel, workflow_routes
from app.config import get_settings
from app.db import get_engine

log = logging.getLogger("app")


def _check_production_settings() -> None:
    """On Render, refuse to start with development defaults that would be unsafe."""
    s = get_settings()
    if os.environ.get("RENDER"):
        problems = []
        if s.secret_key == "dev-secret-change-me":
            problems.append("SECRET_KEY is the development default")
        if not s.cookie_secure:
            problems.append("COOKIE_SECURE must be true behind HTTPS")
        if not s.s3_bucket:
            problems.append("S3_BUCKET is not set: API and worker would not share files")
        if not s.database_url.startswith(("postgres", "postgresql")):
            problems.append("DATABASE_URL must be the Render Postgres database")
        if problems:
            raise RuntimeError("Refusing to start: " + "; ".join(problems))


def _resume_thread_jobs() -> None:
    """Thread mode only (no Redis): jobs that were queued or running when the process stopped."""
    if get_settings().redis_url:
        return
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.models import Job
    from app.workflow import queue

    from app.models import JobEvent

    try:
        with Session(get_engine()) as session:
            stuck = list(session.scalars(select(Job).where(Job.status.in_(["QUEUED", "RUNNING"]))).all())
            if get_settings().auto_review:
                # Review stops the automatic reviewer never saw (left from before it was switched on): rerun
                # their step so it answers them. Ones it already gave up on ("Waiting for a person") stay.
                seen = select(JobEvent.job_id).where(JobEvent.message.like("Waiting for a person%"))
                waiting = session.scalars(select(Job).where(Job.status == "NEEDS_REVIEW", Job.kind == "job", Job.id.not_in(seen))).all()
                for job in waiting:
                    job.status = "QUEUED"
                    session.add(JobEvent(job_id=job.id, level="audit", step=job.current_step, message="Review left from before automatic answers: rerun for the automatic reviewer", data={}))
                session.commit()
                stuck += waiting
            for job in stuck:
                asked = (job.inputs or {}).get("_queued_from") or {}  # the rerun / adjust the queue entry carried
                queue.enqueue(job.id, asked.get("step") or (job.current_step if job.current_step != "done" else None), asked.get("node"))
    except Exception:  # noqa: BLE001 - e.g. tables not migrated yet
        log.warning("could not resume jobs", exc_info=True)


def create_app(resume_jobs: bool = True) -> FastAPI:
    logging_setup.setup()
    _check_production_settings()
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if resume_jobs:
            from app import backup, storage_compact, watchdog

            watchdog.start()  # crash detection and a load line every 5 minutes in logs/server
            backup.start()  # the database and the stored files, every night
            _resume_thread_jobs()
            tunnel.keep_alive()  # share links work from start-up on, and again if ngrok stops
            storage_compact.start()  # the index's storage rules: old jobs' files recompressed, PDF cache pruned
        yield
        if resume_jobs:
            watchdog.stop()
            tunnel.stop()  # no ngrok left forwarding to a port this app may not get next time

    app = FastAPI(title="Pouch mockup pipeline", docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=lifespan)

    @app.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")  # a file served as PNG is never run as a script
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")  # no clickjacking of the admin pages from another site
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")  # share tokens stay out of other sites' logs
        if get_settings().cookie_secure:
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
        return response

    app.add_middleware(logging_setup.RequestLog)
    app.middleware("http")(tunnel.guard)  # through ngrok: share pages only
    app.add_middleware(GZipMiddleware, minimum_size=1024)  # the 1.2 MB app script goes out as ~0.35 MB
    app.include_router(auth_routes.router)
    app.include_router(error_routes.router)
    app.include_router(index_routes.router)
    app.include_router(job_routes.router)
    app.include_router(workflow_routes.router)

    @app.get("/api/health")
    def health() -> JSONResponse:
        try:
            with get_engine().connect() as conn:
                conn.execute(text("select 1"))
        except Exception as exc:  # noqa: BLE001 - health must report, not raise
            log.error("health check failed", extra={"fields": {"error": str(exc)}})
            return JSONResponse({"status": "error", "db": False}, status_code=503)
        return JSONResponse({"status": "ok", "db": True})

    _mount_frontend(app)
    return app


class ImmutableFiles(StaticFiles):
    """/assets names carry a content hash (Vite): a browser keeps them for a year and never asks again."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


def _mount_frontend(app: FastAPI) -> None:
    dist = Path(get_settings().frontend_dist)
    index = dist / "index.html"
    if not index.exists():
        log.info("frontend not built; API only", extra={"fields": {"dist": str(dist)}})
        return
    if (dist / "assets").exists():
        app.mount("/assets", ImmutableFiles(directory=dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        file = (dist / path).resolve()
        if path and file.is_file() and dist.resolve() in file.parents:
            return FileResponse(file)
        # client-side routes; no-cache so a rebuilt app (new hashed /assets) reaches phones at once
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


app = create_app()
