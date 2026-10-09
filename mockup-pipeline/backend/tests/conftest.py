import json
import os
import shutil
from pathlib import Path

import pytest

# Tests must never touch the developer's database: anything that reaches the default engine
# (settings default = .work/dev.db) goes to a throwaway file instead. Set before app.config loads.
os.environ.setdefault("DATABASE_URL", f"sqlite:///{(Path(__file__).parent / '.tmp' / 'default.db').as_posix()}")
os.environ.setdefault("WORK_DIR", str(Path(__file__).parent / ".tmp" / "work"))
os.environ.setdefault("DATA_DIR", str(Path(__file__).parent / ".tmp" / "data"))  # uploads copies and logs
# ... and never call a paid vision API, whatever backend/.env says (environment beats .env).
os.environ["VISION_FALLBACK"] = "none"
os.environ["TEXT_READER"] = "ocr"
# The tests drive the review forms themselves; app.workflow.auto_review has its own tests.
os.environ["AUTO_REVIEW"] = "false"
# The pouch tests walk the default graph; Phase 4 (pouches + sleeves) has its own tests.
os.environ.setdefault("DEFAULT_WORKFLOW", "default")
os.environ["PUBLIC_URL"] = ""  # (tests never start the ngrok tunnel)

from app.config import get_settings  # noqa: E402
from app.specs.schema import Extraction  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
SAMPLE = FIXTURES / "FGPO7215_Dog_Food_Front_App.pdf"
NON_ARTPRO = FIXTURES / "FGPO6862_Korean_Chilli_Crunch_Front_App.pdf"  # Adobe Illustrator, no layers, front only
COMBINED = FIXTURES / "FGPO7535_Strawberry-app.pdf"  # Adobe Illustrator, no layers, front + gusset + back on one sheet
ROLL = FIXTURES / "FGPO7138_Pista_App.pdf"  # PDFium re-save, no layers, outlined text, roll form with two repeats
FRONT_GUSSET = FIXTURES / "FGPO7404_Snacki_Walnut_Front_Gusset_App.pdf"  # cover page + sheet with front and gusset, no back
BLANKS = FIXTURES / "FGPO7396_Country_Delight_Cookies_App.pdf"  # centre seal: two flat blanks side by side, artwork + technical preview copies
FRONT_BACK = FIXTURES / "FGPO7492_Mango_Slice_F+B_App.pdf"  # stand-up F+B web (front, 13 mm seal band, back; no gusset panel), two copies
NAMKEEN = FIXTURES / "FGPO3970_Premiyum_Nakeen_Pink_App.pdf"  # ArtPro+ flattened by Adobe: TrimBox = the F+B web; separate gusset drawing; dashed zipper
EURO_FLOW = FIXTURES / "FGPO7442_Euro-Flow_Pouch_App.pdf"  # PDFium re-save: F+B web whose outer lines overshoot the corners (no closed grid), two copies


def _have(cmd: str) -> bool:
    return shutil.which(cmd) is not None or Path(cmd).exists() or Path(cmd + ".exe").exists()


needs_poppler = pytest.mark.skipif(not _have(get_settings().pdftoppm()), reason="pdftoppm not available (set POPPLER_BIN)")
needs_tesseract = pytest.mark.skipif(
    not _have(get_settings().tesseract_cmd or "tesseract"), reason="tesseract not available (set TESSERACT_CMD)"
)


@pytest.fixture
def expected_extraction() -> Extraction:
    return Extraction.model_validate(json.loads((FIXTURES / "FGPO7215_expected_extraction.json").read_text()))


SAMPLE_SPEC = Path(__file__).resolve().parents[1] / "app" / "index" / "seed" / "sample_spec_FGPO7215.json"
SEED = Path(__file__).resolve().parents[1] / "app" / "index" / "seed" / "index.yaml"


@pytest.fixture
def sample_sheet():
    from app.specs.schema import SpecSheet

    return SpecSheet.model_validate(json.loads(SAMPLE_SPEC.read_text(encoding="utf-8")))


@pytest.fixture
def engine(tmp_path):
    """A fresh SQLite database migrated with the real Alembic migrations."""
    from alembic import command
    from alembic.config import Config

    from app.db import make_engine

    url = f"sqlite:///{(tmp_path / 'test.db').as_posix()}"
    cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    cfg.attributes["url"] = url
    command.upgrade(cfg, "head")
    return make_engine(url)


@pytest.fixture
def db(engine):
    from sqlalchemy.orm import Session

    with Session(engine, expire_on_commit=False) as session:
        yield session


@pytest.fixture
def seeded(db):
    from app.index import store

    plan = store.plan_import(db, SEED.read_text(encoding="utf-8"))
    store.apply_import(db, plan, store.Author(None, "system"), "seed", action="seed")
    db.commit()
    return db


@pytest.fixture(autouse=True)
def _groq_isolated(tmp_path, monkeypatch):
    """Every test starts with an empty Groq answer cache of its own, no pacing state and no real waits."""
    from app.ocr import groq

    monkeypatch.setattr(groq, "_cache_file", lambda settings, key: tmp_path / "groq-cache" / f"{key}.json")
    for name in ("last_call", "wait_until", "blocked_until"):
        monkeypatch.setattr(groq._State, name, 0.0)
    monkeypatch.setattr(groq, "_sleep", lambda s: None)
