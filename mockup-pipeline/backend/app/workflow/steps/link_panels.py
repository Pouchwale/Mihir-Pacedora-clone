"""link_panels (spec 2.3): find every required panel's PDF in the file registry and render it.

The front is the job's own PDF. A PDF whose sheet carries several panels (extract_specs found e.g.
front + gusset + back on its dieline) supplies them itself: each is cut from the sheet render and
turned upright; the gusset is named by its size against the pouch type's panels. Remaining roles come
from the "<Panel> Code : FGPOxxxx" pairs in the
Remarks (with the pouch type's panel aliases, e.g. one "Side" PDF for both side gussets). Each
linked PDF goes through the same checks and rendering as the front (spec 2.1) and its dieline is
measured for its bleed. A panel drawn rotated (e.g. a 240 x 120 gusset exported as 120 x 240) is
detected from its TrimBox and turned upright later.

Missing required panel -> NEEDS_REVIEW listing what is missing. The operator uploads the PDF or
picks a substitute per panel (job.inputs["panel_choices"][role]):
  {"file_id": n}            use this uploaded file
  {"substitute": "front"}   reuse the front artwork (e.g. for a back that repeats the front)
  {"substitute": "plain", "color": "#rrggbb"}   unprinted film in one colour

Job-page adjustments (app.workflow.adjust) choose a panel's source the same way, for the front too:
an uploaded image, or a PDF whose page is not a dieline panel of this size, becomes an "image"
panel that the texture step fits to the panel (cover / contain / stretch).
"""

from typing import Literal

from pydantic import BaseModel
from sqlalchemy import select

from app.errors import NeedsReview
from app.geometry.panels import panel_sizes
from app.geometry.sheet_layout import SheetLayout
from app.index.schemas import PouchType
from app.models import UploadedFile
from app.pdf.layers import Box
from app.steps import extract_specs as extract_impl
from app.steps import trim_artwork as trim_impl
from app.steps.trim_artwork import Sides
from app.workflow import panel_art
from app.workflow.adjust import PanelAdjust, adjustments
from app.workflow.context import StepContext
from app.workflow.steps.match_pouch_type import Output as MatchOutput
from app.workflow.steps.resolve_keyline import Output as KeylineOutput
from app.workflow.steps.validate import Output as ValidateOutput

BLEED_SLACK_MM = 25.0  # TrimBox may exceed the finished panel by at most this much per axis
SIZE_TOL_MM = 1.0  # a panel on a sheet matches a pouch type's panel of this size


class Panel(BaseModel):
    role: str
    # file: its own PDF; sheet: cut from the job's sheet; blank: cut from a pillow blank on the sheet
    # (front = middle strip, back = the outer strips joined); front: the front's artwork; plain: colour;
    # image: an uploaded picture (or PDF page) fitted to the panel by the texture step
    source: Literal["file", "sheet", "blank", "front", "plain", "image"]
    expected_mm: tuple[float, float]
    file_id: int | None = None
    item_code: str | None = None
    filename: str | None = None
    trim: trim_impl.TrimArtworkOutput | None = None
    bleed: Sides | None = None
    bleed_source: str | None = None  # measured / trimbox / sheet
    rotated: bool = False  # drawn rotated 90 degrees in its PDF
    rotation: int | None = None  # degrees counter-clockwise that turn it upright (sheet panels); None = from `rotated`
    color: str | None = None
    clear: bool = False  # plain: transparent unprinted film, not an opaque colour

    @property
    def turn(self) -> int:
        return self.rotation if self.rotation is not None else (90 if self.rotated else 0)


class Output(BaseModel):
    panels: dict[str, Panel]
    required: list[str]
    confirmed_codes: dict[str, str]  # role -> item code found in the registry


def _latest_file(ctx: StepContext, code: str) -> UploadedFile | None:
    return ctx.session.scalar(select(UploadedFile).where(UploadedFile.item_code == code.upper()).order_by(UploadedFile.id.desc()))


# Words in a file name that say which panel a PDF uploaded with the job carries.
_ROLE_WORDS = {"back": ("back",), "gusset": ("gusset", "bottom"), "side_left": ("gusset", "side"), "side_right": ("gusset", "side")}


def _batch_file(ctx: StepContext, role: str) -> UploadedFile | None:
    """A PDF uploaded together with the job's own (same batch) whose name names `role`: two PDFs
    uploaded at once link without a code in the remarks (FGPO4002 front & back + FGPO4003 gusset)."""
    words = _ROLE_WORDS.get(role)
    if not words or ctx.job.file.batch_id is None:
        return None
    for f in ctx.session.scalars(select(UploadedFile).where(UploadedFile.batch_id == ctx.job.file.batch_id,
                                                             UploadedFile.id != ctx.job.file_id).order_by(UploadedFile.id)):
        name = f.filename.lower()
        if any(w in name for w in words) and "front" not in name:
            return f
    return None


def _next_code_file(ctx: StepContext, role: str) -> UploadedFile | None:
    """The back of a front uploaded alone: approval PDFs come in pairs numbered one after the other
    (FGPO7002 front, FGPO7003 back), so the latest upload with the next item code whose name says
    "back" is this job's back."""
    import re

    m = re.fullmatch(r"([A-Za-z]+)(\d+)", ctx.job.item_code or "")
    if role != "back" or not m:
        return None
    f = _latest_file(ctx, f"{m.group(1)}{int(m.group(2)) + 1:0{len(m.group(2))}d}")
    return f if f is not None and "back" in f.filename.lower() and "front" not in f.filename.lower() else None


def _front_colour(ctx: StepContext, trim: trim_impl.TrimArtworkOutput) -> str:
    """Dominant colour of the front's border (not the average, which mixes e.g. gold and navy into
    brown): a sensible colour for a plain substitute gusset or side."""
    import io
    from collections import Counter

    from PIL import Image

    img = Image.open(io.BytesIO(ctx.storage.get_bytes(trim.bleed_key))).convert("RGB")
    img.thumbnail((400, 400))
    w, h = img.size
    border = [img.getpixel((x, y)) for x in range(0, w, 2) for y in (*range(0, h // 12), *range(h - h // 12, h))]
    border += [img.getpixel((x, y)) for y in range(0, h, 2) for x in (*range(0, w // 12), *range(w - w // 12, w))]
    counts = Counter((r // 16, g // 16, b // 16) for r, g, b in border)
    bucket = counts.most_common(1)[0][0]
    members = [p for p in border if (p[0] // 16, p[1] // 16, p[2] // 16) == bucket]
    r, g, b = (sum(c[i] for c in members) // len(members) for i in range(3))
    return f"#{r:02x}{g:02x}{b:02x}"


def run(ctx: StepContext) -> Output:
    sheet = ctx.output("validate", ValidateOutput).sheet
    type_key = ctx.output("match_pouch_type", MatchOutput).pouch_type
    pouch: PouchType = ctx.index.get("pouch_type", type_key)  # type: ignore[assignment]
    keyline = ctx.output("resolve_keyline", KeylineOutput).keyline.values()
    front_trim = ctx.output("trim_artwork", trim_impl.TrimArtworkOutput)
    profile = ctx.index.pdf_profile()
    spec = {n: getattr(f, "value", None) for n, f in sheet.spec_table}
    spec["gusset_type"] = getattr(spec.get("gusset_type"), "value", spec.get("gusset_type"))
    sizes = panel_sizes(pouch.geometry_template, pouch.base_geometry, spec, keyline)
    required = list(dict.fromkeys(pouch.required_panels))
    wanted = list(dict.fromkeys([*required, *[r for r in pouch.optional_panels if r not in required]]))
    choices = dict(ctx.inputs.get("panel_choices") or {})
    # Job-page adjustments: a panel's artwork source chosen by the operator (or saved for the item).
    adj = adjustments(ctx)
    for role, pa in adj.panels.items():
        if pa.source == "file" and pa.file_id:
            choices[role] = {"file_id": pa.file_id}
        elif pa.source in ("front", "plain"):
            choices[role] = {"substitute": pa.source, "color": pa.color or adj.material.plain_color}

    # linked code per role, following aliases ("side" -> side_left + side_right)
    codes: dict[str, str] = {}
    for role, code in sheet.linked_codes.items():
        for target in [role, *pouch.panel_aliases.get(role, [])]:
            codes.setdefault(target, code)

    extracted = ctx.output("extract_specs", extract_impl.ExtractSpecsOutput)
    panels: dict[str, Panel] = {}
    swapped: dict[str, str] = {}
    if pouch.geometry_template == "roll_stock":
        # Roll form: the job's PDF is one print repeat; the sachet's front and back are cut from it in
        # the texture step, so no other panel PDF is needed.
        rep, web = sizes["roll"]
        tw, th = front_trim.trim_width_mm, front_trim.trim_height_mm
        fits = lambda a, b: abs(tw - a) <= SIZE_TOL_MM and abs(th - b) <= SIZE_TOL_MM  # noqa: E731
        rotation = 0 if fits(rep, web) or not fits(web, rep) else 90
        if not fits(rep, web) and not fits(web, rep):
            ctx.log(f"roll: the dieline is {tw} x {th} mm, the table implies a repeat of {rep:g} x web {web:g} mm; the dieline is used", "warning")
            sizes["roll"] = (tw, th)
        panels["roll"] = Panel(role="roll", source="sheet", expected_mm=sizes["roll"], file_id=ctx.job.file_id, item_code=ctx.job.item_code,
                               filename=ctx.job.file.filename, trim=front_trim.model_copy(update={"panel": "roll"}), bleed=Sides.uniform(0),
                               bleed_source="sheet", rotation=rotation)
        ctx.log(f"roll: one print repeat {sizes['roll'][0]:g} x {sizes['roll'][1]:g} mm" + (f", {extracted.repeats} repeats on the sheet" if extracted.repeats > 1 else ""), "audit")
        return Output(panels=panels, required=["roll"], confirmed_codes={})
    if extracted.layout.kind == "multi" and extracted.sheet_box_pt:
        layout = extracted.layout
        if adj.swap_front_back:
            swapped = {"front": "back", "back": "front"}
            for p in layout.panels:
                p.role = {"front": "back", "back": "front"}.get(p.role or "", p.role)
            ctx.log("front and back swapped by the operator", "audit")
        panels = _sheet_panels(ctx, layout, extracted.sheet_box_pt, front_trim, sizes, wanted)
        for role, pa in adj.panels.items():
            if pa.source == "sheet" and pa.sheet_panel is not None and pa.sheet_panel < len(layout.panels) and role in sizes:
                sp = layout.panels[pa.sheet_panel]
                crop = trim_impl.crop_panel(front_trim, role, extract_impl.panel_box(Box(*extracted.sheet_box_pt), sp), ctx.storage)
                panels[role] = Panel(role=role, source="sheet", expected_mm=sizes[role], file_id=ctx.job.file_id, item_code=ctx.job.item_code,
                                     filename=ctx.job.file.filename, trim=crop, bleed=Sides.uniform(0), bleed_source="sheet",
                                     rotation=sp.rotation if sp.kind == "face" else 0)
                ctx.log(f"{role}: sheet panel {pa.sheet_panel + 1} chosen by the operator", "audit")
    for role in [r for r, pa in adj.panels.items() if pa.source in ("file", "front", "plain")]:
        panels.pop(role, None)  # the operator's choice replaces what the sheet supplied
    confirmed: dict[str, str] = {}
    missing: dict[str, str | None] = {}
    for role in wanted:
        expected = sizes.get(role)
        if expected is None or role in panels:
            continue
        choice = choices.get(role) or {}
        # swapped with only one face on the sheet (FGPO6784 + its back PDF): the other face's file
        src = swapped.get(role, role)
        if role == "front" and not choice.get("file_id") and src == role:
            panels[role] = Panel(role=role, source="file", expected_mm=expected, file_id=ctx.job.file_id, item_code=ctx.job.item_code,
                                 filename=ctx.job.file.filename, trim=front_trim)
            continue
        f = None
        if choice.get("file_id"):
            f = ctx.session.get(UploadedFile, int(choice["file_id"]))
            if f is None:
                raise NeedsReview("panel_file_missing", f"{role}: uploaded file {choice['file_id']} is gone; upload it again or pick a substitute", {
                    "form": "panels", "missing": [{"role": role, "code": codes.get(role), "expected_mm": expected}], "found": {},
                })
            # Job-page uploads: a picture is fitted to the panel; a PDF is used as a dieline panel when it
            # is one of this size, else its page is fitted like a picture.
            from_job_page = adj.panels.get(role, PanelAdjust()).source == "file"
            if panel_art.kind_of(f.filename) == "image":
                panels[role] = Panel(role=role, source="image", expected_mm=expected, file_id=f.id, filename=f.filename)
                ctx.log(f"{role}: picture {f.filename} chosen by the operator, fitted to the {expected[0]:g} x {expected[1]:g} mm panel", "audit",
                        {"sha256": f.sha256})
                continue
            if from_job_page:
                try:
                    panels[role] = _render_linked(ctx, role, f, expected, profile)
                except (NeedsReview, RuntimeError) as exc:
                    reason = exc.message if isinstance(exc, NeedsReview) else str(exc)
                    panels[role] = Panel(role=role, source="image", expected_mm=expected, file_id=f.id, filename=f.filename)
                    ctx.log(f"{role}: {f.filename} is not a dieline panel of this size ({reason}); its page is fitted to the panel like a picture", "warning")
                continue
        elif choice.get("substitute") in ("front", "plain"):
            color = choice.get("color") or _front_colour(ctx, front_trim)
            panels[role] = Panel(role=role, source=choice["substitute"], expected_mm=expected, color=color)
            ctx.log(f"{role}: substitute '{choice['substitute']}' chosen by operator", "audit")
            continue
        elif src in codes:
            f = _latest_file(ctx, codes[src])
        if f is None and src not in codes:
            f = _batch_file(ctx, src)
            if f is not None:
                ctx.log(f"{role}: {f.filename} uploaded with this job, linked by its name", "audit")
            elif (f := _next_code_file(ctx, src)) is not None:
                ctx.log(f"{role}: {f.filename} ({f.item_code}) found among earlier uploads: the item code after this job's, named \"{src}\"", "audit")
        if f is None and role in ("gusset", "bottom", "side_left", "side_right"):
            plain = _plain_label(ctx.local_file(ctx.job.file), front_trim, "gusset" if role != "bottom" else role)
            if plain is not None:
                # the job's own sheet says what this panel is (FGPO3974: a separate "White Gusset" drawing)
                label, colour, clear = plain
                panels[role] = Panel(role=role, source="plain", expected_mm=expected, color=colour, clear=clear)
                ctx.log(f"{role}: the sheet marks it \"{label}\": plain {'clear' if clear else colour} film, no artwork PDF needed", "audit")
                continue
            if profile.plain_missing_gussets:
                colour = _front_colour(ctx, front_trim)
                panels[role] = Panel(role=role, source="plain", expected_mm=expected, color=colour)
                ctx.log(f"{role}: no artwork for it in the uploaded PDFs; shown as plain {colour} film (the front's colour). "
                        "Upload its PDF on the job page to replace it", "warning")
                continue
        if f is None:
            if role in required:
                missing[role] = codes.get(src)
            continue
        if panel_art.kind_of(f.filename) == "image":  # (the registry holds PDFs; a picture only gets here by id)
            panels[role] = Panel(role=role, source="image", expected_mm=expected, file_id=f.id, filename=f.filename)
            continue
        if src in codes and f.item_code == codes[src]:
            confirmed[role] = f.item_code
        # Not usable (not a single-page approval PDF, no dieline, file gone from storage, ...): the
        # operator picks another file or a substitute for this panel on the panels form.
        def unusable(code: str, message: str, problems: list) -> NeedsReview:
            return NeedsReview(code, f"{role} PDF {f.filename}: {message}", {
                "form": "panels",
                "missing": [{"role": role, "code": codes.get(role), "expected_mm": expected}],
                "found": {r: {"filename": p.filename, "source": p.source} for r, p in panels.items()},
                "default_color": _front_colour(ctx, front_trim),
                "problems": problems,
            })

        try:
            panels[role] = _render_linked(ctx, role, f, expected, profile, like=panels.get("front") if role != "front" else panels.get("back"))
        except NeedsReview as exc:
            if exc.details.get("form") == "panels":
                raise
            raise unusable(exc.code, exc.message, exc.details.get("problems", [])) from exc
        except FileNotFoundError as exc:
            raise unusable("panel_file_missing", "the stored file is missing; upload it again or pick a substitute", []) from exc

    if missing:
        raise NeedsReview(
            "missing_panels",
            "Missing panel PDF(s): " + ", ".join(f"{r} ({c})" if c else r for r, c in missing.items()),
            {
                "form": "panels",
                "missing": [{"role": r, "code": c, "expected_mm": sizes.get(r)} for r, c in missing.items()],
                "found": {r: {"filename": p.filename, "source": p.source} for r, p in panels.items()},
                "default_color": _front_colour(ctx, front_trim),
            },
        )
    for role, code in confirmed.items():
        ctx.log(f"Linked {role} code {code} confirmed by the file registry", "audit")
    return Output(panels=panels, required=required, confirmed_codes=confirmed)


def _sheet_panels(ctx: StepContext, layout: SheetLayout, sheet_box: tuple, front_trim: trim_impl.TrimArtworkOutput,
                  sizes: dict[str, tuple[float, float]], wanted: list[str]) -> dict[str, Panel]:
    """Panels printed on the job's own sheet, cut from its render (bleed 0: the cut is the dieline)."""
    box = Box(*sheet_box)
    front = layout.face("front")
    out: dict[str, Panel] = {}
    others = [r for r in wanted if r not in ("front", "back") and r in sizes]

    def close(a: tuple[float, float], b: tuple[float, float]) -> bool:
        return abs(a[0] - b[0]) <= SIZE_TOL_MM and abs(a[1] - b[1]) <= SIZE_TOL_MM

    blank = layout.blank()
    if blank is not None:
        # One pillow blank supplies both faces; the texture step splits it at the fin seal.
        crop = trim_impl.crop_panel(front_trim, "blank", extract_impl.panel_box(box, blank), ctx.storage)
        for role in ("front", "back"):
            if role in sizes:
                out[role] = Panel(role=role, source="blank", expected_mm=sizes[role], file_id=ctx.job.file_id, item_code=ctx.job.item_code,
                                  filename=ctx.job.file.filename, trim=crop, bleed=Sides.uniform(0), bleed_source="sheet", rotation=blank.rotation)
        ctx.log(f"front and back: cut from the first of {sum(1 for p in layout.panels if p.kind == 'blank')} pillow blank(s) on the sheet, "
                f"{blank.width_mm:g} x {blank.height_mm:g} mm at {blank.x_mm:g}, {blank.y_mm:g} mm" + (f", turned {blank.rotation} degrees" if blank.rotation else ""), "audit")
        return out

    for p in layout.panels:
        size = (p.width_mm, p.height_mm)
        role, rotation = p.role, p.rotation
        if p.kind == "gusset" and p.role in others and p.role not in out:
            pass  # named by the sheet layout (a side-by-side web in process colours); its drawn size includes the seals
        elif p.kind == "gusset":
            role = next((r for r in others if r not in out and (close(size, sizes[r]) or close(size[::-1], sizes[r]))), None)
            if role is None:
                continue
            if not close(size, sizes[role]):
                rotation = 90  # drawn across the web: turn it to the pouch type's orientation
            elif layout.axis == "vertical" and front is not None and front.rotation == 180:
                rotation = 180  # its edge that joins the front becomes the top edge, as for a gusset PDF
        if role is None or role not in sizes or role in out:
            continue
        crop = trim_impl.crop_panel(front_trim, role, extract_impl.panel_box(box, p), ctx.storage)
        out[role] = Panel(role=role, source="sheet", expected_mm=sizes[role], file_id=ctx.job.file_id, item_code=ctx.job.item_code,
                          filename=ctx.job.file.filename, trim=crop, bleed=Sides.uniform(0), bleed_source="sheet", rotation=rotation)
        ctx.log(f"{role}: cut from the sheet, {p.width_mm:g} x {p.height_mm:g} mm at {p.x_mm:g}, {p.y_mm:g} mm"
                + (f", turned {rotation} degrees" if rotation else ""), "audit")
    return out


def _plain_label(pdf, trim: trim_impl.TrimArtworkOutput, panel_word: str) -> tuple[str, str, bool] | None:
    """A "<colour> Gusset" label beside the artwork (FGPO3974: a separate drawing of the gusset marked
    "White Gusset"): (label, colour hex, clear). The colour word sits just before the panel word or
    directly above it; any CSS colour name counts, "clear" / "transparent" / "window" mean clear film.
    Read from the PDF's live text, or by OCR of the page when the file is fully outlined."""
    import pymupdf
    from PIL import Image, ImageColor

    from app.ocr import pdf_text, tesseract
    from app.pdf.layers import read_facts

    words = pdf_text.words(pdf, read_facts(pdf).media_box, 72)
    if not words:
        doc = pymupdf.open(pdf)
        try:
            pix = doc[0].get_pixmap(dpi=110, colorspace=pymupdf.csGRAY)
            words = tesseract.words(Image.frombytes("L", (pix.width, pix.height), pix.samples), psm=11)
        finally:
            doc.close()
    for g in (w for w in words if w.text.strip(".:").lower() == panel_word):
        for w in words:
            before = abs(w.top - g.top) <= g.height / 2 and 0 <= g.left - (w.left + w.width) <= 1.5 * g.height
            above = 0 <= g.top - (w.top + w.height) <= 1.5 * g.height and w.left < g.left + g.width and g.left < w.left + w.width
            name = w.text.strip(".:").lower()
            if not (before or above) or w is g:
                continue
            if name in ("clear", "transparent", "window"):
                return f"{w.text} {g.text}", "#ffffff", True
            try:
                r, gr, b = ImageColor.getrgb(name)[:3]
            except ValueError:
                continue
            return f"{w.text} {g.text}", f"#{r:02x}{gr:02x}{b:02x}", False
    return None


def _window_label(ctx: StepContext, pdf, trim: trim_impl.TrimArtworkOutput) -> bool:
    """The panel artwork carries the word "Window": the designer's mark for clear film. Read from the
    PDF's live text, or by OCR when the file is fully outlined (FGPO4003 Cashews: no text at all);
    the label may run up or down the panel."""
    import io

    from PIL import Image

    from app.ocr import pdf_text, tesseract
    from app.pdf.layers import read_facts

    box = read_facts(pdf).trim_box
    if box is None:
        return False
    live = pdf_text.words(pdf, box, 72)
    if live:
        return any(w.text.strip(".:").lower() == "window" for w in live)
    img = Image.open(io.BytesIO(ctx.storage.get_bytes(trim.bleed_key))).convert("L")
    img.thumbnail((1400, 1400))
    for angle in (0, 90, 270):
        if any("window" in w.text.lower() for w in tesseract.words(img.rotate(angle, expand=True), psm=11)):
            return True
    return False


UPS_MARGIN_MM = 6.0  # bleed / gap a side-by-side up may carry beyond the finished panel width


def _colours(image) -> list[float]:
    """Coarse colour histogram (4 x 4 x 4 bins, normalised) of an artwork image."""
    small = image.convert("RGB").resize((48, 48))
    bins = [0.0] * 64
    for r, g, b in small.getdata():
        bins[(r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)] += 1 / (48 * 48)
    return bins


def _matching_up(ctx: StepContext, role: str, f: UploadedFile, pdf, trim: trim_impl.TrimArtworkOutput,
                 expected: tuple[float, float], profile, like: "Panel | None") -> "Panel | None":
    """One pouch out of a linked PDF that carries several side by side (FGPO6753: the backs of two
    designs, Dishwash | Liquid Detergent, 2 x 168 mm). Which one: the up whose colours are closest to
    the panel it pairs with (`like`, the front); when they do not tell the ups apart, the mirrored
    position (front and back webs face each other, and the job's front is the first up of its sheet)."""
    import io
    import tempfile
    from pathlib import Path

    from PIL import Image

    from app.pdf.layers import PT_TO_MM
    from app.pdf.sheet import analyse
    from app.pdf.vector import dieline

    w, h = expected
    tw, th = trim.trim_width_mm, trim.trim_height_mm
    if tw < w or th < h:
        return None
    sheet = analyse(pdf, profile)
    with tempfile.TemporaryDirectory() as tmp:
        vec = extract_impl.vectors(pdf, profile, sheet, Path(tmp))
        lines = dieline(vec.pdf, vec.layers, sheet.drawing_box(sheet.trim))

    def snap(at: float, size: float, values: list[float]) -> float:
        """The drawn cut line near `at` that has its partner `size` further on, else `at` itself."""
        near = [a for a in values if abs(a - at) <= 1.5 and any(abs(b - a - size) <= 0.5 for b in values)]
        return min(near, key=lambda a: abs(a - at)) if near else at

    def starts(size: float, values: list[float]) -> list[float]:
        """Where a panel of `size` starts: every drawn line with a partner `size` further on."""
        return sorted(a for a in values if any(abs(b - a - size) <= 0.5 for b in values))

    # drawn cut-line pairs (FGPO7166: 4 gussets across, 2 down); a sheet whose lines are missing for
    # some ups (FGPO6753) is split evenly instead
    xs, ys = starts(w, lines.x_mm), starts(h, lines.y_mm)
    n = round(tw / w)
    if len(xs) < n and 2 <= n <= 4 and 0 <= tw - n * w <= n * UPS_MARGIN_MM:
        xs = [snap(k * tw / n + (tw / n - w) / 2, w, lines.x_mm) for k in range(n)]
    if not ys and 0 <= th - h <= BLEED_SLACK_MM:
        ys = [snap((th - h) / 2, h, lines.y_mm)]
    if len(xs) * len(ys) < 2:
        return None
    t = Box(*trim.trim_box_pt)
    boxes = [Box(t.x0 + x / PT_TO_MM, t.y1 - (y + h) / PT_TO_MM, t.x0 + (x + w) / PT_TO_MM, t.y1 - y / PT_TO_MM) for y in ys for x in xs]
    n = len(boxes)
    # a back sits in the mirrored position of the front's first up; anything else defaults to the first
    pick, why = (len(xs) - 1, "the mirrored position of the front's first up") if like is not None and role == "back" else (0, "the first")
    if like is not None and like.trim is not None:
        full = Image.open(io.BytesIO(ctx.storage.get_bytes(trim.bleed_key)))
        px = full.width / (t.x1 - t.x0)
        want = _colours(Image.open(io.BytesIO(ctx.storage.get_bytes(like.trim.bleed_key))))
        scores = []
        for b in boxes:
            up = full.crop((round((b.x0 - t.x0) * px), round((t.y1 - b.y1) * px), round((b.x1 - t.x0) * px), round((t.y1 - b.y0) * px)))
            scores.append(sum(min(a, c) for a, c in zip(want, _colours(up))))
        best = max(range(n), key=lambda k: scores[k])
        if scores[best] - sorted(scores)[-2] >= 0.1:
            pick, why = best, f"its colours match the {like.role} ({scores[best]:.2f} against {sorted(scores)[-2]:.2f})"
    crop = trim_impl.crop_panel(trim, role, boxes[pick], ctx.storage)
    ctx.log(f"{role}: {f.filename} ({f.item_code}) carries {n} panels of this size ({len(xs)} across, {len(ys)} down); "
            f"number {pick % len(xs) + 1} from the left, row {pick // len(xs) + 1}, is used: {why}", "audit",
            {"sha256": f.sha256, "ups": n, "up": pick + 1})
    return Panel(role=role, source="file", expected_mm=expected, file_id=f.id, item_code=f.item_code, filename=f.filename,
                 trim=crop, bleed=Sides.uniform(0), bleed_source="sheet")


def _render_linked(ctx: StepContext, role: str, f: UploadedFile, expected: tuple[float, float], profile, like: "Panel | None" = None) -> Panel:
    pdf = ctx.local_file(f)
    trim = trim_impl.run(trim_impl.TrimArtworkInput(pdf_path=pdf, filename=f.filename, panel=role, key_prefix=ctx.prefix), profile, ctx.storage)
    w, h = expected
    tw, th = trim.trim_width_mm, trim.trim_height_mm
    if role not in ("front", "back") and _window_label(ctx, pdf, trim):
        # A side / gusset drawn only as a "Window" placeholder (FGPO4003: two grey gussets on clear
        # LDPE): unprinted clear film, as tall as its own drawing.
        ctx.log(f"{role}: {f.filename} marks the panel \"Window\": clear film, {w:g} x {th:g} mm", "audit")
        return Panel(role=role, source="plain", expected_mm=(w, th), file_id=f.id, item_code=f.item_code, filename=f.filename,
                     color="#ffffff", clear=True)
    fits = lambda a, b: 0 <= tw - a <= BLEED_SLACK_MM and 0 <= th - b <= BLEED_SLACK_MM  # noqa: E731
    if fits(w, h):
        rotated, mw, mh = False, w, h
    elif fits(h, w):
        rotated, mw, mh = True, h, w
    elif (up := _matching_up(ctx, role, f, pdf, trim, expected, profile, like)) is not None:
        return up
    else:
        raise NeedsReview("panel_size", f"{role} PDF {f.filename} is {tw} x {th} mm; expected a {w} x {h} mm panel plus bleed", {
            "form": "panels", "missing": [{"role": role, "code": f.item_code, "expected_mm": expected}], "found": {},
        })
    measured = extract_impl.measure_panel(pdf, profile, mw, mh, ctx.index.validation_rules().dimension_tolerance_mm)
    vals = [measured.bleed_left_mm.value, measured.bleed_right_mm.value, measured.bleed_top_mm.value, measured.bleed_bottom_mm.value]
    if all(v is not None for v in vals):
        bleed, source = Sides(left=vals[0], right=vals[1], top=vals[2], bottom=vals[3]), "measured"
    else:
        bx, by = (tw - mw) / 2, (th - mh) / 2
        bleed, source = Sides(left=bx, right=bx, top=by, bottom=by), "trimbox"
        ctx.log(f"{role}: dieline not measurable, bleed split evenly from the TrimBox ({bx:.3f} / {by:.3f} mm)", "warning")
    ctx.log(f"{role}: {f.filename} ({f.item_code}) {tw} x {th} mm{' rotated' if rotated else ''}, bleed {source}", "audit",
            {"sha256": f.sha256, "bleed": bleed.model_dump()})
    return Panel(role=role, source="file", expected_mm=expected, file_id=f.id, item_code=f.item_code, filename=f.filename,
                 trim=trim, bleed=bleed, bleed_source=source, rotated=rotated)
