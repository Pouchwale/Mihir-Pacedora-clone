"""build_geometry: the parametric geometry spec (mm) for the three.js builder, plus the output preset."""

import json

from pydantic import BaseModel

from app.geometry import spec as geo
from app.index.conditions import spec_context
from app.index.resolve import find_client, resolve_materials
from app.index.schemas import ClientSettings, ItemOverride, OutputPreset, PouchType
from app.workflow.adjust import adjustments
from app.workflow.context import StepContext
from app.workflow.steps.link_panels import Output as LinkOutput
from app.workflow.steps.match_pouch_type import Output as MatchOutput
from app.workflow.steps.resolve_keyline import Output as KeylineOutput
from app.workflow.steps.validate import Output as ValidateOutput


class Output(BaseModel):
    geometry: geo.GeometrySpec
    geometry_key: str


def choose_preset(ctx: StepContext, client: ClientSettings | None, item: ItemOverride | None, pouch: PouchType | None = None) -> tuple[str, OutputPreset]:
    """Job input > item override > client default > pouch type default > the index default preset."""
    presets: dict[str, OutputPreset] = ctx.index.all("output_preset")  # type: ignore[assignment]
    for key in (ctx.inputs.get("output_preset"), item.output_preset if item else None, client.default_output_preset if client else None,
                pouch.default_output_preset if pouch else None):
        if key and key in presets:
            return key, presets[key]
    key = next((k for k, p in presets.items() if p.is_default), None) or next(iter(presets))
    return key, presets[key]


def with_sleeve(ctx: StepContext, geometry: geo.GeometrySpec, spec: dict, keyline: dict, panels: dict) -> geo.GeometrySpec:
    """The container the sleeve goes on (the job's choice, else the item name's words, else the default),
    sized from the sleeve; the model is that container, as wide as it and as tall."""
    from app.geometry import sleeve as sleeve_geo

    printed_w, height = panels["sleeve"].expected_mm
    text = " ".join(str(v) for v in (spec.get("item_name"), ctx.job.file.filename) if v)
    s = sleeve_geo.build(ctx.index.all("container"), ctx.inputs.get("container"), text, printed_w, height,  # type: ignore[arg-type]
                         float(keyline.get("sleeve_layflat_mm") or 0), float(keyline.get("sleeve_front_center_pct") or 50),
                         ctx.inputs.get("container_style"))
    ctx.log(f"Shrink sleeve on a {s.name.lower()} ({'chosen for the job' if s.chosen_by == 'job' else 'by the item name' if s.chosen_by == 'words' else 'the default'}): "
            f"diameter {s.diameter_mm:g} mm x {s.container_height_mm:g} mm, sleeve {height:g} mm tall, seam {s.overlap_mm:g} mm", "audit")
    dims = [geo.Dimension(label="Diameter", value_mm=s.diameter_mm, kind="width"), geo.Dimension(label="Height", value_mm=s.container_height_mm, kind="height"),
            geo.Dimension(label="Sleeve height", value_mm=height, kind="other"), geo.Dimension(label="Lay-flat", value_mm=s.layflat_mm, kind="other")]
    return geometry.model_copy(update={"sleeve": s.model_dump(), "width_mm": s.diameter_mm, "height_mm": s.container_height_mm, "dimensions": dims,
                                       "shape": s.shape})


def run(ctx: StepContext) -> Output:
    sheet = ctx.output("validate", ValidateOutput).sheet
    type_key = ctx.output("match_pouch_type", MatchOutput).pouch_type
    pouch: PouchType = ctx.index.get("pouch_type", type_key)  # type: ignore[assignment]
    keyline = ctx.output("resolve_keyline", KeylineOutput).keyline.values()
    panels = ctx.output("link_panels", LinkOutput).panels
    spec_ctx = spec_context(sheet, list(panels))
    spec = spec_ctx["spec"]
    _, client = find_client(ctx.index.all("client"), spec.get("client_name"))  # type: ignore[arg-type]
    item = ctx.index.get("item_override", (spec.get("item_no") or "").lower())
    preset_key, preset = choose_preset(ctx, client, item, pouch)  # type: ignore[arg-type]
    # Job-page adjustments: finish / metallic film change which material rules apply; the scene
    # settings override the preset for this job.
    adj = adjustments(ctx)
    if adj.material.finish != "auto":
        spec_ctx["spec"]["finish"] = adj.material.finish
        spec["finish"] = adj.material.finish
    rules = dict(ctx.index.all("material"))
    if pouch.default_material and pouch.default_material in rules:
        # The pouch type's own base material: applied first (lowest priority), matching rules refine it.
        base = rules[pouch.default_material]
        rules = {pouch.default_material: base.model_copy(update={"priority": min(base.priority, 0), "when": []}), **{k: v for k, v in rules.items() if k != pouch.default_material}}
    materials = resolve_materials(rules, spec_ctx)  # type: ignore[arg-type]
    if adj.material.metallic == "on" and "white_less" not in materials.surfaces:
        materials.surfaces["white_less"] = {"metalness": 1.0, "roughness": 0.3, "specular_intensity": 1.0}
        materials.applied.setdefault("white_less", []).append("operator")
    elif adj.material.metallic == "off":
        materials.surfaces.pop("white_less", None)
    scene = adj.scene
    changes = {k: v for k, v in (("lighting", scene.lighting), ("background", scene.background), ("shadow", scene.shadow), ("views", scene.views)) if v is not None}
    if changes:
        preset = preset.model_copy(update=changes)
        ctx.log("Scene adjusted by the operator: " + ", ".join(f"{k}={v if not hasattr(v, 'type') else v.type}" for k, v in changes.items()), "audit")
    geometry = geo.build(pouch, spec, keyline, {r: p.expected_mm for r, p in panels.items()}, materials, preset, preset_key)
    if pouch.geometry_template == "shrink_sleeve":
        geometry = with_sleeve(ctx, geometry, spec, keyline, panels)
    if adj.windows:
        geometry.window.shapes = [w.model_dump(mode="json") for w in adj.windows]
        ctx.log(f"{len(adj.windows)} clear window(s) marked by the operator", "audit")
    key = f"{ctx.prefix}/geometry.json"
    ctx.storage.put_bytes(key, json.dumps(geometry.model_dump(mode="json"), indent=1).encode(), "application/json")
    ctx.log(f"Geometry {geometry.template} ({geometry.shape}) {geometry.width_mm} x {geometry.height_mm} mm; preset {preset_key}")
    return Output(geometry=geometry, geometry_key=key)
