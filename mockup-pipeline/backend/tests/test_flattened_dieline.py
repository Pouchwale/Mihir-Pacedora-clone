"""A dieline flattened into raster tiles (FGPO6292), and the reads that go with it."""

import pymupdf
from PIL import Image, ImageDraw

from app.ocr.keyline import _label_for
from app.ocr.table import parse_value
from app.ocr.template import SpecTemplate
from app.pdf.layers import PT_TO_MM, Box
from app.pdf.vector import dieline


def test_lines_painted_by_an_image_are_read(tmp_path):
    w_mm, h_mm, dpi = 100, 200, 300
    px = lambda mm: round(mm * dpi / 25.4)  # noqa: E731
    tile = Image.new("L", (px(w_mm), px(h_mm)), 255)
    draw = ImageDraw.Draw(tile)
    for y in (4, 174, 177):  # bleed line, face end, gusset start
        draw.line([(0, px(y)), (tile.width, px(y))], fill=40, width=3)
    for y in (60.0, 60.6, 61.2):  # a zipper track's rows: not dieline lines
        draw.line([(0, px(y)), (tile.width, px(y))], fill=40, width=2)
    draw.rectangle([px(20), px(100), px(80), px(140)], fill=40)  # a solid area is artwork
    png = tmp_path / "tile.png"
    tile.save(png)
    doc = pymupdf.open()
    page = doc.new_page(width=w_mm / PT_TO_MM, height=h_mm / PT_TO_MM)
    page.insert_image(page.rect, filename=str(png))
    pdf = tmp_path / "flat.pdf"
    doc.save(pdf)
    doc.close()
    box = Box(0, 0, w_mm / PT_TO_MM, h_mm / PT_TO_MM)
    ys = dieline(pdf, None, box).y_mm
    assert len(ys) == 3 and all(abs(a - b) <= 0.2 for a, b in zip(sorted(ys), (4, 174, 177)))
    assert dieline(pdf, None, box, raster=False).y_mm == []


def test_layer_no_is_an_unused_layer():
    tpl = SpecTemplate()
    rule = next(r for r in tpl.fields if r.field == "layer_4")
    assert parse_value(rule, "No", tpl) == (None, True)


def test_label_tolerance():
    assert _label_for(10.08, [10.0, 91.13]) is None  # the strict default
    assert _label_for(10.08, [10.0, 91.13], 0.15) == 10.0


def test_keyline_coloured_sliver_is_not_a_stray_line():
    """The rule finish() applies: a stray keyline has a straight run; a curved sliver has none."""
    import numpy as np

    from app.steps.trim_artwork import KEYLINE_MIN_RUN_MM

    run = round(KEYLINE_MIN_RUN_MM * 11.8)  # 300 dpi
    line = np.zeros((200, 200), bool)
    line[50, 20:120] = True
    sliver = np.zeros((200, 200), bool)
    for i in range(100):  # 100 px long, sloping: two pixels per row or column at most
        sliver[40 + i // 2, 20 + i] = True
    straight = lambda m: max(m.sum(axis=0).max(), m.sum(axis=1).max()) >= run  # noqa: E731
    assert straight(line) and not straight(sliver)
