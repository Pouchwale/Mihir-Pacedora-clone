"""The one door to Groq Cloud: every AI read in the pipeline goes through `chat` here.

Groq's free tier limits requests per minute and per day and tokens per minute. Three things keep
the pipeline under them:

- a cache: the same image + prompt + model is answered from disk (.work/cache/groq) instead of a
  new call, so a rerun, a retried job or the same PDF uploaded twice costs nothing;
- pacing: calls are at least 60 / GROQ_RPM seconds apart, and when Groq's own headers say the
  minute's tokens or requests are nearly spent, the next call waits for their reset;
- a day budget: the tokens each call used (Groq's `usage`) are kept for 24 h in .work/cache/groq/
  _usage.json, shared by every process; a call that would take the day past GROQ_TPD (or the limit
  Groq itself names in a "tokens per day" 429, learned and remembered) is not made: local OCR instead;
- 429 handling: a short wait (Groq's retry-after, up to GROQ_MAX_WAIT_S) is waited out and the call
  retried; a long one (the day's quota) stops all calls until it ends, and each caller falls back
  to Tesseract meanwhile instead of hammering the API.

Anything that cannot give an answer raises `Unavailable`; callers then use local OCR.
ponytail: limits are tracked per process (local mode runs one job thread); several RQ workers
would each pace themselves - share the state in Redis if that ever matters.
"""

import hashlib
import json
import logging
import re
import threading
import time
from pathlib import Path

import httpx

from app.config import Settings

log = logging.getLogger(__name__)

URL = "https://api.groq.com/openai/v1/chat/completions"
LOW_TOKENS = 3000  # fewer minute tokens left than one table read needs: wait for the reset
RETRIES = 3
_sleep = time.sleep  # (tests replace this one hook, not time.sleep for the whole process)


class Unavailable(RuntimeError):
    """No answer from Groq (no key, quota, network, a reply that is not JSON): use local OCR."""


class _State:
    lock = threading.Lock()
    last_call = 0.0
    wait_until = 0.0  # pacing: the minute's budget is spent until then
    blocked_until = 0.0  # the day's quota is spent until then: no calls at all
    calls = 0
    cache_hits = 0


def _seconds(value: str | None) -> float | None:
    """Groq durations: "2.5s", "120ms", "1m12.3s", "7.66s" (or a bare number of seconds)."""
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        pass
    total, found = 0.0, False
    for amount, unit in re.findall(r"([\d.]+)\s*(ms|h|m|s)", value):
        total += float(amount) * {"ms": 0.001, "s": 1, "m": 60, "h": 3600}[unit]
        found = True
    return total if found else None


def _retry_after(response: httpx.Response) -> float | None:
    wait = _seconds(response.headers.get("retry-after"))
    if wait is None:
        m = re.search(r"try again in ((?:[\d.]+\s*(?:ms|h|m|s))+)", response.text)
        wait = _seconds(m.group(1)) if m else None
    return wait


def _note_limits(response: httpx.Response) -> None:
    """Groq reports what is left: per day for requests, per minute for tokens. Pace the next call."""
    h = response.headers
    try:
        tokens_left = int(h.get("x-ratelimit-remaining-tokens", "1000000"))
        requests_left = int(h.get("x-ratelimit-remaining-requests", "1000000"))
    except ValueError:
        return
    now = time.time()
    if tokens_left < LOW_TOKENS:
        _State.wait_until = max(_State.wait_until, now + (_seconds(h.get("x-ratelimit-reset-tokens")) or 60))
    if requests_left <= 1:
        reset = _seconds(h.get("x-ratelimit-reset-requests")) or 3600
        _State.blocked_until = max(_State.blocked_until, now + reset)
        log.warning("Groq: the day's requests are used up; local OCR for the next %.0f min", reset / 60)


DAY = 86400.0
TPD_MARGIN = 0.95  # stop this short of the day's tokens


def _usage(settings: Settings) -> tuple[Path, dict]:
    f = Path(settings.work_dir) / "cache" / "groq" / "_usage.json"
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    now = time.time()
    data["calls"] = [c for c in data.get("calls", []) if now - c[0] < DAY]  # [time, tokens]
    return f, data


def _save_usage(f: Path, data: dict) -> None:
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data), encoding="utf-8")


def _day_budget_left(settings: Settings) -> str | None:
    """Why the next call must not be made (the day's tokens would run out), or None."""
    f, data = _usage(settings)
    limit = min(v for v in (settings.groq_tpd or 0, data.get("tpd_limit") or 0, float("inf")) if v)
    if limit == float("inf"):
        return None
    calls = data["calls"]
    used = sum(t for _, t in calls)
    per_call = sorted(t for _, t in calls)[len(calls) // 2] if calls else 3000  # a typical call
    if used + per_call <= TPD_MARGIN * limit:
        return None
    # the oldest calls leave the 24 h window first: until enough have, no calls
    free_at, left = time.time(), used
    for t0, tokens in calls:
        left -= tokens
        free_at = t0 + DAY
        if left + per_call <= TPD_MARGIN * limit:
            break
    _State.blocked_until = max(_State.blocked_until, free_at)
    return f"Groq's day budget ({used} of {limit:.0f} tokens in 24 h) would run out; local OCR for {(free_at - time.time()) / 60:.0f} min"


def _record(settings: Settings, response: httpx.Response) -> None:
    f, data = _usage(settings)
    m = re.search(r"tokens per day \(TPD\): Limit (\d+), Used (\d+)", response.text)
    if m:
        # Groq names its day limit and what is used in the 429: remember both (calls this file never saw count too)
        data["tpd_limit"] = int(m.group(1))
        unseen = int(m.group(2)) - sum(t for _, t in data["calls"])
        if unseen > 0:
            # (dated so it leaves the 24 h window when Groq says tokens are free again, not a day from now)
            data["calls"].append([time.time() + (_retry_after(response) or 0.0) - DAY, unseen])
    else:
        try:
            data["calls"].append([time.time(), int(response.json()["usage"]["total_tokens"])])
        except (ValueError, KeyError, TypeError):
            return
    _save_usage(f, data)


def _cache_file(settings: Settings, key: str) -> Path:
    return Path(settings.work_dir) / "cache" / "groq" / f"{key}.json"


def chat(settings: Settings, text: str, image_b64: str, media: str = "image/png", max_tokens: int = 700) -> str:
    """The model's reply (text) to one prompt + one image, cached and rate limited."""
    if not settings.groq_api_key:
        raise Unavailable("GROQ_API_KEY is not set")
    key = hashlib.sha256(f"{settings.groq_model}\n{max_tokens}\n{text}\n{image_b64}".encode()).hexdigest()
    cached = _cache_file(settings, key)
    if cached.exists():
        _State.cache_hits += 1
        return json.loads(cached.read_text(encoding="utf-8"))["content"]

    body = {
        "model": settings.groq_model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": f"data:{media};base64,{image_b64}"}},
        ]}],
        "temperature": 0,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    headers = {"Authorization": f"Bearer {settings.groq_api_key}"}
    with _State.lock:  # one call at a time, paced
        for attempt in range(RETRIES + 1):
            now = time.time()
            if now < _State.blocked_until:
                raise Unavailable(f"Groq's daily quota is used up for another {(_State.blocked_until - now) / 60:.0f} min")
            why = _day_budget_left(settings)
            if why:
                raise Unavailable(why)
            pause = max(_State.last_call + 60.0 / max(1, settings.groq_rpm) - now, _State.wait_until - now)
            if pause > settings.groq_max_wait_s:
                raise Unavailable(f"Groq's minute budget is spent for {pause:.0f} s")
            if pause > 0:
                _sleep(pause)
            try:
                response = httpx.post(URL, headers=headers, json=body, timeout=120)
            except httpx.HTTPError as exc:
                _State.last_call = time.time()
                if attempt < RETRIES:
                    _sleep(2 ** attempt)
                    continue
                raise Unavailable(f"{type(exc).__name__}: {exc}") from exc
            _State.last_call = time.time()
            _State.calls += 1
            _note_limits(response)
            if response.status_code == 400 and "response_format" in response.text:
                body.pop("response_format")  # a model without JSON mode: ask plainly, pick the JSON out of the reply
                continue
            if response.status_code == 429:
                log.warning("Groq 429: %s", response.text[:300])
                _record(settings, response)
                wait = _retry_after(response) or 30.0
                if wait > settings.groq_max_wait_s:
                    # the day's quota (or a very long minute): stop calling until it ends
                    _State.blocked_until = max(_State.blocked_until, time.time() + wait)
                    raise Unavailable(f"Groq rate limit: try again in {wait:.0f} s")
                _State.wait_until = max(_State.wait_until, time.time() + wait + 0.5)
                continue
            if response.status_code >= 500 and attempt < RETRIES:
                _sleep(2 ** attempt)
                continue
            if response.status_code >= 400:
                raise Unavailable(f"HTTP {response.status_code}: {response.text[:300]}")
            _record(settings, response)
            content = response.json()["choices"][0]["message"]["content"]
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_text(json.dumps({"model": settings.groq_model, "content": content}), encoding="utf-8")
            return content
    raise Unavailable("Groq kept answering 429 / 5xx")


def stats() -> dict:
    return {"calls": _State.calls, "cache_hits": _State.cache_hits, "blocked_for_s": max(0.0, _State.blocked_until - time.time())}
