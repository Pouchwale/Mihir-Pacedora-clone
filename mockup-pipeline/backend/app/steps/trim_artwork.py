"""Step trim_artwork (spec 2.1): the printable design of one panel PDF as an sRGB texture.

`run` renders the bleed image (a, b, f): only the texture layers on, CropBox = MediaBox = TrimBox,
pdftoppm at texture_dpi through the PDF's OutputIntent profile -> <item>_<panel>_bleed.png.
Files without layers (app.pdf.sheet, separation mode) render the dieline's outer rectangle with the
technical ink and varnish removed from the page -> <item>_sheet_bleed.png; the sheet may carry
several panels, which link_panels cuts apart.

`finish` cuts the bleed with the resolved keyline values (c), verifies the result equals the pouch
panel size within tolerance, and runs the technical-colour safety scan (e) ->
<item>_<panel>_finished.png. Seals, zipper, notches and corners are never cut from the image (d);
the 3D geometry shapes them on top of the whole texture.
"""

import hashlib
import io
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from pydantic import BaseModel

from app.errors import NeedsReview
from app.pdf import safety
from app.pdf.layers import Box, output_intent_profile, require_layers, write_layer_copy
from app.pdf.paint import ANNOTATION_RED, flattened_images, paints_annotation_red
from app.pdf.profile import PdfProfile
from app.pdf.render import pdftoppm_png
from app.pdf.vector import render_gray
from app.pdf.sheet import analyse, check_layers_pdf, non_technical_copy, prewarm_non_technical, technical_copy
from app.specs.validate import Issue
from app.storage import Storage

check_pdf = check_layers_pdf  # the spec 2.1 (f) checks for layered files

SAFETY_SCAN_DPI = 100
ANNOTATION_PROBE_DPI, ANNOTATION_MAX_MM = 100, 2.0  # annotation-red paint thicker than this is artwork
KEYLINE_MAX_MM = 0.8  # keyline-coloured paint thicker than this is an area of artwork, not a line
KEYLINE_MIN_RUN_MM = 3.0  # ...and a stray keyline has at least this much in one row or column
EDGE_FRAME_MM = 1.5  # technical marks this close to the cut edge are the dieline frame itself


class Sides(BaseModel):
    left: float
    right: float
    top: float
    bottom: float

    @classmethod
    def uniform(cls, mm: float) -> "Sides":
        return cls(left=mm, right=mm, top=mm, bottom=mm)


class TrimArtworkInput(BaseModel):
    pdf_path: Path
    filename: str
    panel: str  # front, back, gusset, side_left, ...
    key_prefix: str  # storage folder, e.g. "jobs/12"


class TrimArtworkOutput(BaseModel):
    item_code: str | None
    panel: str
    sha256: str
    creator: str
    producer: str
    layers: list[str]
    layers_rendered: list[str]
    trim_box_pt: tuple[float, float, float, float]
    trim_width_mm: float
    trim_height_mm: float
    dpi: int
    bleed_key: str
    bleed_px: tuple[int, int]
    colour_profile: str  # "output_intent" or "poppler_default"
    suppressed_colour_spaces: list[str]
    mode: str = "layers"  # app.pdf.sheet: "layers", "separation" or "page"
    technical_box_pt: tuple[float, float, float, float] | None = None  # separation: dieline + dimension drawing
    repeats: int = 1  # separation: dielines of this size on the sheet
    inks: dict = {}  # the file's hidden plates as classed by the profile: {"white": [...], "varnish": {...}, "technical": [...]}
    warnings: list[str] = []  # layers: what differs from an ArtPro+ export but did not stop the job (renamed artwork layer, producer)

    def technical_inks(self) -> set[str]:
        return set(self.inks.get("technical") or [])


class FinishOutput(BaseModel):
    finished_key: str
    finished_px: tuple[int, int]
    finished_mm: tuple[float, float]
    bleed_mm: Sides
    issues: list[Issue]
    technical_rgb: tuple[int, int, int]
    technical_pixels: dict[str, int]  # {"colour": n, "separation": n}
    preview_key: str | None  # highlighted preview when marks were found


def _name(item: str | None, panel: str, kind: str) -> str:
    return f"{item or 'UNKNOWN'}_{panel}_{kind}.png"


def run(inp: TrimArtworkInput, profile: PdfProfile, storage: Storage) -> TrimArtworkOutput:
    data = inp.pdf_path.read_bytes()
    prewarm_non_technical(inp.pdf_path, profile)
    sheet = analyse(inp.pdf_path, profile)
    facts, trim = sheet.facts, sheet.trim
    item = profile.item_code_from_filename(inp.filename)
    icc = output_intent_profile(inp.pdf_path)
    # Suppress technical dieline inks and varnish from the color artwork render,
    # but do NOT suppress white underlay inks (suppressing white colorants in poppler
    # zeroes out tint transforms, turning spot-color background layers into paper white).
    suppress_artwork = {*sheet.inks.technical, *sheet.inks.varnish}
    annotation = {ANNOTATION_RED} if profile.strip_annotation_red and paints_annotation_red(inp.pdf_path) else set()
    with tempfile.TemporaryDirectory() as tmp:
        red_only = Path(tmp) / "annotation.pdf"  # the annotation paint alone: probed here, rendered again for the fill below
        if annotation:
            # Annotations are thin lines and labels. The same red painted as an area is the design's own
            # colour (FGPO6292: a brand block in C0 M100 Y100 K0) and stays.
            if write_layer_copy(inp.pdf_path, red_only, sheet.texture_layers(profile) if sheet.mode == "layers" else None, trim, only=annotation):
                red = pdftoppm_png(red_only, Path(tmp) / "annotation_probe.png", ANNOTATION_PROBE_DPI, icc).convert("L").point(lambda v: 255 if v < 245 else 0)
                if red.filter(ImageFilter.MinFilter(2 * round(ANNOTATION_MAX_MM / 2 * ANNOTATION_PROBE_DPI / 25.4) + 1)).getbbox():
                    annotation = set()
            else:
                annotation = set()
        strip_artwork = {*sheet.inks.technical, *annotation}
        prepared = Path(tmp) / "artwork.pdf"
        if sheet.mode == "layers":
            layers = sheet.texture_layers(profile)
            require_layers(facts, layers)
            changed = write_layer_copy(inp.pdf_path, prepared, layers, trim, suppress=suppress_artwork, strip=annotation or None)
        else:
            # Technical ink and varnish are painted on top of the artwork: remove them from the page
            # (a "no ink" tint would still knock out white). White underlay prints below: no ink.
            layers = []
            base = non_technical_copy(inp.pdf_path, prepared, sheet.inks.technical) if sheet.inks.technical else inp.pdf_path
            changed = write_layer_copy(base, prepared, None, trim, suppress=suppress_artwork, strip=annotation or None)
            if sheet.inks.technical:
                changed.append("strip:" + "+".join(sorted(sheet.inks.technical)))
        image = pdftoppm_png(prepared, Path(tmp) / "full.png", profile.texture_dpi, icc, exact_size=True)
        if annotation:
            # The artwork under annotation lines is often knocked out: removing the red leaves white
            # hairlines (FGPO4004). Fill where the red was from the artwork around it.
            marks = pdftoppm_png(red_only, Path(tmp) / "annotation.png", profile.texture_dpi, icc, exact_size=True).resize(image.size)
            mask = np.asarray(marks.convert("L")) < 245
            if mask.any():
                image = safety.mask_out(image, mask, radius=4)
        if sheet.mode == "separation" and sheet.inks.technical:
            # Removing the technical ink can leave the dieline behind in two ways: knocked out of the
            # artwork as paper-white hairlines (FGPO6787), or flattened into the artwork's own raster
            # tiles (FGPO6786: images in DeviceN Black/Y/M/C + "Dimensions and text"), which no paint
            # filter can split. Both are filled from the artwork around the thin technical marks.
            if True:
                # the technical paint alone, from the copy the analysis already made
                marks = Image.fromarray(render_gray(technical_copy(inp.pdf_path, Path(tmp) / "technical.pdf", sheet.inks.technical), trim, profile.texture_dpi))
                # (well below white: flattened tiles are JPEG-compressed and speckle their white at 240-250)
                drawn = np.asarray(marks.resize(image.size)) < 200
                # hairlines only: technical paint wider than ~1.2 mm is not a dieline over the art
                thin = safety.thin_parts(drawn, 15)
                if thin.any():
                    filled = safety.mask_out(image, thin, radius=4)
                    if not flattened_images(inp.pdf_path, sheet.inks.technical):
                        # knockouts only: paper white under a mark with coloured artwork around it
                        rgb = np.asarray(image.convert("RGB"))
                        knock = thin & (rgb.min(axis=2) >= 250) & (np.asarray(filled).min(axis=2) < 235)
                        near = np.asarray(Image.fromarray(knock.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(5))) > 0
                        filled = Image.fromarray(np.where(near[..., None], np.asarray(filled), rgb))
                    image = filled

    key = f"{inp.key_prefix}/{_name(item, 'sheet' if sheet.mode == 'separation' else inp.panel, 'bleed')}"
    storage.put_bytes(key, _png_bytes(image), "image/png")
    return TrimArtworkOutput(
        item_code=item,
        panel=inp.panel,
        sha256=hashlib.sha256(data).hexdigest(),
        creator=facts.creator,
        producer=facts.producer,
        layers=facts.layers,
        layers_rendered=layers,
        trim_box_pt=trim.as_tuple(),
        trim_width_mm=round(trim.width_mm, 4),
        trim_height_mm=round(trim.height_mm, 4),
        dpi=profile.texture_dpi,
        bleed_key=key,
        bleed_px=image.size,
        colour_profile="output_intent" if icc else "poppler_default",
        suppressed_colour_spaces=changed,
        mode=sheet.mode,
        technical_box_pt=sheet.technical.as_tuple() if sheet.technical else None,
        repeats=sheet.repeats,
        inks={"white": sorted(sheet.inks.white), "varnish": dict(sheet.inks.varnish), "technical": sorted(sheet.inks.technical)},
        warnings=list(sheet.warnings),
    )


def crop_panel(trimmed: TrimArtworkOutput, panel: str, box: Box, storage: Storage) -> TrimArtworkOutput:
    """One panel of a multi-panel sheet as if it were its own file: its box becomes the TrimBox.

    `box` is in PDF user space inside `trimmed.trim_box_pt`; pixels are cut at the image's own scale.
    """
    full = Image.open(io.BytesIO(storage.get_bytes(trimmed.bleed_key)))
    full.load()
    t = Box(*trimmed.trim_box_pt)
    sx, sy = full.width / (t.x1 - t.x0), full.height / (t.y1 - t.y0)
    if abs(sx - sy) > 0.02 * max(sx, sy):
        # The render is not the box it claims to be (a cut-out stored under the sheet's name): cutting
        # from it would give a panel of the wrong size. Rerun from trim_artwork re-renders the sheet.
        raise RuntimeError(f"{trimmed.bleed_key} is {full.width} x {full.height} px, not the {round(t.width_mm, 2)} x "
                           f"{round(t.height_mm, 2)} mm sheet it was rendered from; rerun the job from trim_artwork")
    x0, y0 = round((box.x0 - t.x0) * sx), round((t.y1 - box.y1) * sy)
    image = full.crop((x0, y0, x0 + round((box.x1 - box.x0) * sx), y0 + round((box.y1 - box.y0) * sy)))
    # Its own name: a layered sheet's full render is "<item>_front_bleed.png", and cutting the front
    # out under that same name would make the next cut (the back, or a rerun) read the cut-out as the
    # whole sheet: half the height, a finished_size stop (FGPO5149).
    key = f"{trimmed.bleed_key.rsplit('/', 1)[0]}/{_name(trimmed.item_code, panel, 'cut')}"
    if key == trimmed.bleed_key:
        raise RuntimeError(f"panel cut would overwrite the sheet render {key}")
    storage.put_bytes(key, _png_bytes(image), "image/png")
    return trimmed.model_copy(update={
        "panel": panel,
        "trim_box_pt": box.as_tuple(),
        "trim_width_mm": round(box.width_mm, 4),
        "trim_height_mm": round(box.height_mm, 4),
        "bleed_key": key,
        "bleed_px": image.size,
    })


def cut_bleed(full_bleed: Image.Image, trim_width_mm: float, trim_height_mm: float, bleed: Sides) -> Image.Image:
    """Crop the bleed so the image covers exactly the finished panel.

    Pixel scale is taken from the image itself (px / TrimBox mm), so rounding in pdftoppm's
    page size never accumulates into an offset.
    """
    sx = full_bleed.width / trim_width_mm
    sy = full_bleed.height / trim_height_mm
    finished_w = trim_width_mm - bleed.left - bleed.right
    finished_h = trim_height_mm - bleed.top - bleed.bottom
    if finished_w <= 0 or finished_h <= 0:
        raise NeedsReview("bleed_too_large", f"Bleed {bleed} leaves no artwork inside a {trim_width_mm} x {trim_height_mm} mm TrimBox")
    # Size from the finished mm (not from two independently rounded edges) so it is never off by one.
    x0, y0 = round(bleed.left * sx), round(bleed.top * sy)
    return full_bleed.crop((x0, y0, x0 + round(finished_w * sx), y0 + round(finished_h * sy)))


def finish(
    trimmed: TrimArtworkOutput,
    pdf_path: Path,
    bleed: Sides,
    expected_width_mm: float,
    expected_height_mm: float,
    key_prefix: str,
    profile: PdfProfile,
    storage: Storage,
) -> FinishOutput:
    full = Image.open(io.BytesIO(storage.get_bytes(trimmed.bleed_key)))
    full.load()
    image = cut_bleed(full, trimmed.trim_width_mm, trimmed.trim_height_mm, bleed)
    px_per_mm = full.width / trimmed.trim_width_mm
    size_mm = (round(image.width / px_per_mm, 3), round(image.height / px_per_mm, 3))
    tol = profile.finished_size_tolerance_mm
    if abs(size_mm[0] - expected_width_mm) > tol or abs(size_mm[1] - expected_height_mm) > tol:
        raise NeedsReview(
            "finished_size",
            f"Finished artwork is {size_mm[0]} x {size_mm[1]} mm, expected {expected_width_mm} x {expected_height_mm} mm (+/- {tol} mm)",
            {"finished_mm": size_mm, "expected_mm": (expected_width_mm, expected_height_mm), "bleed_mm": bleed.model_dump()},
        )

    # (e) technical-colour safety scan
    check = profile.technical_colour
    technical = trimmed.technical_inks() or set(profile.technical_inks)
    rgb = safety.technical_rgb(pdf_path, list(technical), check)
    colour = safety.colour_mask(image, rgb, check.max_delta_e)
    # A stray keyline is a hairline or small text. A solid patch of that colour is artwork (FGPO7002:
    # a blue swirl in the brand logo) and must not be masked.
    k = 2 * max(1, round(KEYLINE_MAX_MM / 2 * px_per_mm)) + 1
    colour = safety.thin_parts(colour, k) if colour.any() else colour
    # ...and it runs straight: dieline and dimension lines are horizontal or vertical. A curved sliver
    # (FGPO7002: the edge of that swirl) is artwork: left as it is, noted in the log.
    run = round(KEYLINE_MIN_RUN_MM * px_per_mm)
    stray_artwork = int(colour.sum()) if colour.any() and max(colour.sum(axis=0).max(), colour.sum(axis=1).max()) < run else 0
    if stray_artwork:
        colour[:] = False
    colour_n = int(colour.sum())
    if colour_n < check.min_pixels or trimmed.mode != "layers":
        # Files without layers: the dieline is removed from the page's content streams by construction,
        # and the technical ink's preview colour may well be an artwork colour (FGPO7138's is the
        # design's PANTONE 293 C blue), so a colour match there is artwork, not a stray keyline.
        colour[:] = False
        colour_n = 0
    sep_full = None if trimmed.mode != "layers" else safety.separation_mask(
        pdf_path, trimmed.layers_rendered, Box(*trimmed.trim_box_pt), technical, SAFETY_SCAN_DPI)
    if sep_full is not None:
        sep = cut_bleed(sep_full, trimmed.trim_width_mm, trimmed.trim_height_mm, bleed).resize(image.size, Image.NEAREST)
        separation = np.asarray(sep) > 0
    else:
        separation = np.zeros_like(colour)
    sep_n = int(separation.sum())
    mask = colour | separation

    issues: list[Issue] = []
    if stray_artwork >= check.min_pixels and trimmed.mode == "layers":
        issues.append(Issue(code="keyline_colour_artwork", field=f"artwork.{trimmed.panel}", severity="warning",
                            message=f"{stray_artwork} px of the artwork are close to the keyline colour but form no straight line: kept as artwork"))
    preview_key = None
    if mask.any():
        preview_key = f"{key_prefix}/{_name(trimmed.item_code, trimmed.panel, 'technical_marks')}"
        storage.put_bytes(preview_key, _png_bytes(safety.highlight(image, mask)), "image/png")
        image = safety.mask_out(image, mask)
        # Marks only along the cut edge are the dieline frame drawn on the artwork layer (FGPO4002): the
        # masking is all they need. Anything further in may be a stray keyline and is shown for review.
        edge = max(1, round(EDGE_FRAME_MM * px_per_mm))
        inner = mask[edge:-edge, edge:-edge] if min(mask.shape) > 2 * edge else mask
        frame_only = not inner.any()
        issues.append(Issue(
            code="technical_marks",
            field=f"artwork.{trimmed.panel}",
            message=("The cut-line frame on the artwork layer was masked" if frame_only else
                     f"Keyline-coloured marks on the artwork layer were masked ({colour_n} colour px, {sep_n} technical-ink px); check the highlighted preview"),
            severity="warning" if frame_only else "review",
        ))

    key = f"{key_prefix}/{_name(trimmed.item_code, trimmed.panel, 'finished')}"
    storage.put_bytes(key, _png_bytes(image), "image/png")
    return FinishOutput(
        finished_key=key,
        finished_px=image.size,
        finished_mm=size_mm,
        bleed_mm=bleed,
        issues=issues,
        technical_rgb=rgb,
        technical_pixels={"colour": colour_n, "separation": sep_n},
        preview_key=preview_key,
    )


def _png_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG", compress_level=6)
    return buf.getvalue()
