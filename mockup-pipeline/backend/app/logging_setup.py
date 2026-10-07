"""Structured JSON logs (one object per line) for Render's log stream."""

import json
import logging
import sys
import time
from datetime import datetime, timezone

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        entry.update(getattr(record, "fields", {}))
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


def setup(level: str = "INFO") -> None:
    from app.activity import DailyFileHandler

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    on_disk = DailyFileHandler()  # the same lines, kept in <data_dir>/logs/server
    on_disk.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler, on_disk]
    root.setLevel(level)
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).handlers[:] = []
        logging.getLogger(name).propagate = True
    logging.getLogger("uvicorn.access").disabled = True  # replaced by RequestLog


class RequestLog(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        started = time.perf_counter()
        response = await call_next(request)
        path = request.url.path
        page_view = path == "/api/activity" and request.method == "POST"  # already its own "page" line
        if path.startswith("/api/") and path != "/api/health" and not page_view:
            # every API call, with who made it (app.auth.current_user leaves the user on request.state)
            from app import activity

            activity.record("request", getattr(request.state, "user", None), request, method=request.method, path=path,
                            query=dict(request.query_params) or None, status=response.status_code,
                            ms=round((time.perf_counter() - started) * 1000, 1))
        if path != "/api/health":
            logging.getLogger("http").info(
                "request",
                extra={"fields": {
                    "method": request.method, "path": request.url.path, "status": response.status_code,
                    "ms": round((time.perf_counter() - started) * 1000, 1),
                }},
            )
        return response
