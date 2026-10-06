"""extract_specs: read the spec table and dimension labels (spec 2.2). Validation is the next step."""

from app.ocr import ai_table
from app.steps import extract_specs as impl
from app.steps import trim_artwork as trim_impl
from app.workflow.context import StepContext

Output = impl.ExtractSpecsOutput


def _model(ctx: StepContext, reader: str) -> str:
    return ctx.settings.groq_model if reader == "groq" else reader


def _xml_fields(ctx: StepContext) -> dict[str, str]:
    """The item's specs from an SAP item-master XML uploaded for its item code (any batch, newest first)."""
    from sqlalchemy import select

    from app.models import UploadedFile
    from app.services.xml_spec_parser import parse_xml_specs

    code = (ctx.job.item_code or "").upper()
    if not code:
        return {}
    for f in ctx.session.scalars(select(UploadedFile).where(UploadedFile.item_code == code, UploadedFile.filename.ilike("%.xml"))
                                 .order_by(UploadedFile.id.desc())):
        try:
            fields = parse_xml_specs(ctx.storage.get_bytes(f.storage_key)).get(code)
        except FileNotFoundError:
            continue
        if fields:
            return fields
    return {}


def run(ctx: StepContext) -> Output:
    f = ctx.job.file
    trim = ctx.output("trim_artwork", trim_impl.TrimArtworkOutput)
    inp = impl.ExtractSpecsInput(pdf_path=ctx.local_file(f), filename=f.filename, key_prefix=ctx.prefix,
                                 trim_width_mm=trim.trim_width_mm, trim_height_mm=trim.trim_height_mm,
                                 sheet_image_key=trim.bleed_key, corrections=ctx.inputs.get("spec_corrections") or {},
                                 xml_fields=ctx.inputs.get("xml_fields") or _xml_fields(ctx))
    out = impl.run(inp, ctx.index.pdf_profile(), ctx.index.validation_rules(), ctx.storage, ctx.settings)
    t = out.sheet.spec_table
    ctx.job.client_name = t.client_name.value
    ctx.job.item_code = ctx.job.item_code or t.item_no.value
    low = [n for n, c in out.cells.items() if c.confidence < ctx.index.validation_rules().min_confidence]
    how = ("from the item master XML (the table was not read)" if out.text_source == "xml"
           else "from the PDF's text" if out.text_source == "pdf_text"
           else f"by the {out.text_source} AI model ({_model(ctx, out.text_source)})" if out.text_source in ai_table.READERS
           else "nowhere (no text layer, OCR off)" if out.text_source == "none"
           else f"with Tesseract {out.tesseract_version}")
    ctx.log(f"Spec table read {how}; {len(low)} weak field(s)", data={"weak": low, "mode": out.mode})
    from_xml = sorted(n for n, c in out.cells.items() if c.source == "xml")
    if from_xml:
        ctx.log(f"{len(from_xml)} spec value(s) from the item master XML: " + ", ".join(from_xml), "audit")
    if out.layout.kind == "multi":
        parts = ", ".join(f"{p.role or p.kind} {p.width_mm:g} x {p.height_mm:g} mm at y {p.y_mm:g}"
                          + (" (upside down)" if p.rotation == 180 else "") for p in out.layout.panels)
        ctx.log(f"Sheet carries {len(out.layout.panels)} panels" + (f" ({out.layout.ups} ups across, the first is used)" if out.layout.ups > 1 else "")
                + f": {parts}", "audit", {"layout": out.layout.model_dump(), "front_words": out.layout.front_words})
    elif out.layout_problem:
        ctx.log(out.layout_problem, "warning")
    return out
