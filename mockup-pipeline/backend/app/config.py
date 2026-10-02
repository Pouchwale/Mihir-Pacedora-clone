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
    # Who reads a spec table that has no live text (outlined glyphs): "ocr" (Tesseract, offline,
    # default) or an AI vision model reading the whole table in one call: "groq", "claude", "grok", "openrouter".
    # A failed AI call falls back to Tesseract. Live PDF text is always read first, whatever this says.
    text_reader: str = "ocr"
    # Optional per-cell fallback for low-confidence OCR fields: "none" (default), "claude", "grok"
    # (xAI), "groq" (Groq Cloud) or "openrouter". With "none" nothing leaves the server; low-confidence fields go
    # to NEEDS_REVIEW.
    vision_fallback: str = "none"
    anthropic_model: str = "claude-opus-5"  # key from ANTHROPIC_API_KEY
    xai_api_key: str = ""
    grok_model: str = "grok-4"
    groq_api_key: str = ""
    # A Groq model that accepts images (Groq's list changes: GET https://api.groq.com/openai/v1/models).
    groq_model: str = "qwen/qwen3.8-27b"
    openrouter_api_key: str = ""
    # Any OpenRouter model that accepts images (list: https://openrouter.ai/models?input_modalities=image).
    openrouter_model: str = "google/gemini-2.5-flash"
    work_dir: Path = Path("./.work")

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
