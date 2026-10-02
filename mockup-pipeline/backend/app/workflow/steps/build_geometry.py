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
    key = f"{ctx.prefix}/geometry.json"
    ctx.storage.put_bytes(key, json.dumps(geometry.model_dump(mode="json"), indent=1).encode(), "application/json")
    ctx.log(f"Geometry {geometry.template} ({geometry.shape}) {geometry.width_mm} x {geometry.height_mm} mm; preset {preset_key}")
    return Output(geometry=geometry, geometry_key=key)
