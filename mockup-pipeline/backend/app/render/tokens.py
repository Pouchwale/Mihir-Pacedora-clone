"""Short-lived signed tokens that let the headless renderer read one job's files without a session."""

import hashlib
import hmac
import secrets
import time

from app.config import get_settings

DEFAULT_SECRET = "dev-secret-change-me"
_generated: str | None = None


def _secret() -> bytes:
    """The signing key. The built-in default is public (it is in the code), so share links signed with
    it could be forged for every job once the tunnel is open: without SECRET_KEY set, a random key is
    made once and kept in the work folder (links keep working across restarts)."""
    global _generated
    key = get_settings().secret_key
    if key and key != DEFAULT_SECRET:
        return key.encode()
    if _generated is None:
        path = get_settings().work_dir / "secret_key"
        try:
            _generated = path.read_text(encoding="utf8").strip()
        except OSError:
            _generated = ""
        if len(_generated) < 32:
            _generated = secrets.token_hex(32)
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(_generated, encoding="utf8")
            except OSError:
                pass  # this process's links still work; a restart makes a new key
    return _generated.encode()


def make(job_id: int, ttl_s: int = 3600) -> str:
    expires = int(time.time()) + ttl_s
    payload = f"{job_id}.{expires}"
    sig = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{payload}.{sig}"


EXPIRED = "This share link has expired. Ask the sender for a new link."
INVALID = "This share link is not valid. Check that the whole link was copied, or ask the sender for a new one."


def problem(token: str | None, job_id: int) -> str | None:
    """None when the token opens this job; otherwise what to tell the person holding the link."""
    if not token:
        return INVALID
    try:
        jid, expires, sig = token.split(".")
        jid_n, expires_n = int(jid), int(expires)
    except ValueError:
        return INVALID
    payload = f"{jid}.{expires}"
    good = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    # (bytes: compare_digest raises TypeError on a str with non-ASCII characters, e.g. "?token=1.1.é")
    if not hmac.compare_digest(sig.encode("utf8", "replace"), good.encode()) or jid_n != job_id:
        return INVALID
    return EXPIRED if expires_n < time.time() else None


def check(token: str | None, job_id: int) -> bool:
    return problem(token, job_id) is None
