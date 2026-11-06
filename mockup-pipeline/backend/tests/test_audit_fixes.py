"""Regressions from the October 2026 audit: upload paths and sizes, share-token scope, a queued rerun
paused before it ran, undoing adjustments, keyline formulas that must reach review, not fail."""

import io
import zipfile

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app import auth
from app.api import main
from app.config import get_settings
from app.db import get_session
from app.index import formula
from app.index.resolve import resolve_keyline
from app.index.schemas import KeylineTemplate
from app.models import Job, JobStep, UploadedFile, User
from app.render import tokens
from app.workflow import engine as wf_engine
from app.workflow import runner
from app.workflow.adjust import Adjustments, earlier

H = {"X-Requested-With": "fetch"}


@pytest.fixture
def client(engine, seeded, monkeypatch):
    factory = sessionmaker(bind=engine, expire_on_commit=False)

    def override():
        with factory() as s:
            yield s

    main.app.dependency_overrides[get_session] = override
    monkeypatch.setattr(main, "get_engine", lambda: engine)
    seeded.add_all([
        User(email="admin@example.com", role="admin", password_hash=auth.hash_password("admin-password-1")),
        User(email="op@example.com", role="manager", password_hash=auth.hash_password("operator-password-1")),
    ])
    seeded.commit()
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def login(c, email="admin@example.com", password="admin-password-1"):
    assert c.post("/api/auth/login", json={"email": email, "password": password}).status_code == 200


def _job(session: Session, owner_email: str, status: str = "DONE") -> int:
    owner = session.scalar(select(User).where(User.email == owner_email))
    f = UploadedFile(filename="FGPO0001_Front.pdf", item_code="FGPO0001", sha256="0" * 64, size=1, storage_key="uploads/00/x.pdf",
                     uploaded_by_id=owner.id)
    session.add(f)
    session.flush()
    job = Job(file_id=f.id, item_code="FGPO0001", status=status, current_step="done", inputs={}, created_by_id=owner.id)
    session.add(job)
    session.commit()
    return job.id


def test_field_test_upload_cannot_write_outside_its_folder(client):
    login(client)
    target = get_settings().work_dir / "audit_escape.pdf"
    target.unlink(missing_ok=True)
    r = client.post("/api/index/test-fields", headers=H, data={"fields": ""},
                    files={"file": ("../../audit_escape.pdf", b"%PDF-1.4 not really a pdf", "application/pdf")})
    assert r.status_code == 422  # a broken PDF is the sender's problem, not a 500
    assert not target.exists()


def test_bad_job_ids_and_tokens_are_not_server_errors(client):
    login(client)
    assert client.get("/api/jobs/abc", headers=H).status_code == 404
    assert client.get("/api/jobs/99999999999999999999999", headers=H).status_code == 404
    anon = TestClient(main.app)
    assert anon.get("/api/jobs/1/scene?token=1.1.%C3%A9", headers=H).status_code == 401


def test_share_token_opens_the_view_only(client, seeded):
    job_id = _job(seeded, "admin@example.com")
    login(client, "op@example.com", "operator-password-1")  # a manager who does not own the job
    token = tokens.make(job_id, ttl_s=600)
    assert client.get(f"/api/jobs/{job_id}", headers=H).status_code == 404
    assert client.post(f"/api/jobs/{job_id}/cancel?token={token}", headers=H).status_code == 404
    assert client.get(f"/api/jobs/{job_id}/share-token?token={token}", headers=H).status_code == 404
    assert client.get(f"/api/jobs/{job_id}/share-info?token={token}", headers=H).status_code == 200


def test_zip_that_unpacks_past_the_limit_is_refused(client, monkeypatch):
    login(client)
    monkeypatch.setattr(get_settings(), "max_upload_mb", 1)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("FGPO0002_Front.pdf", b"%PDF-" + b"0" * (3 * 1024 * 1024))  # ~3 MB of zeros, a few KB zipped
    assert len(buf.getvalue()) < 1024 * 1024
    r = client.post("/api/uploads", headers=H, files={"files": ("batch.zip", buf.getvalue(), "application/zip")})
    assert r.status_code == 413


def test_default_secret_never_signs(monkeypatch):
    monkeypatch.setattr(get_settings(), "secret_key", tokens.DEFAULT_SECRET)
    monkeypatch.setattr(tokens, "_generated", None)
    import hashlib
    import hmac
    import time

    t = tokens.make(7, ttl_s=60)
    payload = f"7.{int(time.time()) + 60}"
    forged = f"{payload}.{hmac.new(tokens.DEFAULT_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]}"
    assert tokens.check(t, 7) and not tokens.check(forged, 7)


def test_paused_queued_rerun_is_redone_on_resume(engine, seeded, monkeypatch):
    owner = User(email="o@example.com", role="admin", password_hash="x")
    seeded.add(owner)
    seeded.commit()
    job_id = _job(seeded, "o@example.com", status="PAUSED")
    for step in runner.STEPS:
        seeded.add(JobStep(job_id=job_id, step=step, status="done"))
    seeded.commit()
    # "Apply and re-render" queued from texture, popped while the job is paused
    assert wf_engine.run_job(job_id, "texture", engine=engine) == "PAUSED"
    seen = {}

    class Walker:
        def __init__(self, session, job, ctx, graph):
            self.session, self.job = session, job

        def run(self):
            rows = self.session.scalars(select(JobStep).where(JobStep.job_id == self.job.id))
            seen.update({r.step: r.status for r in rows})
            return "DONE"
    monkeypatch.setattr(runner, "Walker", Walker)
    with Session(engine) as s:
        s.get(Job, job_id).status = "QUEUED"  # Resume
        s.commit()
    wf_engine.run_job(job_id, None, engine=engine)  # resume names no step
    assert seen["texture"] == seen["render"] == "pending" and seen["build_geometry"] == "done"
    with Session(engine) as s:
        assert "pending_from" not in (s.get(Job, job_id).inputs or {})


def test_undoing_an_adjustment_redoes_its_step():
    logo = {"kind": "image", "file_id": 3}
    before = Adjustments.model_validate({"panels": {"front": {"overlays": [logo]}}, "material": {"finish": "matt"}})
    now = Adjustments.model_validate({"material": {"finish": "matt"}})
    assert now.changed_step(before) == "texture"  # the logo is taken out again
    logo_only = Adjustments.model_validate({"panels": {"front": {"overlays": [logo]}}})
    assert logo_only.earliest_step() == "texture"  # (what was looked at before the fix)
    assert earlier(logo_only.earliest_step(), logo_only.changed_step(before)) == "build_geometry"  # finish back to automatic
    moved = Adjustments.model_validate({"panels": {"front": {"overlays": [logo], "rotation": 180}}, "material": {"finish": "matt"}})
    assert moved.changed_step(before) == "render"


def test_job_can_turn_off_an_item_default_swap():
    base = Adjustments.model_validate({"swap_front_back": True})
    assert Adjustments.model_validate({"swap_front_back": False}).merged_over(base).swap_front_back is False
    assert Adjustments.model_validate({}).merged_over(base).swap_front_back is True


def test_stuck_xml_prefetch_does_not_hold_other_jobs(tmp_path, monkeypatch):
    """A trim step that fails leaves the prefetch waiting for an analysis that never comes: it waits on
    its own thread, the shared OCR worker stays free, and the wait ends with an error extract_specs handles."""
    from app.pdf.profile import PdfProfile
    from app.steps import extract_specs as es

    pdf = tmp_path / "FGPO0003_Front.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    monkeypatch.setattr(es.sheet_impl, "analysed", lambda *a: False)
    monkeypatch.setattr(es, "PREFETCH_WAIT_S", 1)
    profile = PdfProfile()
    es.prefetch_table_ocr(pdf, profile)
    assert es._BACKGROUND.submit(lambda: "free").result(timeout=0.5) == "free"
    pending = es._PREFETCH.pop(es._prefetch_key(pdf, profile))
    with pytest.raises(TimeoutError):
        pending.result(timeout=5)


def test_xml_cell_boxes_match_the_stored_preview():
    from app.ocr.table import FieldRead
    from app.steps.extract_specs import XML_PREVIEW_DPI, _scale_bboxes

    reads = {"item_no": FieldRead("item_no", "FGPO1", "FGPO1", 1.0, True, (300, 600, 900, 660)), "teeth": FieldRead("teeth", None, None, 1.0, True, None)}
    _scale_bboxes(reads, XML_PREVIEW_DPI / 300)  # words at 300 dpi, preview stored at 100
    assert reads["item_no"].bbox == (100, 200, 300, 220) and reads["teeth"].bbox is None


def test_keyline_formula_problems_reach_review_not_a_crash(seeded):
    from app.index import store

    index = store.load_all(seeded)
    tpl: KeylineTemplate = index["keyline_template"]["three_side_seal"]
    fields = dict(tpl.fields)
    fields["top_seal_mm"] = fields["top_seal_mm"].model_copy(update={"from_spec": "sealing_width_mm", "from_measured": None})
    fields["side_seal_mm"] = fields["side_seal_mm"].model_copy(update={"from_measured": "measured.width_segments_mm[0] ** 400.0"})
    broken = tpl.model_copy(update={"fields": fields})
    ctx = {"spec": {"sealing_width_mm": 10, "pouch_height_mm": 200}, "measured": {"width_segments_mm": [10.0, 100.0, 10.0]}}
    out = resolve_keyline("three_side_seal", broken, "three_side_seal", ctx)
    problems = {i.field for i in out.issues}
    assert "keyline.top_seal_mm" in problems and "keyline.side_seal_mm" in problems
    with pytest.raises(formula.FormulaError):
        formula.evaluate("9 ** 9 ** 9", lambda ns, n: None)


def test_share_token_fills_the_index_email_template(client, seeded):
    from app.index import store

    job_id = _job(seeded, "admin@example.com")
    login(client)
    mail = client.get(f"/api/jobs/{job_id}/share-token", headers=H).json()["mail"]
    assert mail["subject"] == "3D mockup for FGPO0001"  # the shipped default, no entry saved yet
    assert "/share/" in mail["body"] and "Sir/Madam" in mail["body"] and "admin@example.com" in mail["body"]
    store.save(seeded, "email_template", "default", {"subject": "{item_code} for {client}", "body": "See {link} {unknown}"},
               store.Author(id=None, email="t"), "test")
    seeded.commit()
    mail = client.get(f"/api/jobs/{job_id}/share-token", headers=H).json()["mail"]
    assert mail["subject"] == "FGPO0001 for Sir/Madam"
    assert mail["body"].startswith("See ") and "/share/" in mail["body"] and mail["body"].endswith("{unknown}")
