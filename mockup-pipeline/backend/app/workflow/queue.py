"""Job queue: RQ on Render Key Value in production, a background thread in local development."""

import logging
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

from app.config import get_settings

log = logging.getLogger("queue")


@lru_cache
def _executor() -> ThreadPoolExecutor:
    # One job at a time: OCR and rendering are CPU heavy.
    return ThreadPoolExecutor(max_workers=1, thread_name_prefix="job")


@lru_cache
def _rq_queue():
    from redis import Redis
    from rq import Queue

    s = get_settings()
    return Queue(s.queue_name, connection=Redis.from_url(s.redis_url))


def enqueue(job_id: int, from_step: str | None = None, from_node: str | None = None) -> None:
    s = get_settings()
    if s.redis_url:
        _rq_queue().enqueue("app.workflow.engine.run_job_safe", job_id, from_step, from_node, job_timeout=3600, result_ttl=0)
    else:
        from app.workflow.engine import run_job_safe

        _executor().submit(run_job_safe, job_id, from_step, from_node)
    log.info("job queued", extra={"fields": {"job": job_id, "from_step": from_step, "from_node": from_node, "mode": "rq" if s.redis_url else "thread"}})
