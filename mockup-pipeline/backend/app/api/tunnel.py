"""The ngrok tunnel behind share links: the app stays on this PC; only share pages are reachable outside.

public_base() returns the address customers open, starting `ngrok http 8765` on the first share when it
is not running. guard() turns away everything else that arrives through the tunnel (sign-in, jobs list,
uploads): a request whose Host is the ngrok address may only read one job's 3D view with a valid share token.
"""

import json
import os
import re
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.render import tokens

NGROK_DOMAINS = (".ngrok-free.app", ".ngrok-free.dev", ".ngrok.app", ".ngrok.dev", ".ngrok.io")
SHARE_API = re.compile(r"^/api/jobs/(\d+)(/scene|/file)?$")
AGENT = "http://127.0.0.1:4040/api/tunnels"  # ngrok's own local API


def _running_url() -> str | None:
    try:
        with urllib.request.urlopen(AGENT, timeout=1) as r:
            tunnels = json.load(r)["tunnels"]
    except (OSError, ValueError, KeyError):
        return None
    urls = [t["public_url"] for t in tunnels if t.get("public_url", "").startswith("https://")]
    return urls[0] if urls else None


def public_base() -> str | None:
    """The tunnel's https address, or None when ngrok is not installed or did not come up."""
    if url := _running_url():
        return url
    # winget puts ngrok on PATH only for terminals opened after the install: look in its folder too
    winget = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    exe = shutil.which("ngrok") or next((str(p) for p in winget.glob("Ngrok.Ngrok*/ngrok.exe")), None)
    if not exe:
        return None
    s = get_settings()
    port = s.internal_base_url.rsplit(":", 1)[-1].strip("/") or "8765"
    cmd = [exe, "http", port] + ([f"--url={s.public_url}"] if s.public_url else [])
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    for _ in range(20):  # ngrok is usually up within 1-3 s
        time.sleep(0.5)
        if url := _running_url():
            return url
    return None


def keep_alive(every_s: float = 60) -> None:
    """Keep the tunnel up while the server runs: started with the server (not only on the first share, so
    links already sent work again after a restart of the PC) and started again whenever ngrok stops.
    Only with a fixed PUBLIC_URL: a random ngrok address changes on every start, so old links would break."""
    import threading

    if not get_settings().public_url:
        return

    def loop() -> None:
        while True:
            try:
                public_base()
            except Exception:  # noqa: BLE001 - never let the keeper die; it tries again next round
                pass
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
    if request.method == "GET" and m and tokens.check(request.query_params.get("token"), int(m.group(1))):
        return await call_next(request)
    return JSONResponse({"detail": "Not found"}, status_code=404)
