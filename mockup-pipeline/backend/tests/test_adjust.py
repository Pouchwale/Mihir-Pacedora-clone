"""Job-page adjustments: merging over item defaults and the step each change reruns from."""

import pytest

from app.workflow.adjust import Adjustments, PanelAdjust


def test_merge_job_over_item_default():
    item = Adjustments(panels={"front": PanelAdjust(offset_x_mm=2, scale=1.2)}, material={"finish": "gloss"}, scene={"lighting": "daylight"})
    job = Adjustments(panels={"front": PanelAdjust(offset_x_mm=-1), "back": PanelAdjust(source="plain", color="#112233")}, scene={"shadow": False})
    m = job.merged_over(item)
    assert (m.panels["front"].offset_x_mm, m.panels["front"].scale) == (-1, 1.2)  # job's offset, item's scale
    assert m.panels["back"].source == "plain"
    assert (m.material.finish, m.scene.lighting, m.scene.shadow) == ("gloss", "daylight", False)


@pytest.mark.parametrize("adjust, step", [
    ({}, "render"),
    ({"panels": {"front": {"offset_x_mm": 3}}}, "render"),
    ({"panels": {"front": {"brightness": 10}}}, "texture"),
    ({"panels": {"front": {"overlays": [{"kind": "text", "text": "Hi"}]}}}, "texture"),
    ({"panels": {"front": {"overlays": [{"kind": "text", "text": "Hi"}]}}, "scene": {"shadow": False}}, "build_geometry"),
    ({"panels": {"back": {"source": "file", "file_id": 3, "fit": "contain"}}}, "link_panels"),
    ({"scene": {"lighting": "studio_soft"}}, "build_geometry"),
    ({"material": {"plain_color": "#aabbcc"}}, "build_geometry"),
    ({"keyline": {"corner_radius_mm": 4}}, "resolve_keyline"),
    ({"keyline": {"corner_radius_mm": 4}, "panels": {"gusset": {"source": "plain"}}}, "resolve_keyline"),  # workflow order, not the list's
    ({"panels": {"gusset": {"source": "plain", "color": "#aabbcc"}}}, "link_panels"),
    ({"swap_front_back": True}, "link_panels"),
    ({"specs": {"client_name": "X"}}, "validate"),
    ({"specs": {"pouch_height_mm": 200}}, "extract_specs"),
])
def test_earliest_step(adjust, step):
    assert Adjustments.model_validate(adjust).earliest_step() == step


def test_item_default_reaches_a_job(seeded):
    """An item_override saved with adjustments is what a new job of that item starts from."""
    from types import SimpleNamespace

    from app.index import store
    from app.workflow.adjust import adjustments
    from app.workflow.context import JobIndex

    store.save(seeded, "item_override", "fgpo7535", {"adjustments": {"scene": {"lighting": "daylight"}}}, store.Author(None, "t"), "test")
    seeded.commit()
    index = JobIndex(seeded, store.snapshot(seeded))
    assert index.get("item_override", "fgpo7535").adjustments["scene"]["lighting"] == "daylight"
    ctx = SimpleNamespace(index=index, job=SimpleNamespace(item_code="FGPO7535"), inputs={})
    assert adjustments(ctx).scene.lighting == "daylight"
    ctx.inputs = {"adjust": {"scene": {"shadow": False}}}
    merged = adjustments(ctx)
    assert (merged.scene.lighting, merged.scene.shadow) == ("daylight", False)


def test_panel_transform_and_validation():
    assert PanelAdjust().transform() is None
    assert PanelAdjust(rotation=180).transform()["rotation"] == 180
    assert PanelAdjust(rotation=450).rotation == 90
    with pytest.raises(ValueError):
        PanelAdjust(rotation=45)
    with pytest.raises(ValueError):
        PanelAdjust(color="blue")
    with pytest.raises(ValueError):
        PanelAdjust(background="white")
    with pytest.raises(ValueError):
        PanelAdjust(fit="tile")


def test_overlays_validate_and_merge():
    from app.workflow.adjust import Overlay

    p = PanelAdjust(overlays=[{"kind": "text", "text": "Hello", "x_mm": 10, "y_mm": 20, "size_mm": 6, "color": "#ff0000"},
                              {"kind": "image", "file_id": 4, "x_mm": 30, "y_mm": 40, "width_mm": 25, "rotation": -15, "opacity": 0.8}])
    assert p.bakes() and p.is_identity() and p.transform() is None  # overlays are baked, not a texture matrix
    assert isinstance(p.overlays[0], Overlay) and p.overlays[1].height_mm is None
    with pytest.raises(ValueError):
        Overlay(kind="text", color="red")
    with pytest.raises(ValueError):
        Overlay(opacity=1.5)
    with pytest.raises(ValueError):
        PanelAdjust(overlays=[{"kind": "text"}] * 41)
    # a job's overlays replace the item default's for that panel (a list is not merged field by field)
    item = Adjustments(panels={"front": PanelAdjust(overlays=[Overlay(kind="text", text="item")], scale=1.2)})
    job = Adjustments(panels={"front": PanelAdjust(overlays=[Overlay(kind="text", text="job")])})
    m = job.merged_over(item)
    assert [o.text for o in m.panels["front"].overlays] == ["job"] and m.panels["front"].scale == 1.2
    assert PanelAdjust.model_validate(m.panels["front"].model_dump()).overlays[0].text == "job"  # round-trips through the job's inputs
