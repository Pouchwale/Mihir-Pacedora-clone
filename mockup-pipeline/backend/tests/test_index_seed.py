"""The seed index against the sample job: matching, keyline precedence, materials."""

import copy

import pytest

from app.index import store
from app.index.conditions import spec_context
from app.index.resolve import match_pouch_type, resolve_keyline, resolve_materials
from app.index.schemas import ClientSettings, ItemOverride


def _ctx(sheet, **spec_changes):
    ctx = spec_context(sheet)
    ctx = copy.deepcopy(ctx)
    ctx["spec"].update(spec_changes)
    return ctx


def test_seed_has_all_pouch_types(seeded):
    index = store.load_all(seeded)
    assert set(index["pouch_type"]) == {
        "three_side_seal", "center_seal_pillow", "center_seal_side_gusset", "stand_up_bottom_gusset",
        "flat_bottom_box_pouch", "quad_seal", "spout_pouch", "shaped_diecut", "roll_stock", "shrink_sleeve",
    }
    assert index["pouch_type"]["stand_up_bottom_gusset"].required_panels == ["front", "back", "gusset"]
    assert index["pouch_type"]["flat_bottom_box_pouch"].required_panels == ["front", "back", "side_left", "side_right", "bottom"]
    assert index["pouch_type"]["shrink_sleeve"].required_panels == ["sleeve"] and set(index["container"]) == {"drink_can", "tin", "bottle", "jar", "ghee_pot"}


def test_sample_matches_stand_up(seeded, sample_sheet):
    index = store.load_all(seeded)
    result = match_pouch_type(index["pouch_type"], spec_context(sample_sheet))
    assert result.status == "matched" and result.pouch_type == "stand_up_bottom_gusset"


@pytest.mark.parametrize("changes, expected", [
    ({"sealing_type": "Center Seal", "gusset_type": "None"}, "center_seal_pillow"),
    ({"sealing_type": "Centre Seal", "gusset_type": "Side"}, "center_seal_side_gusset"),
    ({"sealing_type": "3 Side Seal", "gusset_type": "None"}, "three_side_seal"),
    ({"sealing_type": "Flat Bottom"}, "flat_bottom_box_pouch"),
    ({"sealing_type": "Quad Seal"}, "quad_seal"),
    ({"pouch_or_roll_form": "Roll Form"}, "roll_stock"),
    ({"raw_remarks": "Spout pouch | Back Code : FGPO1"}, "spout_pouch"),
    ({"sealing_type": "Shaped"}, "shaped_diecut"),
])
def test_match_variants(seeded, sample_sheet, changes, expected):
    result = match_pouch_type(store.load_all(seeded)["pouch_type"], _ctx(sample_sheet, **changes))
    assert (result.status, result.pouch_type) == ("matched", expected)


def test_no_match_and_ambiguous_need_review(seeded, sample_sheet):
    types = store.load_all(seeded)["pouch_type"]
    none = match_pouch_type(types, _ctx(sample_sheet, sealing_type="Mystery"))
    assert none.status == "no_match" and none.needs_review
    both = match_pouch_type(types, _ctx(sample_sheet, sealing_type="Shaped", raw_remarks="spout"))
    assert both.status == "ambiguous" and set(both.candidates) == {"shaped_diecut", "spout_pouch"}


def test_item_override_forces_type(seeded, sample_sheet):
    result = match_pouch_type(store.load_all(seeded)["pouch_type"], spec_context(sample_sheet), ItemOverride(pouch_type="quad_seal"))
    assert (result.status, result.pouch_type) == ("override", "quad_seal")


def _resolve(seeded, sheet, client=None, item=None, ctx=None):
    index = store.load_all(seeded)
    kt = index["keyline_template"]["stand_up_bottom_gusset"]
    return resolve_keyline("stand_up_bottom_gusset", kt, "stand_up_bottom_gusset", ctx or spec_context(sheet), client, item)


def test_sample_keyline_values_and_sources(seeded, sample_sheet):
    kl = _resolve(seeded, sample_sheet)
    f = kl.fields
    got = {k: (f[k].value, f[k].source) for k in f}
    assert got["bleed_left_mm"] == (2.2375, "measured") and got["bleed_top_mm"] == (4.0, "measured")
    assert got["side_seal_mm"] == (10.0, "measured") and got["top_seal_mm"] == (10.0, "measured")
    assert got["bottom_seal_mm"] == (10.0, "measured")
    assert got["zipper_offset_from_top_mm"] == (28.0, "measured")
    assert got["tear_notch_type"] == ("v_notch", "spec_table")
    assert got["tear_notch_offset_mm"] == (22.0, "measured")
    assert got["corner_radius_mm"] == (6.0, "pouch_type")
    assert got["gusset_depth_mm"] == (60.0, "pouch_type")
    assert got["butterfly_notch"] == (False, "spec_table")
    assert got["window_enabled"] == (False, "default") and got["window_x_mm"] == (None, "disabled")
    assert got["side_gusset_depth_mm"] == (None, "disabled")
    assert got["texture_dpi"] == (300.0, "pouch_type")
    assert got["body_bulge_percent"] == (12.0, "default")
    assert kl.issues == []


def test_precedence_item_over_client_over_type(seeded, sample_sheet):
    client = ClientSettings(client_name="Crystal Enterprises", keyline_overrides={"*": {"corner_radius_mm": 4, "side_seal_mm": 8}})
    item = ItemOverride(keyline_overrides={"corner_radius_mm": 3})
    f = _resolve(seeded, sample_sheet, client, item).fields
    assert (f["corner_radius_mm"].value, f["corner_radius_mm"].source) == (3, "item_override")
    assert (f["side_seal_mm"].value, f["side_seal_mm"].source) == (8, "client_override")


def test_spec_table_used_when_nothing_measured(seeded, sample_sheet):
    ctx = spec_context(sample_sheet)
    ctx["measured"] = {}
    f = _resolve(seeded, sample_sheet, ctx=ctx).fields
    assert (f["side_seal_mm"].value, f["side_seal_mm"].source) == (10, "spec_table")
    assert (f["bleed_left_mm"].value, f["bleed_left_mm"].source) == (4, "default")


def test_out_of_range_is_reported(seeded, sample_sheet):
    kl = _resolve(seeded, sample_sheet, item=ItemOverride(keyline_overrides={"top_seal_mm": 90}))
    assert [i.code for i in kl.issues] == ["keyline_out_of_range"]


def test_materials_for_sample(seeded, sample_sheet):
    m = resolve_materials(store.load_all(seeded)["material"], spec_context(sample_sheet))
    assert m.applied["base"] == ["film_base", "finish_matt"]
    assert m.surfaces["base"]["roughness"] == 0.85
    assert m.applied["white_less"] == ["met_pet", "met_pet_matt"]  # 12 mic Met Pet under a matt finish
    assert m.surfaces["white_less"] == {"metalness": 0.9, "roughness": 0.55, "specular_intensity": 1}
    assert "window" not in m.surfaces


def test_measured_value_out_of_range_falls_back_to_spec(seeded, sample_sheet):
    """FGPO4583 labels only the 255 mm body and a 10 mm seal: the first segment is no top seal, so
    the spec table's sealing width is used; the in-range bottom seal is still measured."""
    ctx = spec_context(sample_sheet)
    ctx["measured"]["height_segments_mm"] = [255.0, 10.0]
    f = _resolve(seeded, sample_sheet, ctx=ctx).fields
    assert (f["top_seal_mm"].value, f["top_seal_mm"].source) == (sample_sheet.spec_table.sealing_width_mm.value, "spec_table")
    assert (f["bottom_seal_mm"].value, f["bottom_seal_mm"].source) == (10.0, "measured")
