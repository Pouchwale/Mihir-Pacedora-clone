"""Panel edges, eyemarks, proof-note leaders and roll orientation (FGPO7838, FGPO0928)."""

import numpy as np
import pytest
import pymupdf
from PIL import Image

from app.pdf.layers import Box
from app.services import sleeve as sl
from app.workflow.steps import texture as tx
from app.workflow.steps.link_panels import roll_orientation

ORANGE = (238, 120, 38)
K = 10  # px per mm in these images


def _panel(w_mm=131, h_mm=190):
    return np.full((h_mm * K, w_mm * K, 3), ORANGE, np.uint8)


def test_dark_outline_on_the_cut_edges_is_taken_off():
    a = _panel()
    a[:, :3] = a[:, -3:] = 0  # FGPO7838: 0.25 mm of the pouch's black outline down both sides
    out, edged = tx.trim_edge_lines(Image.fromarray(a), 131)
    assert edged == 2 and np.asarray(out)[:, :3].max(axis=2).min() > 200 and np.asarray(out)[:, -3:].max(axis=2).min() > 200


def test_a_design_dark_at_its_edge_keeps_it():
    a = _panel()
    a[:, :40] = 0  # 4 mm of dark design reaching the edge: not an outline
    out, edged = tx.trim_edge_lines(Image.fromarray(a), 131)
    assert edged == 0 and np.asarray(out)[:, :3].max() == 0


def test_eyemark_joined_to_a_hairline_is_found_and_filled_with_the_seal_colour():
    a = _panel()
    a[-100:, -100:] = 0  # a 10 x 10 mm eyemark in the bottom-right corner...
    a[:, 1210:1213] = 0  # ...touching a 0.3 mm dark line the full height of the side seal
    out, marks = tx.drop_eyemarks(Image.fromarray(a), 131, 10, 10, 10)
    assert len(marks) == 1
    corner = np.asarray(out)[-50, -50]
    assert tuple(int(v) for v in corner) == ORANGE  # the seal band continued, not a blurred blend


def _sheet_with_leader(path, pieces=True):
    """A 100 x 100 mm print with a note outside it whose 0.2 mm leader runs 20 mm into the print, drawn
    as filled strips broken at the print's edge (FGPO7838), and a line of small lettering inside."""
    mm = 72 / 25.4
    doc = pymupdf.open()
    page = doc.new_page(width=200 * mm, height=150 * mm)
    page.draw_rect(pymupdf.Rect(10 * mm, 10 * mm, 110 * mm, 110 * mm), fill=(0.9, 0.3, 0.2), color=None)
    y = 60 * mm
    spans = [(90, 110), (110, 125), (125, 140)] if pieces else [(90, 140)]
    for x0, x1 in spans:
        page.draw_rect(pymupdf.Rect(x0 * mm, y, x1 * mm, y + 0.2 * mm), fill=(0.1, 0.1, 0.1), color=None)
    page.insert_text((142 * mm, y + 2 * mm), "Logo colour change into black", fontsize=8)
    page.insert_text((20 * mm, 30 * mm), "small lettering across the print, under 1.5 mm tall", fontsize=4)
    doc.save(path)
    with pymupdf.open(path) as d:
        inv = ~d[0].transformation_matrix
        r = (pymupdf.Rect(10 * mm, 10 * mm, 110 * mm, 110 * mm) * inv).normalize()
    return Box(r.x0, r.y0, r.x1, r.y1)


def test_leader_drawn_in_pieces_is_found_and_removed(tmp_path):
    box = _sheet_with_leader(tmp_path / "s.pdf")
    leaders = sl.callout_leaders(tmp_path / "s.pdf", box)
    assert len(leaders) == 1 and not leaders[0][0]  # one horizontal leader, the lettering is not one
    assert sl.has_callout_leaders(tmp_path / "s.pdf", box)
    clean = sl.without_guides(tmp_path / "s.pdf", [], tmp_path / "c.pdf", crossing=box)
    assert sl.callout_leaders(clean, box) == []
    with pymupdf.open(clean) as d:
        assert "small lettering" in d[0].get_text()  # (text untouched)


def test_roll_drawn_across_the_web_is_turned():
    # FGPO0928: four 90 mm sachets side by side (360 x 90 mm); table repeat 90.49, web 320: the 90 mm runs along the roll
    assert roll_orientation(360, 90, 90.49, 320) == (90, False)
    assert roll_orientation(248, 304, 248, 304) == (0, True)  # (an exact fit as drawn stays as it is)
    assert roll_orientation(304, 248, 248, 304) == (90, True)


def _plate_on_top(path, layer="White Underprint", ink="White-01"):
    """Artwork on "ART", then a sheet-size fill in the Separation White-01 on "White Underprint" drawn
    after it, previewed pink (FGPO7846)."""
    mm = 72 / 25.4
    doc = pymupdf.open()
    page = doc.new_page(width=120 * mm, height=120 * mm)
    art, white = doc.add_ocg("ART"), doc.add_ocg(layer)
    page.draw_rect(pymupdf.Rect(30 * mm, 30 * mm, 90 * mm, 90 * mm), fill=(0.1, 0.3, 0.8), color=None, oc=art)
    page.draw_rect(pymupdf.Rect(10 * mm, 10 * mm, 110 * mm, 110 * mm), fill=(0.97, 0.76, 0.85), color=None, oc=white)
    page.clean_contents()
    xref = page.get_contents()[0]
    body = doc.xref_stream(xref).replace(b".97 .76 .85 rg", b"/CSW cs 1 scn")
    doc.update_stream(xref, body)
    fn = doc.get_new_xref()
    doc.update_object(fn, "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0.24 0.03 0] /N 1 >>")
    res = page.xref and doc.xref_get_key(page.xref, "Resources")
    rx = int(res[1].split()[0]) if res[0] == "xref" else None
    target = rx or page.xref
    key = "ColorSpace" if rx else "Resources/ColorSpace"
    doc.xref_set_key(target, key, f"<< /CSW [/Separation /{ink} /DeviceCMYK {fn} 0 R] >>")
    doc.save(path)
    with pymupdf.open(path) as d:
        r = (pymupdf.Rect(10 * mm, 10 * mm, 110 * mm, 110 * mm) * ~d[0].transformation_matrix).normalize()
    return Box(r.x0, r.y0, r.x1, r.y1)


@pytest.mark.parametrize("layer,ink", [("White Underprint", "White-01"), ("Matt UV", "Matt uv")])
def test_a_plate_layer_drawn_over_the_artwork_is_left_out(tmp_path, layer, ink):
    # FGPO7846's white underprint and FGSL4101's matt varnish, each one sheet-size fill over the print
    from app.steps.trim_artwork import plate_only_layer

    box = _plate_on_top(tmp_path / "w.pdf", layer, ink)
    assert plate_only_layer(tmp_path / "w.pdf", layer, {ink}, box, tmp_path)
    assert not plate_only_layer(tmp_path / "w.pdf", "ART", {ink}, box, tmp_path)  # (the artwork stays)


def test_pouch_size_from_the_dieline_when_no_table_gives_it():
    from app.steps.extract_specs import size_from_dieline

    # FGPO7846: no spec table; 2 bleed + fin / back / front / back / fin + 2 across, two pouches (each with
    # its 1.4375 bleed) stacked: one centre-seal pillow 120 x 140, 260 open, not the 264 x 285.75 sheet
    xs = [0.0, 2.0, 12.0, 72.0, 192.0, 252.0, 262.0, 264.0]
    ys = [0.0, 1.4375, 11.4375, 131.4375, 141.4375, 142.875, 144.3125, 154.3125, 274.3125, 284.3125, 285.75]
    labels = [10, 60, 120, 60, 10, 2, 2, 264, 10, 120, 10, 1.4375, 285.75]  # as printed on its dimension layer
    assert size_from_dieline(xs, ys, labels) == (120.0, 260.0, 140.0, True)
    assert size_from_dieline(xs, ys, []) is None  # (no labels read: the size stays for a person)
    assert size_from_dieline([0, 3, 153, 156], [0, 3, 203, 206], [150, 200]) == (150.0, 150.0, 200.0, False)  # a plain panel


def test_a_small_printed_strip_is_cut_by_its_layout():
    from app.workflow.steps.link_panels import strip_topology

    # FGPO7838: face 190 + gusset 60 + face 190 = 440, the faces meet at their bottoms
    assert strip_topology(440, 131, 190, 60) == "bottom"
    # FGPO7570 printed at 1:3.4: 431 mm (bleed scaled in) for two 220 mm faces meeting at their tops
    assert strip_topology(431, 130, 220, 80) == "top"
    assert strip_topology(300, 130, 220, 80) is None  # (neither: the strip is not this pouch, nothing is cut)


def test_a_grid_stopped_at_a_band_line_reaches_the_mirrored_edge(tmp_path):
    from app.pdf.vector import mirror_edges

    # FGPO7700: front (top) and back (bottom, upside down) each have a 16 mm top area, then 4 / 5 / 13 mm
    # bands; the front's outer edge overshoots to the dimension labels and closes no grid
    mm = 72 / 25.4
    doc = pymupdf.open()
    page = doc.new_page(width=170 * mm, height=480 * mm)
    for y in (26.6, 42.6, 46.6, 51.6, 64.6, 176.6, 186.6, 292.6, 308.6, 420.6, 433.6, 438.6, 442.6, 458.6):
        page.draw_line((0, y * mm), ((135 if y == 26.6 else 125) * mm, y * mm), width=0.5)
    for y in (22.6, 462.6, 17.7):  # bleed edges and a dimension line past the width
        page.draw_line((-2 * mm, y * mm), (150 * mm, y * mm), width=0.5)
    for x in (0, 125):
        page.draw_line((x * mm, 15 * mm), (x * mm, 465 * mm), width=0.5)
    doc.save(tmp_path / "d.pdf")
    with pymupdf.open(tmp_path / "d.pdf") as d:
        inv = ~d[0].transformation_matrix
        r = (pymupdf.Rect(0, 42.6 * mm, 125 * mm, 458.6 * mm) * inv).normalize()
    got = mirror_edges(tmp_path / "d.pdf", Box(r.x0, r.y0, r.x1, r.y1))
    assert abs(got.height_mm - 432.0) < 0.3 and abs(got.y0 - r.y0) < 0.5  # the top moved up 16 mm, the bottom stayed
    sym = (pymupdf.Rect(0, 26.6 * mm, 125 * mm, 458.6 * mm) * inv).normalize()
    assert mirror_edges(tmp_path / "d.pdf", Box(sym.x0, sym.y0, sym.x1, sym.y1)).height_mm == pytest.approx(432.0, abs=0.3)  # (already right: kept)
