"""trim_artwork: render the front panel's printable design (spec 2.1 a, b, f)."""

from app.steps import trim_artwork as impl
from app.workflow.context import StepContext

Output = impl.TrimArtworkOutput


def run(ctx: StepContext) -> Output:
    f = ctx.job.file
    inp = impl.TrimArtworkInput(pdf_path=ctx.local_file(f), filename=f.filename, panel="front", key_prefix=ctx.prefix)
    out = impl.run(inp, ctx.index.pdf_profile(), ctx.storage)
    for w in out.warnings:  # a layered file that is not an ArtPro+ export: read anyway, differences on record
        ctx.log(w, "warning")
    if out.mode == "layers" and out.layers_rendered:
        ctx.log(f"Artwork layer(s): {', '.join(out.layers_rendered)}", "audit", {"layers": out.layers, "mode": out.mode})
    ctx.log(f"Front artwork {out.bleed_px[0]}x{out.bleed_px[1]} px, TrimBox {out.trim_width_mm} x {out.trim_height_mm} mm")
    return out
