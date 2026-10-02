"""Geometry spec, panel sizes, keyline preview SVG, export naming."""

import pytest
from PIL import Image

from app.errors import NeedsReview
from app.geometry import dieline
from app.geometry import spec as geo
from app.geometry.panels import panel_sizes
from app.index import store
from app.index.conditions import spec_context
from app.index.resolve import resolve_keyline, resolve_materials
from app.workflow.steps.export import slug


SPEC = {"pouch_closed_width_mm": 240, "pouch_height_mm": 312, "gusset_full_width_mm": 120, "gusset_type": "Bottom"}


@pytest.mark.parametrize("template, base, roles", [
    ("stand_up_bottom_gusset", None, {"front", "back", "gusset", "top"}),
    ("three_side_seal", None, {"front", "back", "top"}),
    ("quad_seal", None, {"front", "back", "side_left", "side_right", "top"}),
    ("flat_bottom_box_pouch", None, {"front", "back", "side_left", "side_right", "bottom", "top"}),
    ("spout_pouch", "stand_up_bottom_gusset", {"front", "back", "gusset", "top"}),
    ("shaped_diecut", "auto", {"front", "back", "gusset", "top"}),
])
def test_panel_sizes(template, base, roles):
    sizes = panel_sizes(template, base, SPEC, {})
    assert set(sizes) == roles
    assert sizes["front"] == (240, 312)
    if "gusset" in sizes:
        assert sizes["gusset"] == (240, 120)
    if "side_left" in sizes:
        assert sizes["side_left"] == (120, 312)


def test_panel_sizes_need_the_pouch_size():
    with pytest.raises(NeedsReview):
        panel_sizes("three_side_seal", None, {"pouch_height_mm": 312}, {})


def _geometry(seeded, sample_sheet, type_key="stand_up_bottom_gusset"):
    index = store.load_all(seeded)
    pouch = index["pouch_type"][type_key]
    ctx = spec_context(sample_sheet)
    kl = resolve_keyline(pouch.keyline_template, index["keyline_template"][pouch.keyline_template], type_key, ctx).values()
    sizes = panel_sizes(pouch.geometry_template, pouch.base_geometry, ctx["spec"], kl)
    return geo.build(pouch, ctx["spec"], kl, sizes, resolve_materials(index["material"], ctx), index["output_preset"]["ecommerce"], "ecommerce")


def test_geometry_spec_for_sample(seeded, sample_sheet):
    g = _geometry(seeded, sample_sheet)
    assert (g.width_mm, g.height_mm, g.gusset_full_mm, g.gusset_depth_mm) == (240, 312, 120, 60)
    assert g.seals.side == g.seals.top == g.seals.bottom == 10
    assert g.zipper.enabled and g.zipper.y_from_top_mm == 28 and g.tear_notch.y_from_top_mm == 22
    assert g.corner_radius_mm == 6 and not g.window.enabled and g.spout is None
    assert {d.label: d.value_mm for d in g.dimensions}["Bottom gusset (full)"] == 120
    assert g.panels["gusset"].width_mm == 240 and g.panels["gusset"].height_mm == 120


def test_geometry_spec_spout_and_roll(seeded, sample_sheet):
    spout = _geometry(seeded, sample_sheet, "spout_pouch")
    assert spout.shape == "stand_up_bottom_gusset" and spout.spout.position == "top_right_corner"
    roll = _geometry(seeded, sample_sheet, "roll_stock")
    assert roll.roll.repeat_mm == pytest.approx(488.95 / 2)  # circumference / around-ups = 244.475
    assert roll.roll.web_width_mm == 320


def test_keyline_svg(seeded, sample_sheet):
    g = _geometry(seeded, sample_sheet)
    svg = dieline.panel_svg("front", g, Image.new("RGB", (240, 312), "#29224b"))
    assert svg.startswith("<svg") and 'viewBox="-22.0 -22.0 284.0 356.0"' in svg
    for text in ("zipper 28 mm from top", "v notch 22 mm", "240 mm", "312 mm", "gusset fold (depth 60 mm)", 'rx="6.0"'):
        assert text in svg, text
    assert "centre fold" in dieline.panel_svg("gusset", g, None, "#29224b")


def test_slug():
    assert slug("Crystal Enterprises") == "crystal-enterprises" and slug(None) == "unknown"
