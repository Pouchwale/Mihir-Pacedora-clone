"""Phase 1 runner (phase1/run_phase1.py) against the API in-process: a pouch from any PDF."""

import io
import json
import sys
import threading
from pathlib import Path

import pytest

from app import db as app_db
from app.models import JobStep
from app.render import headless
from tests.conftest import BLANKS, SAMPLE, needs_poppler, needs_tesseract
from tests.test_workflow import H, app_client  # noqa: F401 - fixture re-export

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "phase1"))
import run_phase1  # noqa: E402

pdf_tests = pytest.mark.usefixtures("_pdf_tools")


@pytest.fixture
def _pdf_tools(request):
    for mark in (needs_poppler, needs_tesseract):
        if mark.args[0]:
            pytest.skip(mark.kwargs["reason"])


def measuring_render(job_id, token, views, width, height, transparent, want_glb, turntable):
    """A render stub that measures like the real renderer would: the size the geometry was built to."""
    from PIL import Image
    from sqlalchemy import select

    with app_db._factory()() as s:  # the fixture makes _factory() return the test sessionmaker
        geo = s.scalar(select(JobStep).where(JobStep.job_id == job_id, JobStep.step == "build_geometry")).output["geometry"]
    r = headless.RenderResult()
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), "#ffffff").save(buf, format="PNG")
    r.views = {v: buf.getvalue() for v in views if v != "turntable"}
    r.glb = b"glTF" if want_glb else None
    r.model_mm = {"flat": {"x": geo["width_mm"], "y": geo["height_mm"], "z": 0.24}, "filled": {"x": geo["width_mm"], "y": geo["height_mm"], "z": 40.0}}
    return r


class TestClientApi:
    """The runner's HTTP client, on FastAPI's TestClient."""

    def __init__(self, client):
        self.client, self.base = client, "http://testserver"

    def json(self, method, path, body=None):
        r = self.client.request(method, path, json=body, headers=H)
        if r.status_code >= 400:
            raise run_phase1.ApiError(r.status_code, r.json() if "json" in r.headers.get("content-type", "") else r.text)
        return r.json()

    def upload(self, path, fields, files):
        r = self.client.post(path, data=fields, files=[(name, (f.name, f.read_bytes(), "application/pdf")) for name, f in files], headers=H)
        if r.status_code >= 400:
            raise run_phase1.ApiError(r.status_code, r.text)
        return r.json()

    def download(self, path):
        r = self.client.get(path)
        assert r.status_code == 200, path
        return r.content


def _runner(c, tmp_path, **kw):
    api = TestClientApi(c)
    kw.setdefault("wait_s", 0)
    runner = run_phase1.Phase1(api, tmp_path / "out", poll_s=0, log=lambda *a: None, **kw)
    runner.login("admin@example.com", "admin-password-1")
    return runner


def test_workflow_is_published_from_the_yaml(app_client, tmp_path):
    runner = _runner(app_client, tmp_path)
    v1 = runner.ensure_workflow()
    assert v1 >= 1
    assert runner.ensure_workflow() == v1  # unchanged file: no new version, no draft left behind
    wf = app_client.get("/api/workflows/phase1").json()
    assert wf["draft"] is None and wf["published"]["version"] == v1
    assert run_phase1.same_graph(wf["published"]["graph"], run_phase1.load_yaml(run_phase1.WORKFLOW_FILE))
    assert wf["published"]["graph"]["name"].startswith("Phase 1") and wf["problems"] == []
    assert [n["type"] for n in wf["published"]["graph"]["nodes"]] == [
        "start", "prepare", "fetch", "set_pouch_type", "validate", "resolve_keyline", "link_panels", "build_3d", "artwork", "render", "end"]


def test_seed_ships_the_same_workflow(seeded):
    from app.index import store

    assert run_phase1.same_graph(store.get_version(seeded, "workflow", "phase1").data, run_phase1.load_yaml(run_phase1.WORKFLOW_FILE))


def test_details_are_parsed_and_spellings_normalised():
    details = run_phase1.parse_details(["height=200", "width=150mm", "sealing=standy", "gusset=80", "gusset_type=bottom", "zipper=yes", "finish=Matt", "notch=v-notch"])
    assert details == {"pouch_height_mm": 200.0, "pouch_closed_width_mm": 150.0, "sealing_type": "Stand-up", "gusset_full_width_mm": 80.0,
                       "gusset_type": "Bottom", "zipper": True, "finish": "matt", "tear_notch": "V Notch"}
    assert run_phase1.parse_details(["gusset_type=no"])["gusset_type"] == "None"
    with pytest.raises(SystemExit, match="unknown key"):
        run_phase1.parse_details(["hieght=225"])
    with pytest.raises(SystemExit, match="not a number"):
        run_phase1.parse_details(["height=tall"])


@pdf_tests
def test_full_table_pdf_gives_the_exact_pouch(app_client, monkeypatch, tmp_path):
    """FGPO7215: every detail read from the table; the missing back / gusset get substitutes; 240 x 312 x 120."""
    monkeypatch.setattr(headless, "render", measuring_render)
    runner = _runner(app_client, tmp_path)
    runner.ensure_workflow()
    report = runner.run_pdf(SAMPLE)
    assert report["status"] == "DONE", report
    assert report["pouch_type"] == "stand_up_bottom_gusset"
    assert (report["pouch_mm"]["width_mm"], report["pouch_mm"]["height_mm"], report["pouch_mm"]["gusset_full_mm"]) == (240, 312, 120)
    assert report["details"]["pouch_height_mm"] == {"value": 312.0, "confidence": pytest.approx(0.99, abs=0.05)}
    assert report["assumed_by_runner"] == {} and report["confirmed_by_runner"] == {}  # nothing had to be guessed
    assert any("panels: back = front" in a for a in report["runner_answers"])
    assert report["workflow"]["key"] == "phase1" and [p[0] for p in report["workflow"]["path"]][:4] == ["start", "prepare", "details", "set_type"]
    assert report["model_measured_mm"]["flat"]["x"] == 240 and report["model_measured_mm"]["flat"]["y"] == 312
    folder = Path(report["folder"])
    assert folder.name == "FGPO7215"
    assert (folder / "details.json").exists() and (folder / "render_front.png").exists() and (folder / "FGPO7215.glb").exists()
    assert (folder / "keyline_front.svg").exists() and (folder / "texture_front.webp").exists()
    saved = json.loads((folder / "details.json").read_text(encoding="utf-8"))
    assert saved["model_measured_mm"]["flat"]["x"] == 240.0


@pdf_tests
def test_pillow_blanks_pdf(app_client, monkeypatch, tmp_path):
    """FGPO7396: two centre-seal blanks on the sheet; front and back come out of the first blank, 75 x 108."""
    monkeypatch.setattr(headless, "render", measuring_render)
    runner = _runner(app_client, tmp_path)
    runner.ensure_workflow()
    report = runner.run_pdf(BLANKS)
    assert report["status"] == "DONE", report
    assert report["pouch_type"] == "center_seal_pillow"
    assert (report["pouch_mm"]["width_mm"], report["pouch_mm"]["height_mm"]) == (75, 108)
    assert report["model_measured_mm"]["flat"] == {"x": 75, "y": 108, "z": 0.24}
    assert report["assumed_by_runner"] == {} and report["runner_answers"] == []  # fully automatic


def _plain_artwork_pdf(path: Path, width_mm: float, height_mm: float) -> Path:
    """A one-page PDF that is only a picture (no table, no dieline): what a designer might send."""
    import pymupdf
    from PIL import Image

    img = Image.new("RGB", (600, 780), (40, 90, 160))
    for y in range(0, 780, 60):
        img.paste((240, 200, 60), (0, y, 600, y + 30))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    doc = pymupdf.open()
    page = doc.new_page(width=width_mm / 25.4 * 72, height=height_mm / 25.4 * 72)
    page.insert_image(page.rect, stream=buf.getvalue())
    doc.save(path)
    doc.close()
    return path


@pdf_tests
def test_plain_artwork_pdf_gets_pdf_derived_defaults(app_client, monkeypatch, tmp_path):
    """No table at all: after the waiting time the runner takes the page size as the pouch size and a
    flat three-side-seal pouch, answers every required field at the first pause, and says so."""
    monkeypatch.setattr(headless, "render", measuring_render)
    pdf = _plain_artwork_pdf(tmp_path / "ARTWORK_only.pdf", 160, 240)
    runner = _runner(app_client, tmp_path)
    runner.ensure_workflow()
    report = runner.run_pdf(pdf)
    assert report["status"] == "DONE", report
    assert report["pouch_type"] == "three_side_seal"
    assert (report["pouch_mm"]["width_mm"], report["pouch_mm"]["height_mm"]) == (160, 240)
    assert report["model_measured_mm"]["flat"]["x"] == 160
    assumed = report["assumed_by_runner"]
    assert assumed["pouch_closed_width_mm"] == 160 and assumed["pouch_height_mm"] == 240 and assumed["sealing_type"] == "3 Side Seal"
    assert assumed["gusset_type"] == "None" and assumed["client_name"] == "ARTWORK" and "item_no" in assumed
    assert sum(1 for a in report["runner_answers"] if a.startswith("assumed")) == 1  # one pause answered, not two
    assert Path(report["folder"]).name.startswith("ARTWORK_only_job")


@pdf_tests
def test_details_from_the_command_line_win(app_client, monkeypatch, tmp_path):
    monkeypatch.setattr(headless, "render", measuring_render)
    pdf = _plain_artwork_pdf(tmp_path / "ARTWORK_only.pdf", 160, 240)
    details = run_phase1.parse_details(["height=200", "width=150", "sealing=Stand-up", "gusset=80", "gusset_type=Bottom", "zipper=yes"])
    runner = _runner(app_client, tmp_path, details=details)
    runner.ensure_workflow()
    report = runner.run_pdf(pdf)
    assert report["status"] == "DONE", report
    assert report["pouch_type"] == "stand_up_bottom_gusset"
    assert (report["pouch_mm"]["width_mm"], report["pouch_mm"]["height_mm"], report["pouch_mm"]["gusset_full_mm"]) == (150, 200, 80)
    assert "pouch_height_mm" not in report["assumed_by_runner"]


@pdf_tests
def test_details_override_a_complete_table(app_client, monkeypatch, tmp_path):
    """FGPO7215's table is complete, so no pause asks for details: the command line still wins (applied as adjustments)."""
    monkeypatch.setattr(headless, "render", measuring_render)
    runner = _runner(app_client, tmp_path, details=run_phase1.parse_details(["height=300"]))
    runner.ensure_workflow()
    report = runner.run_pdf(SAMPLE)
    assert report["status"] == "DONE", report
    assert (report["pouch_mm"]["width_mm"], report["pouch_mm"]["height_mm"]) == (240, 300)
    assert any("details from the command line applied" in a for a in report["runner_answers"])


@pdf_tests
def test_gusset_type_without_width_gets_a_derived_gusset(app_client, monkeypatch, tmp_path):
    monkeypatch.setattr(headless, "render", measuring_render)
    pdf = _plain_artwork_pdf(tmp_path / "ARTWORK_only.pdf", 160, 240)
    runner = _runner(app_client, tmp_path, details=run_phase1.parse_details(["height=200", "width=150", "gusset_type=Bottom"]))
    runner.ensure_workflow()
    report = runner.run_pdf(pdf)
    assert report["status"] == "DONE", report
    assert report["pouch_type"] == "stand_up_bottom_gusset" and report["assumed_by_runner"]["sealing_type"] == "Stand-up"
    assert report["pouch_mm"]["gusset_full_mm"] == 45 and report["assumed_by_runner"]["gusset_full_width_mm"] == 45  # 30 % of 150


@pdf_tests
def test_operator_answer_within_the_wait_wins(app_client, monkeypatch, tmp_path):
    """The runner waits --wait seconds; an operator who fills the form in time decides, nothing is assumed."""
    monkeypatch.setattr(headless, "render", measuring_render)
    pdf = _plain_artwork_pdf(tmp_path / "ARTWORK_only.pdf", 160, 240)
    runner = _runner(app_client, tmp_path, wait_s=8)
    runner.poll_s = 0.2
    runner.ensure_workflow()
    c = app_client

    def operator():
        # wait for the pause, then answer like the details form would
        import time

        for _ in range(100):
            jobs = c.get("/api/jobs").json()["jobs"]
            if jobs and jobs[0]["status"] == "NEEDS_REVIEW":
                corrections = {"spec_table.pouch_height_mm": 210, "spec_table.pouch_closed_width_mm": 140, "spec_table.sealing_type": "3 Side Seal",
                               "spec_table.gusset_type": "None", "spec_table.client_name": "Someone", "spec_table.item_no": "ITEM1", "spec_table.pouch_or_roll_form": "Pouch Form"}
                c.post(f"/api/jobs/{jobs[0]['id']}/review", json={"action": "specs", "corrections": corrections, "acknowledge": ["filename_code@item_no"]}, headers=H)
                return
            time.sleep(0.1)

    t = threading.Thread(target=operator)
    t.start()
    report = runner.run_pdf(pdf)
    t.join()
    assert report["status"] == "DONE", report
    assert (report["pouch_mm"]["width_mm"], report["pouch_mm"]["height_mm"]) == (140, 210)
    assert report["assumed_by_runner"] == {} and report["details"]["client_name"]["value"] == "Someone"


@pdf_tests
def test_unknown_pouch_type_and_rejected_values_stop_instead_of_looping(app_client, monkeypatch, tmp_path):
    monkeypatch.setattr(headless, "render", measuring_render)
    pdf = _plain_artwork_pdf(tmp_path / "ARTWORK_only.pdf", 160, 240)
    # a sealing type no rule matches -> type picker -> an unknown --pouch-type is refused with the list
    runner = _runner(app_client, tmp_path, details=run_phase1.parse_details(["height=200", "width=150", "sealing=Mystery"]), pouch_type="stand_up")
    runner.ensure_workflow()
    report = runner.run_pdf(pdf)
    assert report["status"] != "DONE" and "not in the index" in report["error"]
    # without --pouch-type the flat pouch is the default
    runner = _runner(app_client, tmp_path, details=run_phase1.parse_details(["height=200", "width=150", "sealing=Mystery"]))
    report = runner.run_pdf(pdf)
    assert report["status"] == "DONE" and report["pouch_type"] == "three_side_seal" and report["assumed_by_runner"]["pouch_type"] == "three_side_seal"


def test_a_print_sheet_is_not_taken_as_a_pouch_size(app_client, tmp_path):
    runner = _runner(app_client, tmp_path)
    d = {"outputs": {"trim_artwork": {"trim_width_mm": 771.8, "trim_height_mm": 541.9}, "extract_specs": {"mode": "page"}}}
    with pytest.raises(run_phase1.Stuck, match="print sheet"):
        runner.default_size(d)
    d = {"outputs": {"trim_artwork": {"trim_width_mm": 244.475, "trim_height_mm": 320.0},
                     "extract_specs": {"mode": "layers", "sheet": {"measured_keyline": {k: {"value": v} for k, v in
                                                                                        (("bleed_left_mm", 2.2375), ("bleed_right_mm", 2.2375), ("bleed_top_mm", 4), ("bleed_bottom_mm", 4))}}}}}
    assert runner.default_size(d) == (240, 312)  # TrimBox minus the measured bleed
