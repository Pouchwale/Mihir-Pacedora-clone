"""Background worker (Render Background Worker): runs workflow jobs from the Render Key Value queue.

    python -m app.worker

Same Docker image as the web service. Headless renders open this app on a private local port
(app.render.headless.local_base_url), so the worker needs no route to the web service.
"""

import logging

from app import logging_setup
from app.config import get_settings

log = logging.getLogger("worker")


def main() -> None:
    logging_setup.setup()
    s = get_settings()
    if not s.redis_url:
        raise SystemExit("REDIS_URL is not set: the worker needs the Render Key Value queue")
    from redis import Redis
    from rq import Queue, Worker

    conn = Redis.from_url(s.redis_url)
    log.info("worker starting", extra={"fields": {"queue": s.queue_name}})
    Worker([Queue(s.queue_name, connection=conn)], connection=conn).work(with_scheduler=False)


if __name__ == "__main__":
    main()
