"""Process-level settings from the environment. Anything a business user may change lives in the index, not here."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Directory containing pdftoppm; empty means it is on PATH (the Docker image installs poppler-utils).
    poppler_bin: str = ""
    # Full path to tesseract; empty means it is on PATH (the Docker image installs tesseract-ocr).
    tesseract_cmd: str = ""
    # Groq Cloud is the only AI service the pipeline calls (app.ocr.groq); everything else is local.
    # Who reads a spec table that has no live text (outlined glyphs): "ocr" (Tesseract, offline,
    # default) or "groq" (its vision model reads the whole table in one call). A failed or
    # rate-limited Groq call falls back to Tesseract. Live PDF text is always read first.
    text_reader: str = "ocr"
    # Optional per-cell re-read of low-confidence OCR fields: "none" (default: nothing leaves the
    # server; weak fields go to NEEDS_REVIEW) or "groq".
    vision_fallback: str = "none"
    groq_api_key: str = ""
    # A Groq model that accepts images (Groq's list changes: GET https://api.groq.com/openai/v1/models).
    groq_model: str = "qwen/qwen3.8-27b"
    # Pacing under Groq's free-tier limits: at most this many calls a minute, and a rate-limit wait
    # longer than groq_max_wait_s is not waited out (local OCR instead; calls resume when it ends).
    groq_rpm: int = 20
    groq_max_wait_s: float = 60.0
    # Artwork renders (trim): "mupdf" (fast, colour-managed through the PDF's OutputIntent) or "poppler"
    # (pdftoppm, the reference renderer, ~4x slower on heavy sheets)
    artwork_renderer: str = "mupdf"
    groq_tpd: int = 0  # tokens per day the account may use; 0 = learn it from Groq's own "tokens per day" 429
    # No person in the loop: every review stop is answered automatically (app.workflow.auto_review)
    # and the job runs on to its 3D mockup. False brings back the review forms.
    auto_review: bool = True
    # The workflow a job runs when its upload named none: Phase 4 (pouches and shrink sleeves); "default"
    # when that one is not published.
    default_workflow: str = "phase4"
    work_dir: Path = Path("./.work")
    # The users' own folder, kept apart from the code: a readable copy of every PDF / XML / picture
    # they upload (uploads/<date>/<email>/) and the permanent logs (logs/activity, logs/server), one
    # file a day, written straight to disk so a shutdown or restart loses nothing (app.activity).
    data_dir: Path = Path("./data")

    # Database: Render Postgres in production ("postgresql://..." is accepted and mapped to psycopg).
    database_url: str = "sqlite:///./.work/dev.db"
    # First administrator, created at startup only while no active admin exists.
    admin_email: str = ""
    admin_password: str = ""
    session_hours: int = 12
    cookie_secure: bool = False  # True on Render (HTTPS)
    # Built React app served by the API service; empty disables static serving (Vite dev server).
    frontend_dist: str = "../frontend/dist"

    # Job queue: Render Key Value (Redis protocol) with RQ. Empty = run jobs in a thread of the API
    # process (local development).
    redis_url: str = ""
    queue_name: str = "jobs"
    # Signs short-lived tokens that let the headless renderer read one job's files.
    secret_key: str = "dev-secret-change-me"
    # Where the headless renderer reaches this app. The worker starts its own local server; in
    # thread mode it is the API itself.
    internal_base_url: str = "http://127.0.0.1:8765"
    # Share links for people outside this PC: the ngrok address customers open (your free static
    # domain, e.g. "https://name.ngrok-free.app"). Empty = whatever address ngrok hands out. The first
    # "Share" click starts ngrok when it is not running (app.api.tunnel).
    public_url: str = ""
    render_timeout_s: int = 600
    # Browser for the headless renderer: empty = Playwright's own Chromium (`playwright install
    # chromium`); "chrome" or "msedge" = the one installed on this machine (no download).
    render_browser_channel: str = ""

    # S3-compatible object storage (Cloudflare R2 / AWS S3). Empty bucket = local folder.
    s3_bucket: str = ""
    s3_endpoint_url: str = ""
    s3_access_key_id: str = ""
    s3_secret_access_key: str = ""
    s3_region: str = "auto"
    max_upload_mb: int = 200
    # Largest decoded PDF stream (an embedded image) a job may unpack; pypdf's own default is 75 MB.
    pdf_max_stream_mb: int = 1000

    def sqlalchemy_url(self) -> str:
        url = self.database_url
        for prefix in ("postgres://", "postgresql://"):
            if url.startswith(prefix):
                return "postgresql+psycopg://" + url[len(prefix):]
        return url

    def pdftoppm(self) -> str:
        return str(Path(self.poppler_bin) / "pdftoppm") if self.poppler_bin else "pdftoppm"


@lru_cache
def get_settings() -> Settings:
    return Settings()
