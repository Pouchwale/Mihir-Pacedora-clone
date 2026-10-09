"""Shrink sleeves through Phase 4: an FGSL sheet becomes a sleeve on a container sized from it; pouch
files still take the pouch route; the job page changes the container and turns the sleeve."""

from pathlib import Path

import pytest

from app.render import headless
from app.services import sleeve
from tests.conftest import needs_poppler, needs_tesseract
from tests.test_workflow import H, app_client, fake_render  # noqa: F401 - fixture re-export

FIXTURES = Path(__file__).parent / "fixtures"
WONDER = FIXTURES / "FGSL3970_Wonder_Turmeric_Powder_400g_Sleeve_App.pdf"  # Illustrator page: 115.358 x 300 mm, lay-flat 148.5, powder
GOLI = FIXTURES / "FGSL4053_Goli_Soda_Jeera_200ml_Sleeve_App.pdf"  # Illustrator page: 82.55 x 187 mm, lay-flat 92, a soda bottle
needs_sleeves = pytest.mark.skipif(not (WONDER.exists() and GOLI.exists()), reason="sleeve fixtures are local only (customer files)")


def test_sleeve_sheet_text():
    text = "Size: 115.358 X 300 mm (Teeth* 109 / 3 UPS)\nCLOSE WIDTH : 148.5 mm\nFOLDING AREA\nFGSL3970"
    assert sleeve.is_sleeve("anything.pdf", text) and sleeve.is_sleeve("FGSL3970_x.pdf", "") and not sleeve.is_sleeve("FGPO7215_Front.pdf", "Pouch Form")
    f = sleeve.read(text)
    assert (f["pouch_height_mm"], f["pouch_open_width_mm"], f["sleeve_layflat_mm"], f["item_no"]) == ("115.358", "300", "148.5", "FGSL3970")
    assert sleeve.read("LAY-FLAT- 86.5 mm")["sleeve_layflat_mm"] == "86.5"
    assert sleeve.size_from_filename("FGSL4068_STRONG HING 50 g. SLEEVE_57.15 X 170 mm_App.pdf") == (57.15, 170.0)
    assert sleeve.layflat(300, None) == 148.5 and sleeve.layflat(300, 900) == 148.5  # no / nonsense lay-flat: printed width less a seam


def test_sheet_guides_are_taken_out_before_rendering(tmp_path):
    """FGSL4021: a fold line stroked across the sleeve and on past its edge, in one path with another
    mark, is taken out of the PDF; the print it crosses (a panel, text) stays."""
    import pymupdf

    from app.pdf.layers import Box

    src, out = tmp_path / "sheet.pdf", tmp_path / "clean.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=300)
    page.draw_rect(pymupdf.Rect(100, 100, 300, 200), color=None, fill=(0.85, 0.35, 0.1))  # the print
    page.insert_text((120, 150), "Lic. No. 10716020000024", fontsize=9)
    shape = page.new_shape()  # the fold line and a crop mark, stroked as one path
    shape.draw_line((180, 80), (180, 220))
    shape.draw_line((20, 20), (40, 20))
    shape.finish(color=(0.14, 0.12, 0.13), width=0.7)
    shape.commit()
    page.draw_rect(pymupdf.Rect(150, 101, 250, 199), color=(0.93, 0, 0.55), width=0.7)  # FGSL4042's magenta panel frame
    doc.save(src)
    box = Box(100, 100, 300, 200)  # y up: the page is 300 high, the panel 100..200 either way
    guides, frames = sleeve.guide_lines(src, box), sleeve.guide_frames(src, box)
    assert [(v, round(p)) for v, p, *_ in guides] == [(True, 180)] and len(frames) == 1
    sleeve.without_guides(src, guides, out, frames)
    assert sleeve.guide_lines(out, box) == [] and sleeve.guide_frames(out, box) == []
    with pymupdf.open(out) as clean:
        p = clean[0]
        assert "10716020000024" in p.get_text() and any(d.get("fill") for d in p.get_drawings())
        lines = [i for d in p.get_drawings() for i in d["items"] if i[0] == "l"]
        assert lines and all(i[1].y == i[2].y == 20 for i in lines)  # the crop mark stays (closed: there and back)


def _upload(c, path, **form):
    with open(path, "rb") as fh:
        r = c.post("/api/uploads", files={"files": (path.name, fh, "application/pdf")}, data={"workflow": "phase4", **form}, headers=H)
    assert r.status_code == 200, r.text
    return r.json()["jobs"][0]


@needs_poppler
@needs_tesseract
@needs_sleeves
def test_sleeve_goes_on_its_container_through_phase4(app_client, monkeypatch):
    monkeypatch.setattr(headless, "render", fake_render)
    c = app_client
    job_id = _upload(c, WONDER)
    d = c.get(f"/api/jobs/{job_id}").json()
    assert d["job"]["status"] == "DONE", [(i["field"], i["code"], i["message"]) for i in (d.get("review") or {}).get("details", {}).get("issues", [])]
    assert d["job"]["pouch_type"] == "shrink_sleeve" and d["job"]["item_code"] == "FGSL3970"
    path = [p["node"] for p in d["workflow"]["path"]]
    assert path[:4] == ["start", "prepare", "d_product", "set_sleeve"] and "d_form" not in path
    t = d["outputs"]["validate"]["sheet"]["spec_table"]
    assert t["pouch_or_roll_form"]["value"] == "Shrink Sleeve" and t["sleeve_layflat_mm"]["value"] == 148.5
    assert abs(t["pouch_open_width_mm"]["value"] - 300) < 4 and abs(t["pouch_height_mm"]["value"] - 115.4) < 4  # the drawn artwork
    g = d["outputs"]["build_geometry"]["geometry"]
    s = g["sleeve"]
    assert (s["container"], s["chosen_by"], round(s["diameter_mm"], 1), s["overlap_mm"]) == ("tin", "words", 94.5, round(t["pouch_open_width_mm"]["value"] - 297, 2))
    assert g["width_mm"] == s["diameter_mm"] and g["height_mm"] == s["container_height_mm"]
    assert set(d["outputs"]["texture"]["textures"]) == {"sleeve"}
    # nothing paints over a sleeve's print after rendering (pixel line removal smeared badges, tables and
    # QR codes): the finished texture is the rendered artwork, pixel for pixel
    from PIL import Image, ImageChops

    from app.api import job_routes

    st = job_routes.get_storage()  # (the fixture's storage)
    cut = d["outputs"]["link_panels"]["panels"]["sleeve"]["trim"]["bleed_key"]
    fin = d["outputs"]["texture"]["textures"]["sleeve"]["finished_key"]
    a, b = (Image.open(st.path(k)).convert("RGB") for k in (cut, fin))
    assert a.size == b.size and ImageChops.difference(a, b).getbbox() is None

    # the job page: another container, and the sleeve turned so another part of the print faces front
    r = c.post(f"/api/jobs/{job_id}/container", json={"container": "jar", "front_center_pct": 70}, headers=H)
    assert r.status_code == 200, r.text
    s = c.get(f"/api/jobs/{job_id}").json()["outputs"]["build_geometry"]["geometry"]["sleeve"]
    assert (s["container"], s["chosen_by"], s["front_center_pct"]) == ("jar", "job", 70)
    assert c.post(f"/api/jobs/{job_id}/container", json={"container": "nope"}, headers=H).status_code == 422
    # the team's look: top colour, material and where the sleeve sits (it keeps its height)
    style = {"cap_color": "#ff0000", "material": "clear", "sleeve_from": 0.1}
    assert c.post(f"/api/jobs/{job_id}/container", json={"container": "jar", "style": style}, headers=H).status_code == 200
    s = c.get(f"/api/jobs/{job_id}").json()["outputs"]["build_geometry"]["geometry"]["sleeve"]
    assert (s["cap_color"], s["material"], s["sleeve_from"]) == ("#ff0000", "clear", 0.1)
    assert abs((s["sleeve_to"] - s["sleeve_from"]) * s["container_height_mm"] - s["sleeve_height_mm"]) < 0.1
    assert c.post(f"/api/jobs/{job_id}/container", json={"style": {"cap_color": "red"}}, headers=H).status_code == 422

    # a soda bottle by its name; and "these are pouches" keeps a sheet on the pouch route
    s = c.get(f"/api/jobs/{_upload(c, GOLI)}").json()["outputs"]["build_geometry"]["geometry"]["sleeve"]
    assert s["container"] == "bottle" and s["container_height_mm"] >= 2.5 * s["diameter_mm"]
    pouch = c.get(f"/api/jobs/{_upload(c, GOLI, product='pouch')}").json()
    assert pouch["job"]["pouch_type"] != "shrink_sleeve"
    assert "d_form" in [p["node"] for p in pouch["workflow"]["path"]]
    chosen = c.get(f"/api/jobs/{_upload(c, GOLI, container='drink_can')}").json()["outputs"]["build_geometry"]["geometry"]["sleeve"]
    assert (chosen["container"], chosen["chosen_by"]) == ("drink_can", "job")
    assert c.post("/api/uploads", files={"files": (GOLI.name, GOLI.read_bytes(), "application/pdf")}, data={"container": "nope"}, headers=H).status_code == 422
