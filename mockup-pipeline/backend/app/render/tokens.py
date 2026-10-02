"""Short-lived signed tokens that let the headless renderer read one job's files without a session."""

import hashlib
import hmac
import time

from app.config import get_settings


def make(job_id: int, ttl_s: int = 3600) -> str:
    expires = int(time.time()) + ttl_s
    payload = f"{job_id}.{expires}"
    sig = hmac.new(get_settings().secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{payload}.{sig}"


def check(token: str | None, job_id: int) -> bool:
    if not token:
        return False
    try:
        jid, expires, sig = token.split(".")
    except ValueError:
        return False
    payload = f"{jid}.{expires}"
    good = hmac.new(get_settings().secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return hmac.compare_digest(sig, good) and int(jid) == job_id and int(expires) >= time.time()
