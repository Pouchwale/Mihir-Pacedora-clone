"""Versioning, references and YAML import/export."""

import pytest
import yaml

from app.index import store

ADMIN = store.Author(None, "admin@example.com")


def _preset(seeded, key="ecommerce"):
    return dict(store.get_version(seeded, "output_preset", key).data)


def test_every_change_is_a_version(seeded):
    data = _preset(seeded)
    data["width_px"] = 2400
    v2 = store.save(seeded, "output_preset", "ecommerce", data, ADMIN, "bigger renders")
    assert (v2.version, v2.action, v2.reason, v2.author_email) == (2, "update", "bigger renders", "admin@example.com")
    same = store.save(seeded, "output_preset", "ecommerce", data, ADMIN, "no-op")
    assert same.version == 2  # identical data: no new version
    v3 = store.restore(seeded, "output_preset", "ecommerce", 1, ADMIN, "back to 2000")
    assert v3.version == 3 and v3.action == "restore" and v3.data["width_px"] == 2000
    assert [v.version for v in store.history(seeded, "output_preset", "ecommerce")] == [3, 2, 1]
    assert store.get_version(seeded, "output_preset", "ecommerce", 2).data["width_px"] == 2400  # old versions stay readable


def test_reason_required(seeded):
    with pytest.raises(store.IndexError_, match="reason"):
        store.save(seeded, "output_preset", "ecommerce", _preset(seeded), ADMIN, " ")


def test_schema_errors_are_listed(seeded):
    data = _preset(seeded)
    data["width_px"] = 10
    data["naming_pattern"] = "{item_no}_{colour}.png"
    with pytest.raises(store.IndexError_) as exc:
        store.save(seeded, "output_preset", "ecommerce", data, ADMIN, "bad")
    assert len(exc.value.problems) == 2


def test_references_are_checked(seeded):
    pt = dict(store.get_version(seeded, "pouch_type", "quad_seal").data)
    pt["keyline_template"] = "nope"
    with pytest.raises(store.IndexError_, match="does not exist"):
        store.save(seeded, "pouch_type", "quad_seal", pt, ADMIN, "x")
    with pytest.raises(store.IndexError_, match="does not exist"):
        store.save(seeded, "item_override", "fgpo1", {"pouch_type": "nope"}, ADMIN, "x")
    with pytest.raises(store.IndexError_, match="does not exist"):  # still used by pouch type quad_seal
        store.archive(seeded, "keyline_template", "quad_seal", ADMIN, "x")


def test_keyline_formula_validation(seeded):
    kt = store.get_version(seeded, "keyline_template", "quad_seal").data
    bad = {**kt, "fields": {**kt["fields"], "corner_radius_mm": {**kt["fields"]["corner_radius_mm"], "formula": "open('x')"}}}
    with pytest.raises(store.IndexError_, match="Only these functions"):
        store.save(seeded, "keyline_template", "quad_seal", bad, ADMIN, "x")
    cyc = {**kt, "fields": {**kt["fields"],
                            "top_seal_mm": {**kt["fields"]["top_seal_mm"], "formula": "bottom_seal_mm"},
                            "bottom_seal_mm": {**kt["fields"]["bottom_seal_mm"], "formula": "top_seal_mm"}}}
    with pytest.raises(store.IndexError_, match="cycle"):
        store.save(seeded, "keyline_template", "quad_seal", cyc, ADMIN, "x")
    missing = {**kt, "fields": {k: v for k, v in kt["fields"].items() if k != "texture_dpi"}}
    with pytest.raises(store.IndexError_, match="texture_dpi"):
        store.save(seeded, "keyline_template", "quad_seal", missing, ADMIN, "x")


def test_add_new_pouch_type_without_code(seeded):
    """Spec 3.1: reuse a geometry template with new rules and keyline defaults."""
    kt = dict(store.get_version(seeded, "keyline_template", "stand_up_bottom_gusset").data)
    kt["name"] = "Stand-up, 3 mm round corners"
    kt["fields"] = {**kt["fields"], "corner_radius_mm": {**kt["fields"]["corner_radius_mm"], "formula": "3 if spec.round_corner else 0"}}
    store.save(seeded, "keyline_template", "standup_small_corner", kt, ADMIN, "new client template")
    pt = dict(store.get_version(seeded, "pouch_type", "stand_up_bottom_gusset").data)
    pt.update(name="Stand-up small corner", priority=45, keyline_template="standup_small_corner",
              match_rules=[{"all": [{"field": "spec.client_name", "op": "eq", "value": "Crystal Enterprises"},
                                    {"field": "spec.sealing_type", "op": "contains", "value": "stand"}]}])
    store.save(seeded, "pouch_type", "standup_small_corner", pt, ADMIN, "Crystal wants 3 mm corners")
    assert "standup_small_corner" in store.load_all(seeded)["pouch_type"]


def test_export_import_round_trip(seeded):
    text = store.export_yaml(seeded)
    plan = store.plan_import(seeded, text)
    assert plan.created == [] and plan.updated == [] and len(plan.unchanged) == 75


def test_import_dry_run_then_apply(seeded):
    doc = yaml.safe_load(store.export_yaml(seeded))
    doc["output_preset"]["ecommerce"]["width_px"] = 1600
    doc["client"] = {"crystal": {"client_name": "Crystal Enterprises", "default_output_preset": "showcase"}}
    plan = store.plan_import(seeded, yaml.safe_dump(doc))
    assert plan.updated == [("output_preset", "ecommerce")] and plan.created == [("client", "crystal")]
    assert "-width_px: 2000" in plan.diffs["output_preset/ecommerce"]
    assert store.get_version(seeded, "output_preset", "ecommerce").data["width_px"] == 2000  # dry run wrote nothing
    store.apply_import(seeded, plan, ADMIN, "tuning")
    assert store.get_version(seeded, "output_preset", "ecommerce").data["width_px"] == 1600
    assert store.get_version(seeded, "client", "crystal").action == "import"


def test_import_rejects_invalid_file_entirely(seeded):
    doc = yaml.safe_load(store.export_yaml(seeded))
    doc["output_preset"]["ecommerce"]["width_px"] = 1600
    doc["output_preset"]["showcase"]["formats"] = ["gif"]
    with pytest.raises(store.IndexError_, match="showcase"):
        store.plan_import(seeded, yaml.safe_dump(doc))
    assert store.get_version(seeded, "output_preset", "ecommerce").data["width_px"] == 2000


def test_singletons_and_keys(seeded):
    with pytest.raises(store.IndexError_, match="default"):
        store.save(seeded, "pdf_profile", "other", {}, ADMIN, "x")
    with pytest.raises(store.IndexError_, match="key must be"):
        store.save(seeded, "client", "Crystal Enterprises", {"client_name": "x"}, ADMIN, "x")


def test_snapshot(seeded):
    snap = store.snapshot(seeded)
    assert snap["keyline_template"]["stand_up_bottom_gusset"] == 1 and len(snap["pouch_type"]) == 9
