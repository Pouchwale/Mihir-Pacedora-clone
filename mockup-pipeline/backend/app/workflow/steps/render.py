"""render: preset views as PNG, the GLB and the turntable MP4 from the same three.js scene as the viewer."""

from pydantic import BaseModel

from app.render import headless, tokens
from app.workflow.steps.texture import Output as TextureOutput
from app.workflow.context import StepContext
from app.workflow.steps.build_geometry import Output as GeometryOutput


class Output(BaseModel):
    views: dict[str, str]  # view -> storage key (PNG)
    glb_key: str | None
    mp4_key: str | None
    width_px: int
    height_px: int
    console: list[str]
    model_mm: dict = {}  # measured size of the built 3D model: {"flat": {x,y,z}, "filled": {x,y,z}}


def run(ctx: StepContext) -> Output:
    preset = ctx.output("build_geometry", GeometryOutput).geometry.preset
    token = tokens.make(ctx.job.id, ttl_s=ctx.settings.render_timeout_s * 3)
    want_mp4 = "mp4" in preset.formats and "turntable" in preset.views
    result = headless.render(
        ctx.job.id, token, preset.views, preset.width_px, preset.height_px,
        transparent=preset.background.type == "transparent", want_glb="glb" in preset.formats,
        turntable=(preset.turntable_seconds, preset.turntable_fps) if want_mp4 else None,
    )
    base = f"{ctx.prefix}/renders"
    views = {v: ctx.storage.put_bytes(f"{base}/{v}.png", data, "image/png") for v, data in result.views.items()} if "png" in preset.formats else {}
    # the sheet's other designs (texture step: "front@2" ...): their views too, as "<view>_design<n>"
    textures = ctx.output("texture", TextureOutput).textures
    for n in sorted({int(k.split("@")[1]) for k in textures if "@" in k}) if "png" in preset.formats else []:
        more = headless.render(ctx.job.id, token, [v for v in preset.views if v != "turntable"], preset.width_px, preset.height_px,
                               transparent=preset.background.type == "transparent", want_glb=False, turntable=None, design=n)
        views.update({f"{v}_design{n}": ctx.storage.put_bytes(f"{base}/{v}_design{n}.png", data, "image/png") for v, data in more.views.items()})
        ctx.log(f"design {n}: rendered {len(more.views)} view(s)", "audit")
    glb_key = ctx.storage.put_bytes(f"{base}/model.glb", result.glb, "model/gltf-binary") if result.glb else None
    mp4_key = ctx.storage.put_bytes(f"{base}/turntable.mp4", result.mp4, "video/mp4") if result.mp4 else None
    problems = [c for c in result.console if c.startswith(("error", "pageerror"))]
    if problems:
        ctx.log(f"Renderer reported {len(problems)} console error(s)", "warning", {"console": problems[:20]})
    if result.model_mm:
        f = result.model_mm.get("flat", {})
        ctx.log(f"3D model measured flat {f.get('x', 0):.2f} x {f.get('y', 0):.2f} mm (W x H)", "audit", result.model_mm)
    ctx.log(f"Rendered {len(result.views)} view(s) at {preset.width_px}x{preset.height_px}" + (", GLB" if glb_key else "") + (", MP4" if mp4_key else ""))
    return Output(views=views, glb_key=glb_key, mp4_key=mp4_key, width_px=preset.width_px, height_px=preset.height_px, console=result.console[:50], model_mm=result.model_mm)
