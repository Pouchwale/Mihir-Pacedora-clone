"""Workflow engine and job API on the real sample PDF (renderer stubbed unless noted)."""

import io
import json
import threading
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy.orm import sessionmaker

from app import auth
from app.api import job_routes, main
from app.db import get_session
from app.models import Job, User
from app.render import headless, tokens
from app.storage import LocalStorage
from app.workflow import engine as wf_engine
from app.workflow import queue
from tests.conftest import COMBINED, FRONT_GUSSET, ROLL, SAMPLE, needs_poppler, needs_tesseract

H = {"X-Requested-With": "fetch"}
DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist" / "index.html"


def _png(w=64, h=64) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "#ffffff").save(buf, format="PNG")
    return buf.getvalue()


def fake_render(job_id, token, views, width, height, transparent, want_glb, turntable):
    r = headless.RenderResult()
    r.views = {v: _png() for v in views if v != "turntable"}
    r.glb = b"glTF" if want_glb else None
    r.model_mm = {"flat": {"x": 240.0, "y": 312.0, "z": 0.24}, "filled": {"x": 240.0, "y": 312.0, "z": 60.0}}
    return r


@pytest.fixture
def app_client(engine, seeded, tmp_path, monkeypatch):
    storage = LocalStorage(tmp_path / "storage")
    for mod in (wf_engine, job_routes):
        monkeypatch.setattr(mod, "get_storage", lambda: storage)
    # Run queued jobs to the end before the request returns, on a worker thread as in production:
    # an async endpoint's event loop must not host the renderer's sync Playwright.
    def run_now(job_id, from_step=None, from_node=None):
        t = threading.Thread(target=wf_engine.run_job, args=(job_id, from_step), kwargs={"engine": engine, "from_node": from_node})
        t.start()
        t.join()

    monkeypatch.setattr(queue, "enqueue", run_now)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    # the renderer's private server is a separate app instance: point the default session there too
    import app.db

    monkeypatch.setattr(app.db, "_factory", lambda: factory)
    monkeypatch.setattr(main, "get_engine", lambda: engine)

    def override():
        with factory() as s:
            yield s

    main.app.dependency_overrides[get_session] = override
    seeded.add(User(email="op@example.com", role="operator", password_hash=auth.hash_password("operator-password-1")))
    seeded.add(User(email="admin@example.com", role="admin", password_hash=auth.hash_password("admin-password-1")))
    seeded.commit()
    c = TestClient(main.app)
    c.post("/api/auth/login", json={"email": "op@example.com", "password": "operator-password-1"}).raise_for_status()
    c.storage = storage  # type: ignore[attr-defined]
    yield c
    main.app.dependency_overrides.clear()


def _upload(c, path=SAMPLE):
    with open(path, "rb") as fh:
        r = c.post("/api/uploads", files={"files": (path.name, fh, "application/pdf")}, headers=H)
    assert r.status_code == 200, r.text
    return r.json()


@needs_poppler
@needs_tesseract
def test_sample_job_end_to_end(app_client, monkeypatch):
    monkeypatch.setattr(headless, "render", fake_render)
    c = app_client
    up = _upload(c)
    job_id = up["jobs"][0]
    d = c.get(f"/api/jobs/{job_id}").json()
    # The front links to FGPO7216 (back) and FGPO7233 (gusset), which were not uploaded: the back is
    # asked for; a gusset with no artwork is plain film (PdfProfile.plain_missing_gussets)
    assert d["job"]["status"] == "NEEDS_REVIEW"
    assert d["review"]["code"] == "missing_panels"
    missing = {m["role"]: m["code"] for m in d["review"]["details"]["missing"]}
    assert missing == {"back": "FGPO7216"}
    assert d["job"]["pouch_type"] == "stand_up_bottom_gusset"
    assert d["outputs"]["validate"]["sheet"]["spec_table"]["client_name"]["value"] == "Crystal Enterprises"
    kl = d["outputs"]["resolve_keyline"]["keyline"]["fields"]
    assert (kl["gusset_depth_mm"]["value"], kl["gusset_depth_mm"]["source"]) == (60.0, "pouch_type")
    assert (kl["bleed_left_mm"]["value"], kl["bleed_left_mm"]["source"]) == (2.2375, "measured")

    # Operator continues with substitutes
    choices = {"back": {"substitute": "front"}, "gusset": {"substitute": "plain", "color": "#29224b"}}
    r = c.post(f"/api/jobs/{job_id}/review", json={"action": "panels", "panel_choices": choices}, headers=H)
    assert r.status_code == 200
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "DONE", d["job"]
    tex = d["outputs"]["texture"]["textures"]
    assert tex["front"]["px"] == [2835, 3686] and tex["back"]["source"] == "front" and tex["gusset"]["color"] == "#29224b"
    geo = d["outputs"]["build_geometry"]["geometry"]
    assert (geo["width_mm"], geo["height_mm"], geo["gusset_full_mm"], geo["gusset_depth_mm"]) == (240, 312, 120, 60)
    assert geo["zipper"]["enabled"] and geo["tear_notch"]["type"] == "v_notch" and geo["corner_radius_mm"] == 6
    assert geo["materials"]["surfaces"]["base"]["roughness"] == 0.85  # matt

    # scene for the viewer, files, keyline SVG, ZIP with audit
    scene = c.get(f"/api/jobs/{job_id}/scene").json()
    assert set(scene["textures"]) == {"front", "back", "gusset"}
    svg = c.get(scene["textures"]["front"]["url"].replace("_web.webp", "_keyline.svg"))
    assert svg.status_code == 200 and b"<svg" in svg.content and b"zipper" in svg.content
    z = zipfile.ZipFile(io.BytesIO(c.get(f"/api/jobs/{job_id}/download.zip").content))
    names = z.namelist()
    assert "data/audit.json" in names and any(n.startswith("renders/FGPO7215_crystal-enterprises_") for n in names)
    audit = json.loads(z.read("data/audit.json"))
    assert audit["pouch_type"]["key"] == "stand_up_bottom_gusset" and audit["keyline"]["version"] == 1
    assert audit["input_files"][0]["sha256"] == up["files"][0]["sha256"]
    assert {f["role"]: f.get("substitute") for f in audit["input_files"][1:]} == {"back": "front", "gusset": "plain"}

    # rerun from any step is idempotent
    before = c.get(f"/api/jobs/{job_id}").json()["outputs"]["build_geometry"]["geometry"]
    assert c.post(f"/api/jobs/{job_id}/rerun", json={"from_step": "resolve_keyline"}, headers=H).status_code == 200
    after = c.get(f"/api/jobs/{job_id}").json()
    assert after["job"]["status"] == "DONE" and after["outputs"]["build_geometry"]["geometry"] == before

    # operators cannot approve or move to the latest index; admins can
    assert c.post(f"/api/jobs/{job_id}/approve", headers=H).status_code == 403
    assert c.post(f"/api/jobs/{job_id}/rerun", json={"from_step": "render", "latest_index": True}, headers=H).status_code == 403
    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"email": "admin@example.com", "password": "admin-password-1"}).raise_for_status()
    assert c.post(f"/api/jobs/{job_id}/approve", headers=H).json()["approved_by"] == "admin@example.com"


@needs_poppler
@needs_tesseract
def test_forced_pouch_type_and_linked_panel_upload(app_client, monkeypatch):
    monkeypatch.setattr(headless, "render", fake_render)
    c = app_client
    job_id = _upload(c)["jobs"][0]
    # the operator picks a different type: side gussets need side_left + side_right; with no artwork
    # for them anywhere they are plain film (PdfProfile.plain_missing_gussets), only the back is asked for
    c.post(f"/api/jobs/{job_id}/review", json={"action": "pouch_type", "pouch_type": "quad_seal"}, headers=H)
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["pouch_type"] == "quad_seal" and d["review"]["code"] == "missing_panels"
    assert {m["role"] for m in d["review"]["details"]["missing"]} == {"back"}
    # a panel PDF uploaded under its item code is found in the registry; here the sample stands in for the back
    r = c.post(f"/api/jobs/{job_id}/panel-file", data={"role": "back"}, files={"file": ("FGPO7216_back.pdf", SAMPLE.read_bytes(), "application/pdf")}, headers=H)
    assert r.status_code == 200
    d = c.get(f"/api/jobs/{job_id}").json()
    panels = d["outputs"]["link_panels"]["panels"]
    assert panels["back"]["source"] == "file" and panels["side_left"]["source"] == panels["side_right"]["source"] == "plain"
    # the operator swaps front and back: with the back in its own PDF, link_panels trades the two files
    r = c.post(f"/api/jobs/{job_id}/adjust", json={"adjust": {"swap_front_back": True}}, headers=H)
    assert r.status_code == 200
    swapped = c.get(f"/api/jobs/{job_id}").json()["outputs"]["link_panels"]["panels"]
    assert swapped["front"]["filename"] == panels["back"]["filename"] and swapped["back"]["filename"] == panels["front"]["filename"]
    assert swapped["front"]["role"] == "front" and swapped["back"]["role"] == "back"


@needs_poppler
@needs_tesseract
def test_combined_sheet_job_runs_without_review(app_client, monkeypatch):
    """FGPO7535: one Illustrator PDF with front, gusset and back on its dieline -> done, no operator."""
    import numpy as np

    monkeypatch.setattr(headless, "render", fake_render)
    c = app_client
    job_id = _upload(c, COMBINED)["jobs"][0]
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "DONE", (d["job"], d.get("review"))
    assert d["job"]["pouch_type"] == "stand_up_bottom_gusset" and d["job"]["client_name"] == "Krunchify"
    panels = d["outputs"]["link_panels"]["panels"]
    assert {r: (p["source"], p["rotation"]) for r, p in panels.items()} == {"front": ("sheet", 0), "gusset": ("sheet", 0), "back": ("sheet", 180)}
    tex = d["outputs"]["texture"]["textures"]
    assert {r: (t["width_mm"], t["height_mm"]) for r, t in tex.items()} == {"front": (120.65, 210), "back": (120.65, 210), "gusset": (120.65, 80)}
    for t in tex.values():  # 300 dpi, within pdftoppm's pixel rounding
        assert t["px"] == pytest.approx([t["width_mm"] * 300 / 25.4, t["height_mm"] * 300 / 25.4], abs=1.5)
    geo = d["outputs"]["build_geometry"]["geometry"]
    assert (geo["width_mm"], geo["height_mm"], geo["gusset_full_mm"], geo["gusset_depth_mm"]) == (120.65, 210, 80, 40)
    assert geo["seals"]["top"] == geo["seals"]["bottom"] == geo["seals"]["side"] == 10
    assert (geo["zipper"]["enabled"], geo["zipper"]["y_from_top_mm"]) == (True, 23.5)
    assert (geo["tear_notch"]["type"], geo["tear_notch"]["y_from_top_mm"]) == ("v_notch", 17)
    assert geo["corner_radius_mm"] == 6 and geo["materials"]["surfaces"]["base"]["roughness"] == 0.85  # matt BOPP outside

    # the back is the sheet's lower face turned upright: its finished texture is that crop rotated 180 degrees
    storage = c.storage  # type: ignore[attr-defined]
    sheet = Image.open(io.BytesIO(storage.get_bytes(d["outputs"]["trim_artwork"]["bleed_key"]))).convert("RGB")
    back = Image.open(io.BytesIO(storage.get_bytes(tex["back"]["finished_key"]))).convert("RGB")
    px = sheet.width / 120.65
    lower = sheet.crop((0, round(296 * px), back.width, round(296 * px) + back.height)).rotate(180)
    assert np.abs(np.asarray(lower).astype(int) - np.asarray(back).astype(int)).mean() < 2
    assert any(e["message"].startswith("Sheet carries 3 panels") for e in d["events"])


@needs_poppler
@needs_tesseract
def test_roll_form_job_runs_without_review(app_client, monkeypatch):
    """FGPO7138: a PDFium re-save (no layers, outlined text, two print repeats, 'White-1' plate) of a
    roll-form job -> roll stock, the repeat on the roll and a sachet cut from one pouch blank."""
    monkeypatch.setattr(headless, "render", fake_render)
    c = app_client
    job_id = _upload(c, ROLL)["jobs"][0]
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "DONE", (d["job"], d.get("review"))
    assert d["job"]["pouch_type"] == "roll_stock" and d["job"]["client_name"] == "Vadilal Industries Ltd"
    t = d["outputs"]["validate"]["sheet"]["spec_table"]
    assert (t["pouch_height_mm"]["value"], t["pouch_closed_width_mm"]["value"], t["pouch_open_width_mm"]["value"]) == (247.65, 57, 150)
    assert (t["circumference_mm"]["value"], t["ar_ups"]["value"], t["ac_ups"]["value"], t["inside_b2b_width_mm"]["value"]) == (247.65, 1, 2, 304)
    assert t["inks"]["value"] == ["Cyan", "Magenta", "Yellow", "Black", "P352 C", "P293 C", "White"]  # "White-1" snaps to the known plate name
    assert t["finish"]["value"] == "gloss" and t["pouch_or_roll_form"]["value"] == "Roll Form"
    ex = d["outputs"]["extract_specs"]
    assert ex["mode"] == "separation" and ex["repeats"] == 2 and ex["roll_form"] is True
    panels = d["outputs"]["link_panels"]["panels"]
    assert list(panels) == ["roll"] and panels["roll"]["expected_mm"] == [247.65, 304]
    tex = d["outputs"]["texture"]["textures"]
    assert {r: (t["width_mm"], t["height_mm"], t["source"]) for r, t in tex.items()} == {
        "roll": (247.65, 304, "sheet"), "front": (57, 247.65, "roll"), "back": (57, 247.65, "roll")}
    geo = d["outputs"]["build_geometry"]["geometry"]
    assert (geo["roll"]["repeat_mm"], geo["roll"]["web_width_mm"]) == (247.65, 304)
    assert (geo["width_mm"], geo["height_mm"], geo["seals"]["fin"]) == (57, 247.65, 18)  # (150 - 2 x 57) / 2
    assert any("2 repeats" in e["message"] for e in d["events"])


@needs_poppler
@needs_tesseract
def test_cover_page_front_gusset_sheet(app_client, monkeypatch):
    """FGPO7404: a 'STOP! read carefully' cover page, then a sheet with the front and the bottom gusset
    (no back). Layers without 'mic', 'Standy+Zipper', 'Bottom Gusset' all read; the back is asked for."""
    monkeypatch.setattr(headless, "render", fake_render)
    c = app_client
    job_id = _upload(c, FRONT_GUSSET)["jobs"][0]
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "NEEDS_REVIEW", (d["job"], d.get("review"))
    assert d["review"]["code"] == "missing_panels" and [m["role"] for m in d["review"]["details"]["missing"]] == ["back"]
    assert any("2 pages; page 2 carries the artwork" in e["message"] for e in d["events"])
    t = d["outputs"]["validate"]["sheet"]["spec_table"]
    # "Standy+Zipper" as printed is stored as its canonical option (field dictionary synonyms)
    assert (t["client_name"]["value"], t["item_no"]["value"], t["sealing_type"]["value"], t["gusset_type"]["value"]) == ("SHAKTI AGRONUTS", "FGPO7404", "Stand-up+Zipper", "Bottom")
    assert (t["pouch_height_mm"]["value"], t["pouch_closed_width_mm"]["value"], t["gusset_full_width_mm"]["value"], t["zipper"]["value"]) == (295, 217, 110, True)
    assert [(l["micron"], l["material"]) for l in t["layers"]["value"]] == [(25, "Matt BOPP"), (12, "METPET"), (75, "LDPE(NaturalGeneral)")]
    assert t["inks"]["value"] == ["Black", "Cyan", "Magenta", "Yellow", "White"] and t["finish"]["value"] == "matt"
    layout = d["outputs"]["extract_specs"]["layout"]
    assert [(p["role"] or p["kind"], p["height_mm"]) for p in layout["panels"]] == [("front", 295), ("gusset", 110)]
    assert d["job"]["pouch_type"] == "stand_up_bottom_gusset"
    assert d["outputs"]["resolve_keyline"]["keyline"]["fields"]["zipper_offset_from_top_mm"]["value"] == 28.5
    # the back: same artwork as the front
    r = c.post(f"/api/jobs/{job_id}/review", json={"action": "panels", "panel_choices": {"back": {"substitute": "front"}}}, headers=H)
    assert r.status_code == 200
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "DONE", (d["job"], d.get("review"))
    tex = d["outputs"]["texture"]["textures"]
    assert {r: (t["width_mm"], t["height_mm"], t["source"]) for r, t in tex.items()} == {
        "front": (217, 295, "sheet"), "gusset": (217, 110, "sheet"), "back": (217, 295, "front")}


@needs_poppler
@needs_tesseract
def test_unusable_panel_pdf_goes_to_the_panels_form(app_client, monkeypatch):
    """A report (40 pages, no dieline) supplied as the gusset: the operator gets the panels form for it."""
    from pypdf import PdfWriter

    monkeypatch.setattr(headless, "render", fake_render)
    c = app_client
    job_id = _upload(c)["jobs"][0]
    w = PdfWriter()
    for _ in range(3):
        w.add_blank_page(595, 842)
    buf = io.BytesIO()
    w.write(buf)
    r = c.post(f"/api/jobs/{job_id}/panel-file", data={"role": "gusset"}, files={"file": ("report.pdf", buf.getvalue(), "application/pdf")}, headers=H)
    assert r.status_code == 200
    d = c.get(f"/api/jobs/{job_id}").json()
    # a multi-page file is reduced to its "artwork" page; a blank A4 page is then the wrong size for a gusset
    assert d["job"]["status"] == "NEEDS_REVIEW" and d["review"]["code"] == "panel_size"
    details = d["review"]["details"]
    assert details["form"] == "panels" and [m["role"] for m in details["missing"]] == ["gusset"]
    assert "report.pdf" in d["review"]["message"]


@needs_poppler
@needs_tesseract
def test_job_page_adjustments(app_client, monkeypatch):
    """Adjustments from the job page: rerun from the first step they change, feed the viewer as
    texture transforms, and (admin) become the item's default for the next upload."""
    monkeypatch.setattr(headless, "render", fake_render)
    c = app_client
    job_id = _upload(c, COMBINED)["jobs"][0]
    assert c.get(f"/api/jobs/{job_id}").json()["job"]["status"] == "DONE"

    # scene + material + artwork placement: reruns from build_geometry; transforms reach the scene
    adjust = {
        "panels": {"front": {"offset_x_mm": 3, "scale": 1.1, "rotation": 180}},
        "material": {"finish": "gloss", "metallic": "off"},
        "scene": {"lighting": "studio_soft", "shadow": False, "views": ["front"]},
    }
    r = c.post(f"/api/jobs/{job_id}/adjust", json={"adjust": adjust}, headers=H)
    assert r.status_code == 200, r.text
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "DONE", (d["job"], d.get("review"))
    geo = d["outputs"]["build_geometry"]["geometry"]
    assert (geo["preset"]["lighting"], geo["preset"]["shadow"], geo["preset"]["views"]) == ("studio_soft", False, ["front"])
    assert geo["materials"]["surfaces"]["base"]["roughness"] == 0.2  # gloss overrides the matt of "25 mic matt BOPP"
    assert list(d["outputs"]["render"]["views"]) == ["front"]
    assert d["steps"][[s["step"] for s in d["steps"]].index("link_panels")]["attempt"] == 1  # not rerun: nothing before build_geometry changed
    scene = c.get(f"/api/jobs/{job_id}/scene").json()
    assert scene["textures"]["front"]["transform"] == {"rotation": 180, "flip_x": False, "flip_y": False, "offset_x_mm": 3, "offset_y_mm": 0, "scale": 1.1}
    assert scene["textures"]["back"]["transform"] is None and scene["adjust"]["material"]["finish"] == "gloss"

    # a plain-colour gusset and a keyline change: reruns from link_panels
    r = c.post(f"/api/jobs/{job_id}/adjust", json={"adjust": {**adjust, "panels": {"gusset": {"source": "plain", "color": "#336699"}},
                                                             "keyline": {"zipper_offset_from_top_mm": 30}}}, headers=H)
    assert r.status_code == 200, r.text
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "DONE", (d["job"], d.get("review"))
    assert d["outputs"]["texture"]["textures"]["gusset"]["color"] == "#336699"
    assert d["outputs"]["build_geometry"]["geometry"]["zipper"]["y_from_top_mm"] == 30

    # operators cannot save item defaults; an admin can, and a new upload of the item starts from them
    r = c.post(f"/api/jobs/{job_id}/adjust", json={"adjust": adjust, "save_item_default": True}, headers=H)
    assert r.status_code == 403
    c.post("/api/auth/logout")
    c.post("/api/auth/login", json={"email": "admin@example.com", "password": "admin-password-1"}).raise_for_status()
    r = c.post(f"/api/jobs/{job_id}/adjust", json={"adjust": {"scene": {"lighting": "daylight"}}, "save_item_default": True, "note": "client wants daylight"}, headers=H)
    assert r.status_code == 200, r.text
    item = c.get("/api/index/item_override/fgpo7535").json()
    assert item["data"]["adjustments"]["scene"]["lighting"] == "daylight" and item["version"] == 1
    job2 = _upload(c, COMBINED)["jobs"][0]
    d2 = c.get(f"/api/jobs/{job2}").json()
    assert d2["job"]["status"] == "DONE" and d2["outputs"]["build_geometry"]["geometry"]["preset"]["lighting"] == "daylight"

    # reset: back to the automatic result for this job (the item default still applies)
    r = c.post(f"/api/jobs/{job_id}/adjust", json={"reset": True}, headers=H)
    assert r.status_code == 200
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "DONE" and d["inputs"].get("adjust") is None
    assert d["outputs"]["build_geometry"]["geometry"]["preset"]["lighting"] == "daylight"
    assert d["outputs"]["texture"]["textures"]["gusset"]["source"] == "sheet"


@needs_poppler
@needs_tesseract
def test_job_page_artwork_editing(app_client, monkeypatch):
    """Editing after the mockup (Pacdora-style): a picture replaces a panel's artwork (fitted), text
    and logos are baked into the front, a PDF that is no dieline panel is fitted like a picture, the
    front itself can be replaced, and the scene tells the page which uploads are in use."""
    monkeypatch.setattr(headless, "render", fake_render)
    c = app_client
    job_id = _upload(c, COMBINED)["jobs"][0]
    assert c.get(f"/api/jobs/{job_id}").json()["job"]["status"] == "DONE"
    before = c.get(f"/api/jobs/{job_id}").json()["outputs"]["texture"]["textures"]
    front_before = Image.open(io.BytesIO(c.storage.get_bytes(before["front"]["finished_key"])))

    def png(colour, w=300, h=200):
        buf = io.BytesIO()
        Image.new("RGB", (w, h), colour).save(buf, format="PNG")
        return buf.getvalue()

    # uploads are registered without running anything
    r = c.post(f"/api/jobs/{job_id}/artwork", files={"file": ("back art.png", png("#ff0000"), "image/png")}, headers=H)
    assert r.status_code == 200, r.text
    red = r.json()
    assert (red["kind"], red["width_px"], red["height_px"]) == ("image", 300, 200)
    logo = c.post(f"/api/jobs/{job_id}/artwork", files={"file": ("logo.png", png("#0000ff", 80, 40), "image/png")}, headers=H).json()
    prev = c.get(red["preview_url"])
    assert prev.status_code == 200 and prev.headers["content-type"].startswith("image/")
    assert c.post(f"/api/jobs/{job_id}/artwork", files={"file": ("notes.txt", b"hello", "text/plain")}, headers=H).status_code == 422
    assert c.get(f"/api/jobs/{job_id}").json()["job"]["status"] == "DONE"

    fw, fh = before["front"]["width_mm"], before["front"]["height_mm"]
    tx, ty, lx, ly = fw / 2, fh / 2, fw / 4, fh * 0.75
    adjust = {"panels": {
        "back": {"source": "file", "file_id": red["file_id"], "fit": "cover"},
        "front": {"brightness": 20, "overlays": [
            {"id": "t1", "kind": "text", "text": "SAMPLE", "x_mm": tx, "y_mm": ty, "size_mm": 12, "color": "#00ff00", "bold": True},
            {"id": "l1", "kind": "image", "file_id": logo["file_id"], "x_mm": lx, "y_mm": ly, "width_mm": 20},
        ]},
    }}
    r = c.post(f"/api/jobs/{job_id}/adjust", json={"adjust": adjust}, headers=H)
    assert r.status_code == 200, r.text
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "DONE", (d["job"], d.get("review"))
    tex = d["outputs"]["texture"]["textures"]
    back, front = tex["back"], tex["front"]
    assert back["source"] == "image" and (back["width_mm"], back["height_mm"]) == (before["back"]["width_mm"], before["back"]["height_mm"])
    w_px, h_px = back["px"]
    assert abs(w_px / h_px - back["width_mm"] / back["height_mm"]) < 0.01  # the panel's proportions, not the picture's
    back_img = Image.open(io.BytesIO(c.storage.get_bytes(back["finished_key"])))
    assert back_img.getpixel((w_px // 2, h_px // 2)) == (255, 0, 0)
    front_img = Image.open(io.BytesIO(c.storage.get_bytes(front["finished_key"])))
    assert front_img.size == front_before.size
    ppm = front_img.width / front["width_mm"]
    assert front_img.getpixel((round(lx * ppm), round(ly * ppm))) == (0, 0, 255)  # the logo, centred where it was placed
    greens = sum(1 for x in range(round((tx - 30) * ppm), round((tx + 30) * ppm), 3) for y in range(round((ty - 10) * ppm), round((ty + 10) * ppm), 3)
                 if front_img.getpixel((x, y)) == (0, 255, 0))
    assert greens > 20  # the text
    p0 = front_before.getpixel((5, 5))
    assert front_img.getpixel((5, 5)) != p0 or p0 == (255, 255, 255)  # brightened (white stays white)
    scene = c.get(f"/api/jobs/{job_id}/scene").json()
    assert set(scene["files"]) == {str(red["file_id"]), str(logo["file_id"])} and scene["files"][str(red["file_id"])]["kind"] == "image"
    assert scene["adjust"]["panels"]["front"]["overlays"][0]["text"] == "SAMPLE"
    events = [e["message"] for e in d["events"]]
    assert any("fitted 'cover'" in m for m in events) and any(m.startswith("front: baked 2 overlay(s), colour correction") for m in events)
    assert d["steps"][[s["step"] for s in d["steps"]].index("resolve_keyline")]["attempt"] == 1  # reran from link_panels only

    # a PDF that is no dieline panel of the gusset's size is fitted like a picture (with a warning), and
    # the front itself can be replaced by a picture
    pdf = c.post(f"/api/jobs/{job_id}/artwork", files={"file": ("other.pdf", SAMPLE.read_bytes(), "application/pdf")}, headers=H).json()
    assert pdf["kind"] == "pdf"
    r = c.post(f"/api/jobs/{job_id}/adjust", json={"adjust": {"panels": {
        "gusset": {"source": "file", "file_id": pdf["file_id"], "fit": "contain", "background": "#112233"},
        "front": {"source": "file", "file_id": red["file_id"], "fit": "stretch"},
    }}}, headers=H)
    assert r.status_code == 200, r.text
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "DONE", (d["job"], d.get("review"))
    tex = d["outputs"]["texture"]["textures"]
    assert tex["gusset"]["source"] == "image" and tex["front"]["source"] == "image" and tex["back"]["source"] == "sheet"
    assert any("is not a dieline panel of this size" in e["message"] for e in d["events"])
    gusset_img = Image.open(io.BytesIO(c.storage.get_bytes(tex["gusset"]["finished_key"])))
    assert gusset_img.getpixel((2, 2)) == (0x11, 0x22, 0x33)  # the background shows around the contained page
    front_img = Image.open(io.BytesIO(c.storage.get_bytes(tex["front"]["finished_key"])))
    assert front_img.getpixel((3, 3)) == (255, 0, 0) and front_img.size == front_before.size

    # back to the automatic result
    assert c.post(f"/api/jobs/{job_id}/adjust", json={"reset": True}, headers=H).status_code == 200
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "DONE" and {r: t["source"] for r, t in d["outputs"]["texture"]["textures"].items()} == {r: t["source"] for r, t in before.items()}


def test_render_token():
    t = tokens.make(5, ttl_s=60)
    assert tokens.check(t, 5) and not tokens.check(t, 6) and not tokens.check(t + "x", 5) and not tokens.check(None, 5)
    assert not tokens.check(tokens.make(5, ttl_s=-1), 5)


def test_scene_requires_session_or_token(app_client, engine):
    c = TestClient(main.app)  # no session
    assert c.get("/api/jobs/1/scene").status_code == 401
    assert c.get(f"/api/jobs/1/file?key=jobs/2/x.png&token={tokens.make(1)}").status_code == 403


def test_upload_rejects_non_pdf(app_client):
    r = app_client.post("/api/uploads", files={"files": ("notes.txt", b"hello", "text/plain")}, headers=H)
    assert r.status_code == 422


def test_zip_upload_groups_by_front(app_client, monkeypatch):
    runs = []
    monkeypatch.setattr(queue, "enqueue", lambda job_id, from_step=None, from_node=None: runs.append((job_id, from_step)))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("batch/FGPO7215_Dog_Food_Front_App.pdf", SAMPLE.read_bytes())
        z.writestr("batch/FGPO7216_Dog_Food_Back_App.pdf", SAMPLE.read_bytes())
        z.writestr("__MACOSX/._junk.pdf", b"x")
    r = app_client.post("/api/uploads", files={"files": ("job.zip", buf.getvalue(), "application/zip")}, headers=H).json()
    assert len(r["files"]) == 2 and len(r["jobs"]) == 1  # only the front becomes a job
    assert {f["item_code"] for f in r["files"]} == {"FGPO7215", "FGPO7216"}


@pytest.mark.skipif(not DIST.exists(), reason="frontend not built (npm run build)")
@needs_poppler
@needs_tesseract
def test_real_render_dimensions(app_client, monkeypatch, tmp_path):
    """Full headless render: the built 3D model must measure exactly the keyline size."""
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "frontend_dist", str(DIST.parent))
    headless.local_base_url.cache_clear()
    c = app_client
    job_id = _upload(c)["jobs"][0]
    c.post(f"/api/jobs/{job_id}/review", json={"action": "panels", "panel_choices": {
        "back": {"substitute": "front"}, "gusset": {"substitute": "plain", "color": "#29224b"}}}, headers=H)
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "DONE", d["steps"]
    m = d["outputs"]["render"]["model_mm"]
    assert m["flat"]["x"] == pytest.approx(240, abs=0.01) and m["flat"]["y"] == pytest.approx(312, abs=0.01)
    assert m["filled"]["y"] == pytest.approx(312, abs=0.5)  # height kept when filled
    assert m["filled"]["x"] == pytest.approx(240, abs=0.01)  # the top seal keeps the full width
    assert 40 < m["filled"]["z"] < 120  # a filled doypack, not a flat sheet
    for key in d["outputs"]["render"]["views"].values():
        img = Image.open(io.BytesIO(app_client.storage.get_bytes(key)))  # type: ignore[attr-defined]
        assert img.size == (2000, 2000)
    assert d["outputs"]["render"]["glb_key"]
    headless.local_base_url.cache_clear()


@pytest.mark.skipif(not DIST.exists(), reason="frontend not built (npm run build)")
@needs_poppler
@needs_tesseract
def test_real_render_exact_colours(app_client, monkeypatch):
    """Exact print colours: a plain #3c78b4 back panel renders as (60, 120, 180) everywhere it shows,
    and the artwork's own colours come through the WebGL path unchanged."""
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "frontend_dist", str(DIST.parent))
    headless.local_base_url.cache_clear()
    c = app_client
    job_id = _upload(c)["jobs"][0]
    c.post(f"/api/jobs/{job_id}/review", json={"action": "panels", "panel_choices": {
        "back": {"substitute": "plain", "color": "#3c78b4"}, "gusset": {"substitute": "plain", "color": "#29224b"}}}, headers=H)
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "DONE", d["steps"]
    assert d["outputs"]["build_geometry"]["geometry"]["preset"]["lighting"] == "exact"
    storage = c.storage  # type: ignore[attr-defined]
    back = Image.open(io.BytesIO(storage.get_bytes(d["outputs"]["render"]["views"]["back"]))).convert("RGB")
    w, h = back.size
    samples = [back.getpixel((w // 2 + dx, h // 2 + dy)) for dx in (-200, 0, 200) for dy in (-300, 0, 300)]
    assert all(max(abs(a - b) for a, b in zip(px, (60, 120, 180))) <= 1 for px in samples), samples
    # the front: the artwork's dominant colour (FGPO7215's navy) is the pouch's dominant colour
    from collections import Counter

    def dominant(img: Image.Image) -> tuple[int, int, int]:
        small = img.copy()
        small.thumbnail((400, 400))
        counts = Counter(px for px in small.getdata() if max(px) < 245)  # not the paper / studio white
        return counts.most_common(1)[0][0]

    tex = Image.open(io.BytesIO(storage.get_bytes(d["outputs"]["texture"]["textures"]["front"]["web_key"]))).convert("RGB")
    front = Image.open(io.BytesIO(storage.get_bytes(d["outputs"]["render"]["views"]["front"]))).convert("RGB")
    navy, got = dominant(tex), dominant(front)
    assert max(abs(a - b) for a, b in zip(navy, got)) <= 2, (navy, got)
    headless.local_base_url.cache_clear()


@pytest.mark.skipif(not DIST.exists(), reason="frontend not built (npm run build)")
@needs_poppler
@needs_tesseract
def test_real_render_combined_sheet_dimensions(app_client, monkeypatch):
    """FGPO7535 uploaded alone: the rendered 3D pouch measures the spec table's 120.65 x 210 mm."""
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "frontend_dist", str(DIST.parent))
    headless.local_base_url.cache_clear()
    c = app_client
    job_id = _upload(c, COMBINED)["jobs"][0]
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "DONE", (d["job"], d.get("review"))
    m = d["outputs"]["render"]["model_mm"]
    assert m["flat"]["x"] == pytest.approx(120.65, abs=0.01) and m["flat"]["y"] == pytest.approx(210, abs=0.01)
    assert m["filled"]["x"] == pytest.approx(120.65, abs=0.01) and m["filled"]["y"] == pytest.approx(210, abs=0.5)
    assert 25 < m["filled"]["z"] < 80  # a filled doypack on its 40 mm deep gusset
    headless.local_base_url.cache_clear()


@pytest.mark.parametrize("name, root", [
    ("FGPO7215_Dog_Food_Front_App.pdf", True), ("FGPO7216_Dog_Food_Back_App.pdf", False),
    ("FGPO6059_Nagin Indian Hot Sauce_APP_.pdf", True),  # the whole pouch on one sheet
    ("FGPO7025_California Pistachios 1kg_Friont&Back_App_refine_ (1).pdf", True),  # typo, still a front
    ("FGPO7026_California Pistachios 1kg_Side Gusset_App_.pdf", False), ("FGPO7028_CASHEW 1kg_Side GussetApp_.pdf", False), ("FGPO7024-Almonds 1kg Final-Gusset-app_.pdf", False),
    ("FGPO6164_Honest-Cashews-250g_Standup-pouch_Front&gusset_.pdf", True), ("FGPO6165_Honest-Cashews-250g_Standup-pouch-Back_.pdf", False),
    ("FGPO7150 Almond House Khara Andhra Style Chekkalu_Large_F+B_App_.pdf", True), ("FGPO6367-Cashew Jumbo 500gm Fornt-app.pdf", True),
    ("FGPO6828-TAMAQ PISTACHIOS 1KG CC-appp.pdf", True), ("FGPO5835 Hand Wash 1L_Back_App (exported).pdf", False),
    ("Backpack Snacks_App.pdf", True),  # "back" only as a whole word
])
def test_job_roots(name, root):
    from app.api.job_routes import is_job_root
    assert is_job_root(name) is root


def test_jobs_list_filters_by_pouch_style(app_client, monkeypatch):
    monkeypatch.setattr(queue, "enqueue", lambda *a, **k: None)
    job_id = app_client.post("/api/uploads", files={"files": ("FGPO7215_Dog_Food_Front_App.pdf", SAMPLE.read_bytes(), "application/pdf")}, headers=H).json()["jobs"][0]
    r = app_client.get("/api/jobs?pouch_type=none").json()
    assert [j["id"] for j in r["jobs"]] == [job_id] and r["types"] == {"none": 1}
    assert app_client.get("/api/jobs?pouch_type=quad_seal").json()["total"] == 0


def test_ngrok_address_reaches_share_pages_only(app_client):
    from app.render import tokens
    c, out = app_client, {"Host": "abc.ngrok-free.app", **H}
    assert c.get("/api/jobs", headers=H).status_code == 200  # this PC: everything
    for path in ("/api/jobs", "/api/auth/session", "/api/jobs/1/share-token", "/api/jobs/1", "/api/jobs/1?token=forged.1.x"):
        assert c.get(path, headers=out).json() == {"detail": "Not found"}, path
    assert c.post("/api/auth/login", json={"email": "admin@example.com", "password": "x"}, headers=out).status_code == 404
    ok = f"/api/jobs/999/scene?token={tokens.make(999, ttl_s=60)}"  # a real share token passes to the route
    assert c.get(ok, headers=out).json() == c.get(ok, headers=H).json() != {"detail": "Not found"}
