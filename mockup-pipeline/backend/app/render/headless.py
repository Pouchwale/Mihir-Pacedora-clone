"""Server-side renders (spec 5): open the same three.js scene as the viewer in headless Chromium.

The render page (/render/<job>) builds the scene from the job's geometry spec exactly like the
interactive viewer and exposes window.__render. This module drives it with Playwright:
one PNG per preset view, the GLB, and turntable frames (encoded to MP4 with ffmpeg).
Chromium uses SwiftShader (software WebGL), so no GPU is needed on the server.
"""

import base64
import logging
import socket
import subprocess
import threading
import time
from functools import lru_cache

from app.config import get_settings

log = logging.getLogger("render")
CHROMIUM_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-dev-shm-usage", "--no-sandbox"]
TURNTABLE_MAX_PX = 1080
TURNTABLE_MAX_FRAMES = 240


@lru_cache
def local_base_url() -> str:
    """Start this app on a private local port (once per process) for the headless browser."""
    import uvicorn

    from app.api.main import create_app

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_app(resume_jobs=False), host="127.0.0.1", port=port, log_level="warning", access_log=False))
    threading.Thread(target=server.run, daemon=True, name="render-server").start()
    deadline = time.time() + 30
    while not server.started and time.time() < deadline:
        time.sleep(0.1)
    if not server.started:
        raise RuntimeError("local render server did not start")
    return f"http://127.0.0.1:{port}"


class RenderResult:
    def __init__(self) -> None:
        self.views: dict[str, bytes] = {}
        self.glb: bytes | None = None
        self.mp4: bytes | None = None
        self.console: list[str] = []
        self.model_mm: dict = {}


def _png(data_url: str) -> bytes:
    return base64.b64decode(data_url.split(",", 1)[1])


def render(job_id: int, token: str, views: list[str], width: int, height: int, transparent: bool, want_glb: bool,
           turntable: tuple[float, int] | None, design: int | None = None) -> RenderResult:
    from playwright.sync_api import sync_playwright

    s = get_settings()
    url = f"{local_base_url()}/render/{job_id}?token={token}" + (f"&design={design}" if design else "")
    result = RenderResult()
    with sync_playwright() as p:
        browser = p.chromium.launch(args=CHROMIUM_ARGS, channel=s.render_browser_channel or None)
        try:
            page = browser.new_page(viewport={"width": 1024, "height": 1024})
            page.on("console", lambda m: result.console.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
            page.on("pageerror", lambda e: result.console.append(f"pageerror: {e}"))
            page.set_default_timeout(s.render_timeout_s * 1000)
            page.goto(url)
            page.wait_for_function("window.__render && (window.__render.ready || window.__render.error)")
            error = page.evaluate("window.__render.error || null")
            if error:
                raise RuntimeError(f"render page failed: {error}")
            result.model_mm = page.evaluate("() => window.__render.measure()")
            for view in views:
                if view == "turntable":
                    continue
                data = page.evaluate("([v, w, h, t]) => window.__render.renderView(v, w, h, t)", [view, width, height, transparent])
                result.views[view] = _png(data)
            if want_glb:
                result.glb = base64.b64decode(page.evaluate("() => window.__render.exportGLB()"))
            if turntable:
                seconds, fps = turntable
                frames = min(TURNTABLE_MAX_FRAMES, max(12, int(seconds * fps)))
                scale = min(1.0, TURNTABLE_MAX_PX / max(width, height))
                tw, th = int(width * scale) // 2 * 2, int(height * scale) // 2 * 2
                pngs = [
                    _png(page.evaluate("([i, n, w, h]) => window.__render.turntableFrame(i, n, w, h)", [i, frames, tw, th]))
                    for i in range(frames)
                ]
                result.mp4 = encode_mp4(pngs, fps=round(frames / seconds) if seconds else fps)
        finally:
            browser.close()
    return result


def encode_mp4(frames: list[bytes], fps: int) -> bytes:
    import imageio_ffmpeg

    import tempfile
    from pathlib import Path

    # +faststart (web-playable MP4) rewrites the file at the end, so the output must be seekable.
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "turntable.mp4"
        cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(fps), "-i", "-",
               "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", str(out)]
        proc = subprocess.run(cmd, input=b"".join(frames), capture_output=True, timeout=600)
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode(errors='replace')[-500:]}")
        return out.read_bytes()
