"""Dielines that are no closed grid: networks of crossing lines, copies found by their period."""

from pathlib import Path

import pymupdf
import pytest

from app.pdf.layers import PT_TO_MM
from app.pdf.vector import line_networks, same_size, typical_network

M = 72 / 25.4  # mm -> pt


def _lines(path: Path, page_mm: tuple[float, float], lines: list[tuple[float, float, float, float]]) -> Path:
    doc = pymupdf.open()
    page = doc.new_page(width=page_mm[0] * M, height=page_mm[1] * M)
    for x0, y0, x1, y1 in lines:
        page.draw_line((x0 * M, y0 * M), (x1 * M, y1 * M), color=(0, 0, 1), width=0.3)
    doc.save(path)
    doc.close()
    return path


def _web(x: float, top: float = 30.0, w: float = 100.0, face: float = 150.0, band: float = 6.0, seal: float = 10.0):
    """One up of a front + back web (like FGPO7165): the edge lines broken at every band line, the
    seal lines whole, the band between the faces closed."""
    ys = [top, top + seal, top + face, top + face + band, top + 2 * face + band - seal, top + 2 * face + band]
    out = [(x, y, x + w, y) for y in ys]  # horizontals
    for edge in (x, x + w):  # edge pieces between the horizontals
        out += [(edge, a, edge, b) for a, b in zip(ys, ys[1:])]
    out += [(x + seal, ys[0], x + seal, ys[-1]), (x + w - seal, ys[0], x + w - seal, ys[-1])]  # seal lines, whole
    return out


def test_imposition_splits_into_its_copies_and_the_first_copy_is_typical(tmp_path):
    """Two copies of three ups side by side, a frame joined to the first up, a sheet-wide bottom line
    through both copies and a dimension line over each copy: no closed grid spans a web (the edges are
    pieces), but the crossings repeat every 360 mm across a 54 mm gap. The ups touch (3 mm apart) and
    stay together: the sheet layout takes the first up of the copy."""
    lines = []
    for cx in (20.0, 380.0):
        for k in range(3):
            lines += _web(cx + k * 103)
        lines += [(cx, 20, cx + 306, 20), (cx, 20, cx, 30), (cx + 306, 20, cx + 306, 30)]  # dimension "306" and its extension lines
    lines += [(18, 26, 18, 340), (18, 180, 30, 180)]  # a frame line at the left, joined to the first up's band line
    lines += [(15, 340, 690, 340), (15, 26, 690, 26)]  # sheet-wide lines through both copies
    pdf = _lines(tmp_path / "imposition.pdf", (700, 400), lines)
    nets = line_networks(pdf)
    typical = typical_network(nets)
    assert typical is not None
    copies = [n for n in nets if same_size(n.box, typical.box)]
    assert len(copies) == 2 and len(nets) == 2
    assert typical.box.x0 * PT_TO_MM == pytest.approx(18, abs=0.5)  # copy 1 (with its frame line)
    assert typical.box.width_mm == pytest.approx(308, abs=0.5) and 306 <= typical.box.height_mm <= 320.5  # three ups, 100 + 3 + 100 + 3 + 100, plus the frame
    assert nets[0] is typical
    from app.geometry.sheet_layout import detect
    xs = [x - 18 for up in (20, 123, 226) for x in (up, up + 10, up + 90, up + 100)]
    lay = detect(308, 306, xs, [0, 10, 150, 156, 296, 306], 100, 150, None)
    assert lay.kind == "multi" and lay.ups == 3 and [(p.x_mm, p.width_mm, p.rotation) for p in lay.panels] == [(2, 100, 0), (2, 100, 180)]


def test_euro_flow_web_comes_from_the_line_network(tmp_path):
    """FGPO7442 (PDFium re-save, 178 x 203 three-side-seal front + back web, drawn twice): its outer
    lines overshoot the corners, so the only closed grids are cells (178 x 173 faces, a 48 mm fold
    band). The dieline is the first copy of the crossing-line network, and the layout its two faces."""
    from app.geometry.sheet_layout import detect
    from app.pdf.profile import PdfProfile
    from app.pdf.sheet import analyse
    from app.pdf.vector import dieline
    from app.steps.extract_specs import vectors
    from tests.conftest import EURO_FLOW

    sheet = analyse(EURO_FLOW, PdfProfile())
    assert sheet.mode == "separation" and sheet.repeats == 2
    assert (sheet.trim.width_mm, sheet.trim.height_mm) == pytest.approx((207.5, 422.0), abs=0.5)  # the copy plus its dimension column
    assert any("network of crossing lines" in w and "177.75 x 48.00" in w for w in sheet.warnings)
    lines = dieline(vectors(EURO_FLOW, PdfProfile(), sheet, tmp_path).pdf, None, sheet.drawing_box(sheet.trim))
    assert lines.x_mm[:5] == pytest.approx([0, 1.49, 11.49, 169.46, 179.49], abs=0.02)  # frame, edge, seal, seal, edge
    layout = detect(sheet.trim.width_mm, sheet.trim.height_mm, lines.x_mm, lines.y_mm, 178, 203, None, open_width=406)
    assert layout.kind == "multi" and layout.axis == "vertical" and layout.ups == 1
    assert [(p.kind, p.rotation, p.width_mm, p.height_mm) for p in layout.panels] == [("face", 0, 178.0, 203.0), ("face", 180, 178.0, 203.0)]
    assert [(p.x_mm, p.y_mm) for p in layout.panels] == pytest.approx([(1.49, 3.97), (1.49, 214.97)], abs=0.02)  # 203 mm face + 8 mm fold band


def test_trimbox_confirmed_by_the_dieline_wins(tmp_path):
    """FGPO3970: the sheet also carries a separate white-ink gusset drawing, and a dimension line joins
    it to the web, so the crossing-line network spans both (446 x 480 mm). The file's TrimBox is the
    web itself, 161.93 x 460 mm, with dieline lines on all four edges: that is the dieline. The zipper
    is a dashed line; it sits in the lower half of the top face, so that face is drawn upside down."""
    from app.geometry.sheet_layout import detect
    from app.pdf.profile import PdfProfile
    from app.pdf.sheet import analyse
    from app.pdf.vector import dieline
    from app.steps.extract_specs import _drawn_upside_down, vectors
    from tests.conftest import NAMKEEN

    sheet = analyse(NAMKEEN, PdfProfile())
    assert (sheet.trim.width_mm, sheet.trim.height_mm) == pytest.approx((161.92, 460.0), abs=0.05)
    assert any("TrimBox" in w for w in sheet.warnings)
    vec = vectors(NAMKEEN, PdfProfile(), sheet, tmp_path)
    lines = dieline(vec.pdf, None, sheet.trim)
    assert lines.x_mm == pytest.approx([0, 10, 151.93, 161.93], abs=0.05)
    assert lines.zipper_y_mm == pytest.approx([212.8], abs=0.2)  # the dashed zipper, drawn on the top face only
    layout = detect(sheet.trim.width_mm, sheet.trim.height_mm, lines.x_mm, lines.y_mm, 161.925, 230, 90, open_width=323.85)
    assert [(p.kind, p.height_mm) for p in layout.panels] == [("face", 230.01), ("face", 230.0)]
    assert _drawn_upside_down([10, 190.18, 19.82, 10], zipper_y=[212.8])


def test_a_single_web_is_not_split_by_its_seal_lines(tmp_path):
    """A front + back web drawn once: the distance between its seal lines is no period (the second
    'copy' would be 10 mm wide) and the front's lines shifted onto the back match too little."""
    lines = _web(50, top=40, w=150, face=225, band=13)
    lines += [(10, 520, 400, 520)]  # a sheet-wide line
    pdf = _lines(tmp_path / "web.pdf", (420, 560), lines)
    nets = line_networks(pdf)
    assert len(nets) == 1
    assert (nets[0].box.width_mm, nets[0].box.height_mm) == pytest.approx((150, 463), abs=0.5)
