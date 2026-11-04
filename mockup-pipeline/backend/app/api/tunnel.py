"""The ngrok tunnel behind share links: the app stays on this PC; only share pages are reachable outside.

public_base() returns the address customers open, starting `ngrok http <port>` on the first share when it
is not running (the port of INTERNAL_BASE_URL: 8765, or the free one run_local.ps1 picked instead). guard() turns away everything else that arrives through the tunnel (sign-in, jobs list,
uploads): a request whose Host is the ngrok address may only read one job's 3D view with a valid share token.

Only a tunnel that forwards to this app's own port is ever handed out (another program's ngrok on this PC
is not ours), and when ngrok does not come up, last_error() says why: ngrok's own words are kept in
.work/ngrok.log instead of being thrown away.
"""

import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.render import tokens

log = logging.getLogger("app")

NGROK_DOMAINS = (".ngrok-free.app", ".ngrok-free.dev", ".ngrok.app", ".ngrok.dev", ".ngrok.io")
# What a share token alone may read (also the only API the tunnel lets through): one job's 3D scene, its
# files, the previews of pictures placed on it, and the share page's header (never the full job record,
# which carries inputs and staff emails). Everything else needs a signed-in owner.
SHARE_API = re.compile(r"^/api/jobs/(\d+)(/scene|/file|/share-info|/preview/\d+)$")
# ngrok's own local API: the first agent on this PC takes 4040, a second one 4041, and so on
AGENT_PORTS = range(4040, 4046)
# What ngrok's error codes mean for whoever runs this PC (the raw message is always shown as well)
HINTS = {
    "ERR_NGROK_4018": "ngrok has no authtoken: run `ngrok config add-authtoken <your token>` once (dashboard.ngrok.com).",
    "ERR_NGROK_105": "ngrok's authtoken is wrong: run `ngrok config add-authtoken <your token>` again.",
    "ERR_NGROK_107": "ngrok's authtoken is wrong: run `ngrok config add-authtoken <your token>` again.",
    "ERR_NGROK_108": "another ngrok is already running for this ngrok account (the free plan allows one): close it, or stop it on another PC.",
    "ERR_NGROK_334": "the PUBLIC_URL address is already in use by another running ngrok: close that one.",
    "ERR_NGROK_15002": "the PUBLIC_URL address belongs to a different ngrok account than this PC's authtoken.",
    "ERR_NGROK_320": "the PUBLIC_URL address is not reserved for this PC's ngrok account.",
}

_lock = threading.Lock()  # one start at a time: the keeper thread and a Share click must not both spawn ngrok
_proc: subprocess.Popen | None = None
_error: str | None = None


def last_error() -> str | None:
    """Why the tunnel is not up (None when it is, or before the first try)."""
    return _error


def _port() -> str:
    return get_settings().internal_base_url.rstrip("/").rsplit(":", 1)[-1] or "8765"


def _log_file() -> Path:
    return Path(get_settings().work_dir) / "ngrok.log"


def _pid_file() -> Path:
    return Path(get_settings().work_dir) / "ngrok.pid"


def _stop_leftover() -> None:
    """Stop the ngrok an earlier run of this app started and left behind (the server window was closed,
    or the app now runs on another port): it keeps the PUBLIC_URL address and the free plan's one agent,
    so a new tunnel to this port could not start. Only that process: the PID is ours (ngrok.pid) and is
    still an ngrok.exe, never a program that got the PID later, never someone else's ngrok."""
    try:
        pid = int(_pid_file().read_text().strip())
    except (OSError, ValueError):
        return
    if _proc is not None and _proc.pid == pid:
        return  # this run's own, still coming up
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], capture_output=True, text=True,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
        if '"ngrok' in out.lower():
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            log.info("stopped the ngrok left from an earlier run", extra={"fields": {"pid": pid}})
            time.sleep(1)  # ngrok's servers see the old agent go
    _pid_file().unlink(missing_ok=True)


def stop() -> None:
    """Server shutdown: stop the ngrok this run started (links answer again when the app is back)."""
    if _proc is not None and _proc.poll() is None:
        _proc.terminate()
        _pid_file().unlink(missing_ok=True)


def _tunnels() -> list[dict]:
    """Every tunnel of every ngrok agent on this PC: {"url", "addr"}."""
    found = []
    for port in AGENT_PORTS:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/tunnels", timeout=1) as r:
                tunnels = json.load(r)["tunnels"]
        except (OSError, ValueError, KeyError):
            continue
        found += [{"url": t.get("public_url", ""), "addr": str((t.get("config") or {}).get("addr", ""))} for t in tunnels]
    return found


def _ours(addr: str) -> bool:
    """Whether a tunnel forwards to this app ("http://localhost:8765", "localhost:8765", "8765")."""
    return re.search(rf"(?:^|:){re.escape(_port())}/?$", addr) is not None


def _running_url() -> str | None:
    """The https address of a tunnel to this app; the PUBLIC_URL one when several are up."""
    mine = [t["url"] for t in _tunnels() if t["url"].startswith("https://") and _ours(t["addr"])]
    want = urlsplit(get_settings().public_url).hostname
    return next((u for u in mine if urlsplit(u).hostname == want), mine[0] if mine else None)


def _ngrok_said() -> str | None:
    """ngrok's error from its log: the line with an ERR_NGROK code, else its last error line."""
    try:
        lines = _log_file().read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    errors = [ln for ln in lines if "ERR_NGROK_" in ln or "ERROR:" in ln or "lvl=eror" in ln or "lvl=crit" in ln]
    if not errors:
        return None
    line = next((ln for ln in errors if "ERR_NGROK_" in ln), errors[-1])
    m = re.search(r'err="((?:[^"\\]|\\.)*)"', line)  # logfmt: lvl=eror ... err="..."
    text = (m.group(1).replace("\\n", " ") if m else line.replace("ERROR:", "")).strip()
    code = re.search(r"ERR_NGROK_\d+", line)
    hint = HINTS.get(code.group(0)) if code else None
    return f"{hint} (ngrok: {text[:300]})" if hint else f"ngrok: {text[:300]}"


def _set_error(message: str | None) -> None:
    global _error
    if message != _error:  # the keeper retries every minute: log a change, not every round
        if message:
            log.warning("share tunnel down", extra={"fields": {"reason": message}})
        elif _error:
            log.info("share tunnel up again")
    _error = message


def public_base() -> str | None:
    """The tunnel's https address, or None when ngrok is not installed or did not come up (last_error says why)."""
    global _proc
    with _lock:
        if url := _running_url():
            _set_error(None)
            return url
        starting = _proc is not None and _proc.poll() is None  # ours is still coming up: wait for it, no second one
        others: list[dict] = []
        if not starting:
            # winget puts ngrok on PATH only for terminals opened after the install: look in its folder too
            winget = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
            exe = shutil.which("ngrok") or next((str(p) for p in winget.glob("Ngrok.Ngrok*/ngrok.exe")), None)
            if not exe:
                _set_error("ngrok is not installed on this PC (install it: `winget install ngrok.ngrok`).")
                return None
            s = get_settings()
            _stop_leftover()
            others = [t for t in _tunnels() if not _ours(t["addr"])]
            cmd = [exe, "http", _port(), "--log=stdout", "--log-format=logfmt"] + ([f"--url={s.public_url}"] if s.public_url else [])
            _log_file().parent.mkdir(parents=True, exist_ok=True)
            with open(_log_file(), "w", encoding="utf-8") as out:  # this start's output only: _ngrok_said reads it
                _proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT,
                                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            _pid_file().write_text(str(_proc.pid))
        for _ in range(20):  # ngrok is usually up within 1-3 s
            time.sleep(0.5)
            if url := _running_url():
                _set_error(None)
                return url
            if _proc is not None and _proc.poll() is not None:
                break  # ngrok gave up (no authtoken, address taken...): its log says why
        reason = _ngrok_said() or "ngrok did not come up within 10 seconds (its output is in .work/ngrok.log)."
        if others:
            reason += (f" Note: another ngrok on this PC forwards to {others[0]['addr']}, not to this app (port {_port()}):"
                       " close that ngrok window, then click Share again.")
        _set_error(reason)
        return None


def keep_alive(every_s: float = 60) -> None:
    """Keep the tunnel up while the server runs: started with the server (not only on the first share, so
    links already sent work again after a restart of the PC) and started again whenever ngrok stops.
    Only with a fixed PUBLIC_URL: a random ngrok address changes on every start, so old links would break."""
    if not get_settings().public_url:
        return

    def loop() -> None:
        while True:
            try:
                public_base()
            except Exception:  # noqa: BLE001 - never let the keeper die; it tries again next round
                log.warning("share tunnel keeper failed", exc_info=True)
            time.sleep(every_s)

    threading.Thread(target=loop, name="ngrok-keeper", daemon=True).start()


def through_tunnel(request: Request) -> bool:
    host = urlsplit("//" + (request.headers.get("host") or "")).hostname or ""
    own = urlsplit(get_settings().public_url).hostname
    return host == own or host.endswith(NGROK_DOMAINS)


async def guard(request: Request, call_next):
    if not through_tunnel(request):
        return await call_next(request)
    path = request.url.path
    if not path.startswith("/api/"):
        return await call_next(request)  # the page and its scripts; every API call below is checked
    m = SHARE_API.match(path)
    if request.method == "GET" and m:
        # a share call with a bad token: say whether the link expired or is broken (the share page shows it)
        if problem := tokens.problem(request.query_params.get("token"), int(m.group(1))):
            return JSONResponse({"detail": problem}, status_code=401)
        return await call_next(request)
    return JSONResponse({"detail": "Not found"}, status_code=404)
