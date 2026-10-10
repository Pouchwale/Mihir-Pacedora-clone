"""export: name the outputs with the preset's pattern and record the downloadable file list.

The ZIP itself is assembled on download (so it always carries the current audit, including who
approved the job); this step fixes the file names and writes the audit record.
"""

import json
import re
from datetime import date

from pydantic import BaseModel

from app import activity
from app.workflow.context import StepContext
from app.workflow.steps.build_geometry import Output as GeometryOutput
from app.workflow.steps.render import Output as RenderOutput
from app.workflow.steps.texture import Output as TextureOutput
from app.workflow.steps.validate import Output as ValidateOutput


class ExportFile(BaseModel):
    name: str  # file name inside the download
    key: str  # storage key
    kind: str  # render, model, video, texture, keyline, data


class Output(BaseModel):
    files: list[ExportFile]


def slug(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-") or "unknown"


def run(ctx: StepContext) -> Output:
    geo_out = ctx.output("build_geometry", GeometryOutput)
    geo, preset = geo_out.geometry, geo_out.geometry.preset
    renders = ctx.output("render", RenderOutput)
    textures = ctx.output("texture", TextureOutput).textures
    sheet = ctx.output("validate", ValidateOutput).sheet
    t = sheet.spec_table
    values = {
        "item_no": t.item_no.value or ctx.job.item_code or "item", "client": slug(t.client_name.value),
        "pouch_type": geo.template, "item_name": slug(t.item_name.value), "date": date.today().isoformat(),
    }

    def name(view: str, fmt: str) -> str:
        pattern = preset.naming_pattern
        n = pattern.format(**values, view=view, format=fmt)
        if not n.lower().endswith(f".{fmt}"):
            n = re.sub(r"\.[a-z0-9]+$", "", n) + f".{fmt}"
        return n

    files: list[ExportFile] = []
    for view, key in renders.views.items():
        files.append(ExportFile(name=f"renders/{name(view, 'png')}", key=key, kind="render"))
    if renders.glb_key:
        files.append(ExportFile(name=f"model/{name('3d', 'glb')}", key=renders.glb_key, kind="model"))
    if renders.mp4_key:
        files.append(ExportFile(name=f"video/{name('turntable', 'mp4')}", key=renders.mp4_key, kind="video"))
    for role, tex in textures.items():
        role = role.replace("@", "_design")  # (the sheet's other designs: front@2 -> front_design2)
        if tex.finished_key and tex.source in ("file", "image"):
            files.append(ExportFile(name=f"textures/{values['item_no']}_{role}_finished.png", key=tex.finished_key, kind="texture"))
        files.append(ExportFile(name=f"keyline/{values['item_no']}_{role}_keyline.svg", key=tex.preview_key, kind="keyline"))
    files.append(ExportFile(name="data/geometry.json", key=geo_out.geometry_key, kind="data"))
    spec_key = ctx.storage.put_bytes(f"{ctx.prefix}/specs.json", json.dumps(sheet.model_dump(mode="json"), indent=1).encode(), "application/json")
    files.append(ExportFile(name="data/specs.json", key=spec_key, kind="data"))
    ctx.log(f"Export ready: {len(files)} file(s)", "audit", {"files": [f.name for f in files]})
    if ctx.job.kind != "test":  # workflow test runs are not customer mockups
        folder = activity.save_outputs(ctx.job.item_code, ctx.job.id, [(f.name, ctx.storage.get_bytes(f.key)) for f in files])
        if folder:
            ctx.log(f"Mockups saved to {folder}", "info")
    return Output(files=files)
