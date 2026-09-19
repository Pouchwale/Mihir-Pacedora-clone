"""One test group per stage. PDF tests need the sample sheet: set SAMPLE_PDF or keep it in Downloads."""
import glob
import os

import numpy as np
import pytest

from pouchpdf.indexer import Index, item_no_from_name, panels_from_name
from pouchpdf.ocr import OcrBox
from pouchpdf.specs import parse_boxes, validate


def _sample():
    p = os.environ.get("SAMPLE_PDF")
    if p and os.path.exists(p):
        return p
    hits = glob.glob(os.path.join(os.path.expanduser("~"), "Downloads", "FGPO7215_Dog_Food_Front_App*.pdf"))
    return hits[0] if hits else None


SAMPLE = _sample()
needs_sample = pytest.mark.skipif(not SAMPLE, reason="sample approval PDF not available")


# ---------------------------------------------------------------- stage 1: indexing
def test_item_number_and_panels_from_filename():
    assert item_no_from_name("FGPO7215_Dog_Food_Front_App.pdf") == "FGPO7215"
    assert item_no_from_name("fgpo6367-Cashew Fornt-app (1).pdf") == "FGPO6367"
    assert item_no_from_name("random.pdf") is None
    assert panels_from_name("FGPO7215_Dog_Food_Front_App.pdf") == ["front"]
    assert panels_from_name("FGPO6367-Cashew Fornt-app.pdf") == ["front"]  # common typo
    assert panels_from_name("FGPO7313_Papad_Front&Gusset_App.pdf") == ["front", "gusset"]
    assert panels_from_name("FGPO7216_Dog_Food_Back_App.pdf") == ["back"]


def test_index_add_update_remove(tmp_path):
    folder = tmp_path / "pdfs"
    folder.mkdir()
    a = folder / "FGPO1001_X_Front_App.pdf"
    a.write_bytes(b"%PDF-1.4 a")
    (folder / "notes.pdf").write_bytes(b"%PDF-1.4 n")
    idx = Index(str(tmp_path / "i.sqlite"))
    r = idx.scan(str(folder))
    assert [os.path.basename(p) for p in r.added] == [a.name] and len(r.skipped) == 1
    assert idx.scan(str(folder)).added == []  # unchanged -> nothing to do
    idx.store_specs(str(a), {"client_name": "C", "back_code": "FGPO1002"})
    assert idx.cached_specs(str(a))["back_code"] == "FGPO1002"
    a.write_bytes(b"%PDF-1.4 changed content")
    assert len(idx.scan(str(folder)).updated) == 1
    assert idx.cached_specs(str(a)) is None  # a changed file must be read again
    assert idx.lookup("fgpo1001", "front")[0]["path"] == str(a)
    assert idx.lookup("FGPO1001", "back") == []
    a.unlink()
    assert len(idx.scan(str(folder)).removed) == 1


# ---------------------------------------------------------------- stage 2: spec parsing (no PDF)
def _row(y, *cells):
    return [OcrBox(t, c, x, y, x + 12 * len(t), y + 40) for (t, x, c) in cells]


def test_parse_boxes_pairs_labels_with_values():
    boxes = (
        _row(100, ("Pouch height:", 200, 1.0), ("312 mm", 850, 0.93), ("Layer 1", 1600, 0.99), ("18 mic MATT BOPP", 2180, 0.95))
        + _row(180, ("Pouch Closed width:", 200, 1.0), ("240 mm", 850, 0.99))
        + _row(260, ("Gusset", 200, 1.0), ("Bottom", 850, 1.0), ("Gusset Full Width:", 1600, 0.99), ("120 mm", 2180, 1.0))
        + _row(340, ("Zipper?", 200, 1.0), ("Yes", 850, 1.0), ("Tear Notch", 1600, 1.0), ("(V Notch)", 2180, 1.0))
        + _row(420, ("Remarks", 200, 1.0), ("Matt Finish PouchI Back Code :FGPO7216", 850, 0.94))
        + _row(480, ("GussetCode:FGPO7233", 850, 0.98))
    )
    out = parse_boxes(boxes)
    f = out["fields"]
    assert f["pouch_height_mm"] == 312 and f["pouch_closed_width_mm"] == 240
    assert f["gusset_type"] == "Bottom" and f["gusset_full_width_mm"] == 120
    assert f["zipper"] is True and f["tear_notch"] == "V Notch"
    assert f["back_code"] == "FGPO7216" and f["gusset_code"] == "FGPO7233" and f["finish"] == "matt"
    assert f["layers"] == ["18 mic MATT BOPP"]
    assert f["sealing_width_mm"] is None and any("sealing_width_mm" in i for i in out["issues"])  # never guessed


def test_low_confidence_and_empty_cells_are_flagged():
    boxes = _row(100, ("Pouch height:", 200, 1.0), ("3l2 mm", 850, 0.5)) + _row(180, ("Zipper?", 200, 1.0), ("Round Corner", 850, 1.0))
    out = parse_boxes(boxes)
    assert out["fields"]["pouch_height_mm"] is None
    assert out["fields"]["zipper"] is None  # the next cell is another label, not a value
    assert any("pouch_height_mm" in i for i in out["issues"])


def test_validation_ranges_and_trimbox():
    ok = {"pouch_height_mm": 312, "pouch_closed_width_mm": 240, "sealing_width_mm": 10, "gusset_type": "Bottom", "gusset_full_width_mm": 120}
    assert validate(ok, 244.475, 320.0) == []
    assert any("TrimBox height" in p for p in validate(ok, 244.475, 300.0))
    assert any("sane range" in p for p in validate({**ok, "pouch_height_mm": 5}, 244.475, 320))
    assert any("no artwork TrimBox" in p for p in validate(ok, 695, 440, real_trimbox=False))


# ---------------------------------------------------------------- stages 2 + 3 on the real sheet
@needs_sample
def test_sample_specs_match_expected_values():
    from pouchpdf.specs import extract_specs

    s = extract_specs(SAMPLE)
    assert (s["pouch_height_mm"], s["pouch_closed_width_mm"], s["pouch_open_width_mm"]) == (312, 240, 240)
    assert s["sealing_type"].lower() == "stand-up" and s["gusset_type"].lower() == "bottom"
    assert s["gusset_full_width_mm"] == 120 and s["sealing_width_mm"] == 10
    assert s["zipper"] is True and s["round_corner"] is True and s["butterfly_notch"] is False and s["transparent_window"] is False
    assert "v" in s["tear_notch"].lower() and s["finish"] == "matt"
    assert s["back_code"] == "FGPO7216" and s["gusset_code"] == "FGPO7233"
    assert s["client_name"] == "Crystal Enterprises" and s["item_no"] == "FGPO7215"
    assert len(s["layers"]) == 3 and "Met" in s["layers"][1]
    assert s["trimbox_mm"] == [244.475, 320.0]
    assert s["needs_review"] is False, s["issues"]


@needs_sample
def test_sample_artwork_is_clean_and_pouch_sized(tmp_path):
    import cv2
    from pouchpdf.artwork import extract_artwork

    res = extract_artwork(SAMPLE, str(tmp_path), 240, 312)
    assert res.method == "layers" and "Dimensions and text" in res.layers_off
    assert res.bleed_mm == (2.2375, 4.0)
    assert abs(res.texture_mm[0] - 240) < 0.2 and abs(res.texture_mm[1] - 312) < 0.2
    img = cv2.imread(res.texture_png)
    assert abs(img.shape[1] - 240 / 25.4 * 300) <= 2 and abs(img.shape[0] - 312 / 25.4 * 300) <= 2
    # The zipper marking / guide lines were light blue-white lines on the dark navy background at
    # the top: that band must now be uniform navy.
    full = cv2.imread(res.full_png)
    band = full[int(full.shape[0] * 0.04): int(full.shape[0] * 0.075), int(full.shape[1] * 0.35): int(full.shape[1] * 0.95)]
    spread = band.reshape(-1, 3).std(axis=0).max()  # per channel: the band is one flat colour
    assert spread < 3, f"technical marks still visible (channel std {spread:.1f})"
