"""'Butterfly Notch: Yes' is the butterfly (sombrero) hang hole at the top centre, never a second
tear notch (FGPO7700 / 7570 / 0928 showed two notches a side and no hole), and a hang hole drawn
on the dieline is measured from its vectors."""

import pymupdf
import pytest
from PIL import Image

from app.geometry import dieline
from app.geometry import spec as geo
from app.geometry.panels import panel_sizes
from app.index import store
from app.index.conditions import spec_context
from app.index.resolve import resolve_keyline, resolve_materials
from app.pdf.layers import PT_TO_MM, Box
from app.pdf.vector import hang_hole
from app.specs.schema import Num, NumList
from app.steps.extract_specs import _with_hang_hole

MM = 1 / PT_TO_MM  # points per mm


def _geometry(seeded, sheet, type_key="stand_up_bottom_gusset", overrides=None):
    index = store.load_all(seeded)
    pouch = index["pouch_type"][type_key]
    ctx = spec_context(sheet)
    resolved = resolve_keyline(pouch.keyline_template, index["keyline_template"][pouch.keyline_template], type_key, ctx)
    kl = {**resolved.values(), **(overrides or {})}
    sources = {k: f.source for k, f in resolved.fields.items()} | {k: "item_override" for k in overrides or {}}
    sizes = panel_sizes(pouch.geometry_template, pouch.base_geometry, ctx["spec"], kl)
    return geo.build(pouch, ctx["spec"], kl, sizes, resolve_materials(index["material"], ctx), index["output_preset"]["ecommerce"],
                     "ecommerce", sources=sources, measured=ctx["measured"])


def _with_butterfly(sheet, value=True):
    table = sheet.spec_table.model_copy(update={"butterfly_notch": sheet.spec_table.butterfly_notch.model_copy(update={"value": value})})
    return sheet.model_copy(update={"spec_table": table})


def test_butterfly_is_a_hang_hole_not_a_second_notch(seeded, sample_sheet):
    g = _geometry(seeded, _with_butterfly(sample_sheet))
    assert g.hang_hole.type == "butterfly" and g.butterfly_notch
    assert g.tear_notch.type == "v_notch"  # one notch a side, where the keyline puts it
    top, bottom = geo.hang_hole_extent(g.hang_hole, g.width_mm)
    assert 0 < top < bottom <= g.zipper.y_from_top_mm  # above the zipper, inside the pouch
    svg = dieline.panel_svg("front", g, Image.new("RGB", (240, 312)))
    assert svg.count("v notch") == 1 and geo.hang_hole_path(g.hang_hole, g.width_mm) in svg


def test_no_butterfly_no_hole(seeded, sample_sheet):
    g = _geometry(seeded, _with_butterfly(sample_sheet, False))
    assert g.hang_hole.type == "none" and not g.butterfly_notch


def test_operator_choice_wins(seeded, sample_sheet):
    g = _geometry(seeded, _with_butterfly(sample_sheet), overrides={"hang_hole_type": "none"})
    assert g.hang_hole.type == "none"
    g = _geometry(seeded, _with_butterfly(sample_sheet, False), overrides={"hang_hole_type": "round", "hang_hole_size_mm": 7})
    assert (g.hang_hole.type, g.hang_hole.size_mm) == ("round", 7)


def test_index_seeded_before_the_fix_still_gets_the_hole():
    """An index whose hang_hole_type has no spec / measured source (resolves 'none' from its default)."""
    kl = {"hang_hole_type": "none", "hang_hole_size_mm": 8, "hang_hole_offset_mm": 10, "butterfly_notch": True}
    h = geo.resolve_hang_hole(kl, {"hang_hole_type": "default", "butterfly_notch": "spec_table"}, {}, 120)
    assert h.type == "butterfly" and h.size_mm == 6 and h.width_mm == 30
    # and the drawn hole beats the table's default size
    measured = {"hang_hole_type": "butterfly", "hang_hole_width_mm": 29, "hang_hole_size_mm": 6.3, "hang_hole_height_mm": 10.1, "hang_hole_y_mm": 12.4}
    h = geo.resolve_hang_hole(kl, {"hang_hole_type": "default"}, measured, 120)
    assert (h.width_mm, h.size_mm, h.offset_mm) == (29, 6.3, 12.4)
    assert geo.hang_hole_extent(h, 120) == pytest.approx((12.4 - 3.15 - 3.8, 12.4 + 3.15))


@pytest.mark.parametrize("hole", [
    geo.HangHole(type="butterfly", size_mm=6, offset_mm=10, width_mm=30),  # the default sombrero: radius > rise
    geo.HangHole(type="butterfly", size_mm=6.3, offset_mm=12.4, width_mm=29, height_mm=10.1),  # as measured on FGPO7700's drawing
    geo.HangHole(type="butterfly", size_mm=4, offset_mm=12, width_mm=12, height_mm=10),  # rise = radius: a half circle
    geo.HangHole(type="euro", size_mm=6, offset_mm=10),
    geo.HangHole(type="round", size_mm=8, offset_mm=10),
])
def test_drawn_outline_has_the_hole_s_extent(hole):
    """The SVG outline (3D cut, dieline, preview all draw it) spans exactly hang_hole_extent / dims:
    a wrong arc flag drew the dome as the large arc, up through the pouch's top edge."""
    w = 120
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}mm" height="60mm" viewBox="0 0 {w} 60">'
           f'<path d="{geo.hang_hole_path(hole, w)}" fill="none" stroke="black" stroke-width="0.01"/></svg>')
    with pymupdf.open(stream=svg.encode(), filetype="svg") as doc:
        page = doc[0]
        k = page.rect.width / w  # points per viewBox unit
        pts = [p for d in page.get_drawings() for it in d["items"] for p in _item_points_page(it)]
    ys, xs = [p[1] / k for p in pts], [p[0] / k for p in pts]
    top, bottom = geo.hang_hole_extent(hole, w)
    width = geo.hang_hole_dims(hole, w)[0]
    assert min(ys) == pytest.approx(top, abs=0.05) and max(ys) == pytest.approx(bottom, abs=0.05)
    assert max(xs) - min(xs) == pytest.approx(width, abs=0.05)


def _item_points_page(item):
    if item[0] == "l":
        return [tuple(item[1]), tuple(item[2])]
    if item[0] == "c":
        p = [pymupdf.Point(q) for q in item[1:5]]
        return [((1 - t) ** 3 * p[0].x + 3 * t * (1 - t) ** 2 * p[1].x + 3 * t * t * (1 - t) * p[2].x + t ** 3 * p[3].x,
                 (1 - t) ** 3 * p[0].y + 3 * t * (1 - t) ** 2 * p[1].y + 3 * t * t * (1 - t) * p[2].y + t ** 3 * p[3].y)
                for t in (i / 32 for i in range(33))]
    return []


def test_choosing_the_drawn_type_keeps_the_drawn_size():
    measured = {"hang_hole_type": "butterfly", "hang_hole_width_mm": 32, "hang_hole_size_mm": 8, "hang_hole_height_mm": 13, "hang_hole_y_mm": 14}
    kl = {"hang_hole_type": "butterfly", "hang_hole_size_mm": 8, "hang_hole_offset_mm": 14}
    h = geo.resolve_hang_hole(kl, {"hang_hole_type": "item_override", "hang_hole_size_mm": "measured"}, measured, 150)
    assert (h.size_mm, h.width_mm, h.height_mm) == (8, 32, 13)
    # another type than the drawn one: that hole's own default size, at the drawn place
    h = geo.resolve_hang_hole({**kl, "hang_hole_type": "round"}, {"hang_hole_type": "item_override", "hang_hole_size_mm": "measured",
                                                                   "hang_hole_offset_mm": "measured"}, measured, 150)
    assert (h.type, h.size_mm, h.offset_mm) == ("round", 8, 14)


def test_no_hole_on_a_top_spout_or_roll(seeded, sample_sheet):
    g = _geometry(seeded, _with_butterfly(sample_sheet), "roll_stock")
    assert g.hang_hole.type == "none"


def _sombrero(page: pymupdf.Page, cx: float, top: float, width: float = 29, slot: float = 6.3, rise: float = 3.8, radius: float = 5.8):
    """A sombrero outline in mm (page space, y down): lines, the dome a Bezier through its top."""
    rs = slot / 2
    y0, y1 = top + rise, top + rise + slot
    x0, x1 = cx - width / 2, cx + width / 2
    p = lambda x, y: pymupdf.Point(x * MM, y * MM)  # noqa: E731
    dome_cy = y0 - rise + radius
    half = (radius ** 2 - (dome_cy - y0) ** 2) ** 0.5
    s = page.new_shape()
    s.draw_line(p(x0 + rs, y0), p(cx - half, y0))
    c = (8 * top - 2 * y0) / 6  # control height that puts the curve's top at `top`
    s.draw_bezier(p(cx - half, y0), p(cx - half, c), p(cx + half, c), p(cx + half, y0))
    s.draw_line(p(cx + half, y0), p(x1 - rs, y0))
    k = 4 / 3 * rs  # a semicircle as one cubic: reaches x1 (x0) at its middle
    s.draw_bezier(p(x1 - rs, y0), p(x1 - rs + k, y0), p(x1 - rs + k, y1), p(x1 - rs, y1))
    s.draw_line(p(x1 - rs, y1), p(x0 + rs, y1))
    s.draw_bezier(p(x0 + rs, y1), p(x0 + rs - k, y1), p(x0 + rs - k, y0), p(x0 + rs, y0))
    s.finish(color=(0, 0, 1), width=0.3)
    s.commit()


def _face_pdf(tmp_path, name, draw):
    doc = pymupdf.open()
    page = doc.new_page(width=200 * MM, height=250 * MM)
    page.draw_rect(pymupdf.Rect(10 * MM, 10 * MM, 130 * MM, 210 * MM), color=(0, 0, 1), width=0.3)  # the face, 120 x 200
    page.draw_rect(pymupdf.Rect(10 * MM, 10 * MM, 130 * MM, 26 * MM), color=(0, 0, 1), width=0.3)  # top seal
    draw(page)
    path = tmp_path / f"{name}.pdf"
    doc.save(path)
    doc.close()
    with pymupdf.open(path) as d:
        r = d[0].rect
    # the face box in PDF user space (y up)
    return path, Box(10 * MM, r.height - 210 * MM, 130 * MM, r.height - 10 * MM)


def test_sombrero_drawn_on_the_dieline_is_measured(tmp_path):
    path, face = _face_pdf(tmp_path, "sombrero", lambda page: (_sombrero(page, 70, 10 + 5.45),
                                                                 page.insert_text((15 * MM, 60 * MM), "HANG HOLE", fontsize=6)))
    shape = hang_hole(path, None, face)
    assert shape is not None and shape.kind == "butterfly" and shape.dome == "top"
    assert shape.width_mm == pytest.approx(29, abs=0.8)
    assert shape.slot_mm == pytest.approx(6.3, abs=0.4)
    assert shape.top_mm == pytest.approx(5.45, abs=0.3) and shape.bottom_mm == pytest.approx(5.45 + 3.8 + 6.3, abs=0.3)


def test_round_and_euro_holes(tmp_path):
    path, face = _face_pdf(tmp_path, "round", lambda page: page.draw_circle(pymupdf.Point(70 * MM, 20 * MM), 4 * MM, color=(0, 0, 1)))
    shape = hang_hole(path, None, face)
    assert shape.kind == "round" and shape.width_mm == pytest.approx(8, abs=0.2)

    def euro(page):
        s = page.new_shape()
        p = lambda x, y: pymupdf.Point(x * MM, y * MM)  # noqa: E731
        s.draw_line(p(58, 17), p(82, 17))
        s.draw_curve(p(82, 17), p(86, 20), p(82, 23))
        s.draw_line(p(82, 23), p(58, 23))
        s.draw_curve(p(58, 23), p(54, 20), p(58, 17))
        s.finish(color=(0, 0, 1), width=0.3)
        s.commit()
    path, face = _face_pdf(tmp_path, "euro", euro)
    shape = hang_hole(path, None, face)
    assert shape.kind == "euro" and shape.slot_mm == pytest.approx(6, abs=0.2)


def test_no_hole_drawn(tmp_path):
    # an off-centre arc (a corner) and a valve circle well down the face are not hang holes
    def marks(page):
        page.draw_circle(pymupdf.Point(70 * MM, 80 * MM), 11 * MM, color=(0, 0, 1))
        page.draw_circle(pymupdf.Point(70 * MM, 42 * MM), 10.5 * MM, color=(0, 0, 1))  # a 21 mm valve 32 mm down
        page.draw_circle(pymupdf.Point(20 * MM, 20 * MM), 3 * MM, color=(0, 0, 1))
    path, face = _face_pdf(tmp_path, "none", marks)
    assert hang_hole(path, None, face) is None


def test_measured_hole_on_a_face_read_upside_down():
    from app.pdf.vector import HangHoleShape
    from app.specs.schema import Bool, MeasuredKeyline

    zero, segs = Num(value=0.0, confidence=1), NumList(value=[16.6, 183.4], confidence=1)
    m = MeasuredKeyline(overall_width_mm=Num(value=120, confidence=1), overall_height_mm=Num(value=200, confidence=1),
                        bleed_left_mm=zero, bleed_right_mm=zero, bleed_top_mm=zero, bleed_bottom_mm=zero,
                        width_segments_mm=NumList(value=[10, 100, 10], confidence=1), height_segments_mm=segs,
                        zipper_line_drawn=Bool(value=False, confidence=1))
    upright = HangHoleShape("butterfly", 29, 5.45, 15.55, 6.3, "top")
    assert _with_hang_hole(m, upright, False, 200).hang_hole_y_mm == pytest.approx(12.4)
    drawn_upside_down = HangHoleShape("butterfly", 29, 200 - 15.55, 200 - 5.45, 6.3, "bottom")
    out = _with_hang_hole(m, drawn_upside_down, True, 200)
    assert out.hang_hole_type == "butterfly" and out.hang_hole_y_mm == pytest.approx(12.4)
    # a hole that is not near the top after all is not taken
    assert _with_hang_hole(m, upright, True, 200).hang_hole_type is None


def test_a_field_missing_from_an_older_stored_index_still_takes_effect(seeded, sample_sheet):
    """The live index predated hang_hole_width_mm / height_mm: the job page's hole width was saved and
    ignored. resolve_keyline fills the fields a stored template lacks from the shipped seed."""
    from app.index import store
    from app.index.conditions import spec_context
    from app.index.resolve import resolve_keyline
    from app.index.schemas import ItemOverride

    index = store.load_all(seeded)
    pouch = index["pouch_type"]["stand_up_bottom_gusset"]
    old = index["keyline_template"][pouch.keyline_template]
    old = old.model_copy(update={"fields": {k: v for k, v in old.fields.items() if k not in ("hang_hole_width_mm", "hang_hole_height_mm", "tear_notch_depth_mm")}})
    item = ItemOverride(keyline_overrides={"hang_hole_type": "butterfly", "hang_hole_width_mm": 24, "hang_hole_height_mm": 11, "tear_notch_depth_mm": 6})
    kl = resolve_keyline(pouch.keyline_template, old, "stand_up_bottom_gusset", spec_context(sample_sheet), item=item)
    assert {k: kl.fields[k].value for k in ("hang_hole_width_mm", "hang_hole_height_mm", "tear_notch_depth_mm")} == {
        "hang_hole_width_mm": 24, "hang_hole_height_mm": 11, "tear_notch_depth_mm": 6}


def test_a_pouch_type_default_beats_the_usual_sombrero():
    # an admin saved 7 mm slot / 26 mm wide as the type's default: a butterfly with nothing drawn uses it
    kl = {"hang_hole_type": "butterfly", "hang_hole_size_mm": 7, "hang_hole_width_mm": 26, "hang_hole_offset_mm": 10}
    src = {"hang_hole_type": "item_override", "hang_hole_size_mm": "default", "hang_hole_width_mm": "default"}
    h = geo.resolve_hang_hole(kl, src, {}, 120)
    assert (h.size_mm, h.width_mm) == (7, 26)
    # the shipped defaults (8 mm, 0) still give the usual sombrero
    h = geo.resolve_hang_hole({**kl, "hang_hole_size_mm": 8, "hang_hole_width_mm": 0}, src, {}, 120)
    assert (h.size_mm, h.width_mm) == (6, 30)


def test_notch_depth_reaches_the_geometry(seeded, sample_sheet):
    from app.index import store
    from app.index.conditions import spec_context
    from app.index.resolve import resolve_keyline, resolve_materials
    from app.geometry.panels import panel_sizes

    index = store.load_all(seeded)
    pouch = index["pouch_type"]["stand_up_bottom_gusset"]
    ctx = spec_context(sample_sheet)
    kl = {**resolve_keyline(pouch.keyline_template, index["keyline_template"][pouch.keyline_template], "stand_up_bottom_gusset", ctx).values(),
          "tear_notch_type": "v_notch", "tear_notch_depth_mm": 7}
    sizes = panel_sizes(pouch.geometry_template, pouch.base_geometry, ctx["spec"], kl)
    g = geo.build(pouch, ctx["spec"], kl, sizes, resolve_materials(index["material"], ctx), index["output_preset"]["ecommerce"], "ecommerce")
    assert g.tear_notch.depth_mm == 7
