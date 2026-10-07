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
from app.api import auth_routes, index_routes, job_routes, tunnel, workflow_routes
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

    try:
        with Session(get_engine()) as session:
            stuck = session.scalars(select(Job).where(Job.status.in_(["QUEUED", "RUNNING"]))).all()
            for job in stuck:
                queue.enqueue(job.id, job.current_step if job.current_step != "done" else None)
    except Exception:  # noqa: BLE001 - e.g. tables not migrated yet
        log.warning("could not resume jobs", exc_info=True)


def create_app(resume_jobs: bool = True) -> FastAPI:
    logging_setup.setup()
    _check_production_settings()
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if resume_jobs:
            _resume_thread_jobs()
        yield

    app = FastAPI(title="Pouch mockup pipeline", docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=lifespan)
    app.add_middleware(logging_setup.RequestLog)
    app.middleware("http")(tunnel.guard)  # through ngrok: share pages only
    app.add_middleware(GZipMiddleware, minimum_size=1024)  # the 1.2 MB app script goes out as ~0.35 MB
    app.include_router(auth_routes.router)
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
