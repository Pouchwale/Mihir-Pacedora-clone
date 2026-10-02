"""Artwork + separation preview drawn side by side (FGPO6784-6787), and the spout corner diagonal."""

from types import SimpleNamespace

import numpy as np
import pymupdf
from PIL import Image

from app.pdf import safety, sheet
from app.pdf.layers import PT_TO_MM, Box
from app.pdf.vector import corner_cut


def test_copy_by_lines_takes_the_first_copy(monkeypatch):
    # FGPO6787: bleed / cut / seal lines of the artwork copy, two dimension lines, then the preview copy
    xs = [0.0, 0.9, 10.9, 150.9, 160.9, 161.9, 181.0, 190.9, 191.9, 201.9, 341.9, 351.9, 352.9]
    monkeypatch.setattr(sheet, "dieline", lambda *a, **k: SimpleNamespace(x_mm=xs))
    home = Box(0, 0, 352.9 / PT_TO_MM, 297 / PT_TO_MM)
    copy = sheet._copy_by_lines(home, [], None)
    assert round(copy.width_mm, 1) == 161.9 and copy.x0 == 0 and copy.height_mm == home.height_mm
    # a closed cut-to-cut cell inside the copy narrows it to the cut lines (FGPO6784)
    cell = SimpleNamespace(box=Box(1 / PT_TO_MM, 0, 161 / PT_TO_MM, 100 / PT_TO_MM))
    assert round(sheet._copy_by_lines(home, [cell], None).width_mm, 1) == 160.0


def test_copy_by_lines_leaves_one_web_alone(monkeypatch):
    # gusset | face | gusset | face: the panels touch, there is no gap between "copies"
    monkeypatch.setattr(sheet, "dieline", lambda *a, **k: SimpleNamespace(x_mm=[0.0, 40.0, 200.0, 240.0, 400.0]))
    assert sheet._copy_by_lines(Box(0, 0, 400 / PT_TO_MM, 300 / PT_TO_MM), [], None) is None


def test_corner_cut(tmp_path):
    for name, (a, b), want in (("l", ((20, 160), (160, 20)), "left"), ("r", ((300, 20), (440, 160)), "right")):
        doc = pymupdf.open()
        page = doc.new_page(width=500, height=800)
        page.draw_line(a, b)
        page.draw_line((20, 20), (20, 700))  # a cut edge is not a corner cut
        path = tmp_path / f"{name}.pdf"
        doc.save(path)
        doc.close()
        assert corner_cut(path, None) == want


def test_mask_out_wide_mark_is_not_black():
    image = Image.new("RGB", (200, 200), (200, 80, 40))
    mask = np.zeros((200, 200), bool)
    mask[90:106, 20:180] = True  # a 16 px band: wider than the first blur reaches
    out = np.asarray(safety.mask_out(image, mask, radius=4))
    assert out[98, 100].min() > 30 and abs(int(out[98, 100, 0]) - 200) < 12


def test_is_preview_only_for_a_grey_copy(tmp_path):
    """Beside the artwork: a flat grey block is its separation preview; artwork or a blank dieline is not."""
    doc = pymupdf.open()
    page = doc.new_page(width=900, height=400)
    page.draw_rect(pymupdf.Rect(20, 20, 280, 380), color=None, fill=(0.8, 0.8, 0.8))  # Sp White preview
    page.draw_rect(pymupdf.Rect(320, 20, 580, 380), color=None, fill=(0.9, 0.4, 0.1))  # artwork
    page.draw_rect(pymupdf.Rect(620, 20, 880, 380), color=(0.2, 0.4, 0.7), width=0.5)  # blank dieline
    path = tmp_path / "copies.pdf"
    doc.save(path)
    doc.close()
    grey, art, blank = (Box(x, 0, x + 300, 400) for x in (0, 300, 600))
    assert sheet._is_preview(path, grey)
    assert not sheet._is_preview(path, art)
    assert not sheet._is_preview(path, blank)
