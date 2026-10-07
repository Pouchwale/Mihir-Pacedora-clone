"""Splitting a multi-panel sheet into pouch panels (pure geometry, no PDF)."""

import pytest

from app.geometry.sheet_layout import detect
from app.pdf.profile import PdfProfile

# FGPO7535 (stand-up, 120.65 x 210, gusset 80): dieline lines from the top of its 506 mm web.
YS_7535 = [0, 10, 17, 30, 200, 210, 213, 223, 283, 293, 296, 306, 476, 489, 496, 506]
XS_7535 = [0, 10, 110.65, 120.65]


def test_stand_up_web_is_front_gusset_back():
    lay = detect(120.65, 506, XS_7535, YS_7535, 120.65, 210, 80)
    assert lay.kind == "multi" and lay.axis == "vertical"
    assert [(p.kind, p.y_mm, p.height_mm, p.rotation) for p in lay.panels] == [
        ("face", 0, 210, 0), ("gusset", 213, 80, 0), ("face", 296, 210, 180)]  # the back is printed upside down
    assert all(p.x_mm == 0 and p.width_mm == 120.65 for p in lay.panels)


def test_noisy_positions_still_split():
    ys = [v + 0.0007 * (i % 3) for i, v in enumerate(YS_7535)]
    lay = detect(120.65, 506.0001, XS_7535, ys, 120.65, 210, 80)
    assert [p.height_mm for p in lay.panels] == [210, 80, 210]


def test_single_panel_with_bleed_is_not_split():
    assert detect(244.475, 320, [0, 2.2375, 12.24, 232.24, 242.24, 244.475], [0, 4, 316], 240, 312, 120).kind == "single"
    assert detect(165.1, 248, [0, 2.55, 162.55, 165.1], [0, 4, 244, 248], 160, 240, 90).kind == "single"


def test_side_by_side_panels_are_upright():
    # side gusset / quad seal web: side, front, side, back along the width
    lay = detect(300, 200, [0, 50, 150, 200, 300], [0, 10, 190, 200], 100, 200, 50)
    assert lay.kind == "multi" and lay.axis == "horizontal"
    assert [(p.kind, p.x_mm, p.width_mm, p.rotation) for p in lay.panels] == [
        ("gusset", 0, 50, 0), ("face", 50, 100, 0), ("gusset", 150, 50, 0), ("face", 200, 100, 0)]


def test_sizes_that_do_not_fit_are_reported():
    lay = detect(120.65, 506, XS_7535, YS_7535, 120.65, 150, 80)
    assert lay.kind == "unknown" and "150" in lay.message


def test_two_ups_of_a_front_and_back_web():
    """FGPO7410 (3 side seal 90.4875 x 130): the front + back web drawn twice side by side, folded at
    the middle line; the back's cut line at the bottom is not drawn, only its seal line and the bleed edge."""
    xs = [0, 9.9663, 90.4651, 100.4539, 170.9635, 180.975]
    ys = [0, 4.1862, 14.1776, 134.175, 254.1852, 268.3132]
    lay = detect(180.975, 268.3132, xs, ys, 90.4875, 130, None, open_width=260)
    assert lay.kind == "multi" and lay.axis == "vertical" and lay.ups == 2
    assert [(p.kind, p.rotation) for p in lay.panels] == [("face", 0), ("face", 180)]
    assert [(p.x_mm, p.y_mm, p.width_mm, p.height_mm) for p in lay.panels] == pytest.approx(
        [(0, 4.19, 90.47, 129.99), (0, 134.18, 90.47, 130)], abs=0.011)
    # three ups of the same web: still the first one
    assert detect(271.4625, 268.3132, [*xs, 261.4625, 271.4625], ys, 90.4875, 130, None).ups == 3


def test_which_end_is_up_comes_from_the_bands():
    from app.steps.extract_specs import _drawn_upside_down

    assert not _drawn_upside_down([10, 12, 13, 267, 10])  # FGPO7215: seal, notch, zipper, body, seal
    assert not _drawn_upside_down([10, 7, 13, 170, 10])  # FGPO7535 front
    assert _drawn_upside_down([10, 176, 13, 4.5, 1.5, 20])  # FGPO7492 first face as drawn: bands below the body
    assert not _drawn_upside_down([10, 292, 10]) and not _drawn_upside_down([300]) and not _drawn_upside_down([])
    # a drawn zipper decides: FGPO3970's brand face, drawn upside down, has its zipper 213 mm down a 230 mm face
    assert _drawn_upside_down([10, 190.18, 19.82, 10], zipper_y=[212.8])
    assert not _drawn_upside_down([10, 12, 13, 267, 10], zipper_y=[28.0])  # FGPO7215, track drawn at 28


def test_pillow_blanks_side_by_side():
    """FGPO7396: two centre-seal blanks (open width 170 = 10 + 37.5 + 75 + 37.5 + 10) on a 344 x 111.12 mm sheet."""
    xs = [2, 12, 49.5, 124.5, 162, 172, 182, 219.5, 294.5, 332, 342]
    lay = detect(344, 111.12, xs, [1.56, 109.56], 75, 108, None, open_width=170)
    assert lay.kind == "multi" and lay.axis == "horizontal"
    assert [(p.kind, p.x_mm, p.width_mm, p.height_mm, p.rotation) for p in lay.panels] == [("blank", 2, 170, 108, 0), ("blank", 172, 170, 108, 0)]
    assert lay.blank() is not None and lay.blank().x_mm == 2
    # blanks drawn on their side and stacked: turned 90 degrees upright
    tall = detect(111.12, 344, [1.56, 109.56], xs, 75, 108, None, open_width=170)
    assert tall.kind == "multi" and tall.axis == "vertical" and [(p.y_mm, p.rotation) for p in tall.panels] == [(2, 90), (172, 90)]
    # without the open width the sheet is still reported as a problem
    assert detect(344, 111.12, xs, [1.56, 109.56], 75, 108, None).kind == "unknown"


def test_front_and_back_web_with_a_seal_band_between():
    """FGPO7492: front and back (225 mm) with a ~13 mm seal band between them, no gusset panel on the sheet."""
    ys = [0, 1.5, 21.5, 226.5, 233, 240, 246.5, 251.5, 462.5, 465, 466]
    lay = detect(156.63, 466, [0, 1.31, 11.31, 142.31, 155.32, 156.63], ys, 131, 225, 80)
    assert lay.kind == "multi" and lay.axis == "vertical"
    assert [(p.kind, p.y_mm, p.height_mm, p.rotation) for p in lay.panels] == [("face", 1.5, 225, 0), ("face", 240, 225, 180)]
    # the old 8 mm limit would have refused the 13.5 mm seal band
    assert detect(156.63, 466, [0, 1.31, 11.31, 142.31, 155.32, 156.63], ys, 131, 225, 80, gap_max=8).kind == "unknown"


def test_reference_codes_are_not_panels():
    p = PdfProfile()
    remarks = "Color match as per old code : FGPO3728"
    assert p.parse_linked_codes(remarks) == {}
    assert p.parse_reference_codes(remarks) == {"color match as per old": "FGPO3728"}
    both = "Back Code : FGPO6863 | Gusset Code : FGPO6864 | Same as old code FGPO1"
    assert p.parse_linked_codes(both) == {"back": "FGPO6863", "gusset": "FGPO6864"}
    assert p.parse_reference_codes(both) == {"same as old": "FGPO1"}


def test_grid_layout_process_colour_web():
    """FGPO1788: spec tables above a front + side gusset and a back + side gusset web, dieline in
    process colours (no technical ink); cells are (x, y, w, h) mm from the sheet's top-left."""
    from app.geometry.sheet_layout import grid_layout, side_roles

    cells = [(25.8, 20, 360, 393.2), (445.8, 20, 360, 393.2),  # the two spec tables
             (23, 490.8, 234, 346.1), (257, 490.8, 126, 346.1), (443, 490.8, 234, 346.1), (677, 490.8, 126, 346.1)]
    layout = grid_layout(cells, 230, 346.075)
    assert layout is not None and [p.kind for p in layout.panels] == ["face", "gusset", "face", "gusset"]
    layout.panels[0].role, layout.panels[2].role = "front", "back"
    side_roles(layout)
    assert [p.role for p in layout.panels] == ["front", "side_right", "back", "side_left"]
    assert grid_layout(cells[:2], 230, 346.075) is None  # only tables: plain page stays one page


def test_sheet_panel_width_from_drawn_lines():
    """FGPO7152: unreadable width labels; the panel's own lines give 10 / 124 / 10 (the right cut edge
    sits just outside the measuring box, the cut edges are lines by construction)."""
    from app.specs.schema import MeasuredKeyline, Num, NumList, Bool
    from app.steps.extract_specs import _from_drawn_lines

    blank = Num(value=None, confidence=0.0)
    m = MeasuredKeyline(overall_width_mm=blank, overall_height_mm=Num(value=182, confidence=0.99), bleed_left_mm=blank,
                        bleed_right_mm=blank, bleed_top_mm=blank, bleed_bottom_mm=blank, width_segments_mm=NumList(value=[], confidence=0.0),
                        height_segments_mm=NumList(value=[10, 162, 10], confidence=0.99), zipper_line_drawn=Bool(value=False, confidence=0.9))
    out = _from_drawn_lines(m, [0.0, 10.0, 134.0], 144.0)
    assert out.width_segments_mm.value == [10.0, 124.0, 10.0] and out.overall_width_mm.value == 144.0 and out.bleed_left_mm.value == 0


def test_pillow_blanks_on_their_side_two_across():
    """FGPO7058: 164 x 170 mm centre-seal blanks, pouch height across the sheet, two beside each other
    and two down; a 164 mm run inside a blank must not be read as an upright 75 x 164 face."""
    xs = [2.14, 12.14, 156.14, 166.11, 170.42, 180.42, 324.42, 334.41]
    ys = [2.0, 12.0, 49.5, 124.5, 162.0, 166.0, 172.0, 182.0, 219.5, 294.5, 332.0, 342.0]
    layout = detect(336.55, 344.0, xs, ys, 75.0, 164.0, None, gap_max=30.0, open_width=170.0, prefer_blank=True)
    blanks = [p for p in layout.panels if p.kind == "blank"]
    assert layout.kind == "multi" and layout.ups == 2 and len(blanks) == 2
    first = blanks[0]
    assert (round(first.width_mm), round(first.height_mm), first.rotation) == (164, 170, 90)


def test_blank_under_a_table_found_by_its_drawn_lines():
    """FGPO6813-like: one 316 x 247.65 blank drawn low on a tall sheet (a spec table above it)."""
    from app.geometry.sheet_layout import detect

    lay = detect(339.66, 606.84, [11.83, 21.83, 95.83, 243.83, 317.83, 327.83], [347.36, 595.01], 148, 247.65, None,
                 open_width=316, prefer_blank=True)
    assert lay.kind == "multi" and lay.blank() is not None
    b = lay.blank()
    assert (round(b.y_mm, 2), round(b.height_mm, 2), round(b.width_mm, 2)) == (347.36, 247.65, 316.0)


def test_web_repeated_for_the_white_plate_reads_the_first_copy():
    """FGPO6059: front, gusset, back, then the same web again 34 mm lower (its white-ink plate)."""
    from app.geometry.sheet_layout import detect

    ys = [4.25, 11.25, 167.0, 174.0, 177.0, 184.0, 250.0, 257.0, 260.0, 267.0, 423.25, 430.25, 433.99, 441.0, 448.0, 460.53,
          464.56, 471.81, 627.56, 634.56, 637.56, 644.56, 710.56, 717.56, 720.56, 727.56, 883.81, 890.81]
    lay = detect(122.6, 894.56, [7.0, 100.95, 107.95, 114.95], ys, 107.95, 170.0, 80.0)
    assert lay.kind == "multi" and lay.axis == "vertical"
    assert [(p.kind, round(p.y_mm, 2)) for p in lay.panels] == [("face", 4.25), ("gusset", 177.0), ("face", 260.0)]
    assert lay.panels[2].rotation == 180  # the back stands the other way up on the web


def test_blanks_with_a_cut_off_repeat_below():
    """FGPO7338: three pillow blanks across (one per flavour) drawn on their side, 174 mm open width down
    the sheet, and the next row of them cut off by the sheet's bottom edge."""
    from app.geometry.sheet_layout import detect

    xs = [0.33, 1.32, 8.32, 112.33, 119.32, 120.65, 121.97, 128.97, 232.98, 239.97, 241.3, 242.62, 249.62, 353.62, 360.62, 361.62]
    ys = [1.97, 8.97, 49.0, 129.0, 169.0, 175.97, 182.97]
    lay = detect(361.95, 222.94, xs, ys, 87.0, 115.0, None, open_width=174.0, prefer_blank=True)
    assert lay.kind == "multi" and lay.ups == 3
    b = lay.blank()
    assert (round(b.y_mm, 2), round(b.height_mm, 2), b.rotation) == (1.97, 174.0, 90)
