"""Step extract_specs (spec 2.2): read the job spec table and the dimension labels, offline.

1. Render the spec table region and the dimension drawing, 300 dpi. Layered (ArtPro+) files: every
   layer except the artwork, left of the artwork area. Files without layers (app.pdf.sheet): the
   dimension drawing is the technical ink alone, the table is the largest area outside it.
2. Read the table: live PDF text when the table has it (exact), otherwise OCR (Tesseract, --psm 4)
   band by band, bands cut at the table's own full-width rules. Parse with the label dictionary
   from the PDF profile. Weak cells get a second, cell-only OCR pass; optionally (off by default)
   a vision fallback for single cells.
3. Ink names from the colour dots. Keyline from the dieline's vector lines, confirmed by OCR'd
   labels. A sheet carrying several panels (e.g. front + gusset + back) is split with the table's
   sizes (app.geometry.sheet_layout) and the front panel is measured on its own.
4. Validate. Nothing is guessed: unreadable or doubtful values go to NEEDS_REVIEW.
"""

import io
import logging
import re
import tempfile
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image
from pydantic import BaseModel

from app.config import Settings, get_settings
from app.errors import NeedsReview
from app.geometry.sheet_layout import SheetLayout, SheetPanel, detect, grid_layout, side_roles
from app.ocr import ai_table, assemble, fallback, keyline, pdf_table, pdf_text, tesseract
from app.ocr.inks import read_inks, split_value_additions
from app.ocr.table import FieldRead, erase_rules, has_ink, parse_value, read_fields, refine_words, second_pass
from app.pdf.layers import PT_TO_MM, Box, output_intent_profile, write_layer_copy
from app.pdf.profile import PdfProfile
from app.pdf.render import pdftoppm_png
from app.pdf import sheet as sheet_impl
from app.pdf.sheet import Sheet, analyse, non_technical_copy, technical_copy
from app.pdf.vector import corner_cut, corner_cut_at, dashed_lines, dieline, dieline_grids, horizontal_rules
from app.specs.schema import CellRead, MeasuredKeyline, Num, NumList, SpecSheet
from app.specs.validate import ValidationReport, ValidationRules, validate
from app.storage import Storage

log = logging.getLogger(__name__)

LIVE_TEXT_MIN_WORDS = 20  # fewer live words in the table region: the table is outlined, use OCR
LIVE_TEXT_MIN_LABELS = 0.6  # share of the template's labels live text must find to be used


class ExtractSpecsInput(BaseModel):
    pdf_path: Path
    filename: str
    key_prefix: str
    trim_width_mm: float
    trim_height_mm: float
    # The rendered artwork of the whole sheet (trim_artwork's bleed image): on a multi-panel sheet
    # the front is told from the back by how much small print each carries.
    sheet_image_key: str | None = None
    # Operator-verified values ("spec_table.pouch_height_mm": 210): used to split a multi-panel sheet.
    corrections: dict[str, Any] = {}
    # The item's specs from the ERP (an SAP item-master XML, app.services.xml_spec_parser): {field: text}.
    # They win over what the table read gives; the PDF still gives everything else and the drawing.
    xml_fields: dict[str, str] = {}


class ExtractSpecsOutput(BaseModel):
    sheet: SpecSheet
    report: ValidationReport
    cells: dict[str, CellRead]
    fallback_fields: list[str]
    spec_image_key: str
    dimension_image_key: str
    tesseract_version: str
    mode: str = "layers"  # app.pdf.sheet mode
    repeats: int = 1  # separation: dielines of this size on the sheet (print repeats)
    roll_form: bool = False  # the table says Roll Form: the dieline is one print repeat, not a pouch
    text_source: str = "ocr"  # "pdf_text" when the table was read from the PDF's live text
    layout: SheetLayout = SheetLayout(kind="single")
    sheet_box_pt: tuple[float, float, float, float] | None = None  # the dieline's outer rectangle / TrimBox
    front_box_pt: tuple[float, float, float, float] | None = None  # the finished front panel on a multi-panel sheet
    layout_problem: str | None = None

    def front_trim_mm(self, default: tuple[float, float]) -> tuple[float, float]:
        """Size of what validation compares with the pouch size: the front panel's box on a sheet."""
        if self.front_box_pt is None:
            return default
        b = Box(*self.front_box_pt)
        blank = self.layout.blank() if self.layout.kind == "multi" else None
        if blank is not None and blank.rotation in (90, 270):  # drawn on its side: its width runs down the sheet
            return round(b.height_mm, 4), round(b.width_mm, 4)
        return round(b.width_mm, 4), round(b.height_mm, 4)


@dataclass
class Renders:
    spec: Image.Image | None  # colour, spec region (None until the background OCR of an XML job renders it)
    spec_box: Box
    dims: Image.Image  # colour, dimension drawing only
    dims_box: Box


@dataclass
class Vectors:
    """Where to read dieline lines: the file and its dimension layers, or a technical-ink-only copy."""

    pdf: Path
    layers: list[str] | None


def vectors(pdf_path: Path, profile: PdfProfile, sheet: Sheet, tmp: Path) -> Vectors:
    if sheet.mode == "layers":
        return Vectors(pdf_path, profile.dimension_layers)
    return Vectors(technical_copy(pdf_path, tmp / "technical_full.pdf", sheet.inks.technical), None)


def _dims_box(sheet: Sheet, profile: PdfProfile) -> Box:
    m, t = sheet.facts.media_box, sheet.trim
    if sheet.mode == "separation" and sheet.technical is not None:
        e, pad = sheet.technical, 2 / PT_TO_MM
        return Box(max(m.x0, e.x0 - pad), max(m.y0, e.y0 - pad), min(m.x1, e.x1 + pad), min(m.y1, e.y1 + pad))
    margin = profile.dimension_margin_mm / PT_TO_MM
    return Box(max(m.x0, t.x0 - margin), max(m.y0, t.y0 - margin), min(m.x1, t.x1 + margin), min(m.y1, t.y1 + margin))


def _spec_box(sheet: Sheet, profile: PdfProfile, dims: Box, pdf_path: Path | None = None, non_technical: Path | None = None) -> Box:
    m, t = sheet.facts.media_box, sheet.trim
    if sheet.mode == "layers":
        margin = profile.dimension_margin_mm / PT_TO_MM
        return Box(m.x0, m.y0, max(m.x0 + 1, t.x0 - margin), m.y1)
    if sheet.mode == "page":
        return m  # plain artwork: a table, if any, could be anywhere
    # The table is beside the drawing: left, right, above or below it. The strip that holds it is
    # the one with the table's frame (full-width horizontal rules: the rows of a table all run its
    # whole width, artwork lines do not; technical ink excluded) and live text; a small artwork on a
    # wide page would otherwise hand the "largest" strip below the drawing a table cut in half
    # (FGPO7396), and a second print repeat's artwork counts many short lines (FGPO7138). Area breaks
    # ties (and decides when nothing can be counted).
    # (the artwork copy counts as drawing too: on an imposition the keyline is measured on another copy)
    keep = Box(min(dims.x0, t.x0), min(dims.y0, t.y0), max(dims.x1, t.x1), max(dims.y1, t.y1))
    sides = [
        Box(m.x0, m.y0, keep.x0, m.y1), Box(keep.x1, m.y0, m.x1, m.y1),
        Box(m.x0, keep.y1, m.x1, m.y1), Box(m.x0, m.y0, m.x1, keep.y0),
    ]
    area = lambda b: max(0.0, b.x1 - b.x0) * max(0.0, b.y1 - b.y0)  # noqa: E731

    def score(b: Box) -> tuple[int, float]:
        if area(b) <= 0 or min(b.width_mm, b.height_mm) < 40:
            return (-1, 0.0)  # (a sliver between the drawing and the page edge holds no table)
        n = 0
        if non_technical is not None:
            n += _table_rules(non_technical, b, m.x1 - m.x0)
        if pdf_path is not None:
            n += len(pdf_text.words(pdf_path, b, 72))
        return (n, area(b))

    return max(sides, key=score)


_RULES: dict[tuple, list] = {}


def _table_rules(non_technical: Path, box: Box, page_width_pt: float) -> int:
    """Horizontal rules inside `box` that could be a table's: at least 40 mm long, wholly inside the
    box, and not sheet-wide (a bleed or cut line across the page is no table row)."""
    from app.pdf.vector import _drawings, _segments

    drawings, inv = _drawings(non_technical)
    key = (id(drawings), len(drawings))  # (each side of the sheet is scored on the same lines: found once)
    if key not in _RULES:
        _RULES.clear()
        _RULES[key] = _segments(drawings, inv, 40 / PT_TO_MM)[0]
    hs = _RULES[key]
    return sum(1 for y, x0, x1 in hs
               if box.y0 <= y <= box.y1 and x0 >= box.x0 - 1 and x1 <= box.x1 + 1 and (x1 - x0) < 0.95 * page_width_pt)


def _trim_px(trim: Box, region: Box, dpi: int) -> tuple[int, int, int, int]:
    s = dpi / 72
    return (round((trim.x0 - region.x0) * s), round((region.y1 - trim.y1) * s),
            round((trim.x1 - region.x0) * s), round((region.y1 - trim.y0) * s))


def render_inputs(pdf_path: Path, profile: PdfProfile, sheet: Sheet | None = None) -> Renders:
    sheet = sheet or analyse(pdf_path, profile)
    icc = output_intent_profile(pdf_path)
    dims_box = _dims_box(sheet, profile)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        non_technical = None
        if sheet.mode == "separation":
            non_technical = non_technical_copy(pdf_path, tmp_dir / "non_technical.pdf", sheet.inks.technical) if sheet.inks.technical else pdf_path
        # (table rules are counted without the white plate too: a white-ink preview of the print beside the
        # drawing repeats its long lines and outscored the table, FGPO7138)
        rules = (non_technical_copy(pdf_path, tmp_dir / "rules.pdf", {*sheet.inks.technical, *sheet.inks.white})
                 if sheet.mode == "separation" and sheet.inks.white else non_technical)
        spec_box = _spec_box(sheet, profile, dims_box, pdf_path, rules)
        if sheet.mode == "layers":
            facts = sheet.facts
            missing = [n for n in profile.dimension_layers if n not in facts.layers]
            if missing:
                raise NeedsReview("layer_missing", f"Cannot render spec inputs; missing layers {missing}", {"found": facts.layers})
            # the spec table is on every layer that is not artwork (Dynamic Marks, Footer1 or whatever the file has)
            non_artwork = [name for name in facts.layers if name not in sheet.artwork_layers]
            write_layer_copy(pdf_path, tmp_dir / "spec.pdf", non_artwork, spec_box)
            write_layer_copy(pdf_path, tmp_dir / "dims.pdf", profile.dimension_layers, dims_box)
        else:
            write_layer_copy(non_technical or pdf_path, tmp_dir / "spec.pdf", None, spec_box)
            technical_copy(pdf_path, tmp_dir / "dims.pdf", sheet.inks.technical, crop=dims_box)
        spec = pdftoppm_png(tmp_dir / "spec.pdf", tmp_dir / "spec.png", profile.spec_dpi, icc)
        dims = pdftoppm_png(tmp_dir / "dims.pdf", tmp_dir / "dims.png", profile.spec_dpi, icc)
    return Renders(spec=spec, spec_box=spec_box, dims=dims, dims_box=dims_box)


def measure_panel(pdf_path: Path, profile: PdfProfile, expected_width_mm: float, expected_height_mm: float,
                  size_tol_mm: float | None = None) -> keyline.MeasuredKeyline:
    """Measured keyline of a linked panel PDF (back, gusset, ...) without reading its spec table."""
    sheet = analyse(pdf_path, profile)
    icc = output_intent_profile(pdf_path)
    d = _dims_box(sheet, profile)
    with tempfile.TemporaryDirectory() as tmp, dashed_lines(sheet.dashed):
        tmp_dir = Path(tmp)
        vec = vectors(pdf_path, profile, sheet, tmp_dir)
        if sheet.mode == "layers":
            if any(n not in sheet.facts.layers for n in profile.dimension_layers):
                raise NeedsReview("layer_missing", f"{pdf_path.name}: no dimension layer", {"found": sheet.facts.layers})
            write_layer_copy(pdf_path, tmp_dir / "dims.pdf", profile.dimension_layers, d)
        else:
            technical_copy(pdf_path, tmp_dir / "dims.pdf", sheet.inks.technical, crop=d)
        dims = pdftoppm_png(tmp_dir / "dims.pdf", tmp_dir / "dims.png", profile.spec_dpi, icc)
        labels = dimension_labels(pdf_path, dims, d, sheet.trim, profile)
        measured, _ = keyline.measure(vec.pdf, vec.layers, sheet.trim, labels, expected_width_mm, expected_height_mm,
                                      tol_mm=profile.finished_size_tolerance_mm, label_tol_mm=profile.label_tolerance_mm, size_tol_mm=size_tol_mm)
    return measured


def ocr_table(pdf_path: Path, renders: Renders, profile: PdfProfile, layers: list[str] | None = None) -> tuple[list[tesseract.Word], Image.Image]:
    """OCR the spec region band by band; returns words in spec-image pixels and the OCR image."""
    from concurrent.futures import ThreadPoolExecutor

    tpl = profile.spec_template
    gray = binarized(renders.spec, profile)
    box, scale = renders.spec_box, profile.spec_dpi / 72
    rules = horizontal_rules(pdf_path, layers, box, tpl.band_rule_min_span)
    cuts = sorted({0, gray.height, *(round((box.y1 - y) * scale) for y in rules)})
    min_band = round(2 / PT_TO_MM * scale)  # ignore slivers under 2 mm between double rules

    bands_to_ocr = []
    for top, bottom in zip(cuts, cuts[1:]):
        if bottom - top < min_band:
            continue
        band = erase_rules(gray.crop((0, top, gray.width, bottom)))
        bands_to_ocr.append((top, bottom, band))

    def _ocr_band(item):
        top, bottom, band = item
        found = tesseract.words(band, psm=tpl.tesseract_psm, lang=tpl.tesseract_lang)
        if not found and tpl.tesseract_psm != 6 and has_ink(band):
            found = tesseract.words(band, psm=6, lang=tpl.tesseract_lang)
        return [(w.text, w.conf, w.left, w.top + top, w.width, w.height) for w in found]

    words: list[tesseract.Word] = []
    if bands_to_ocr:
        with ThreadPoolExecutor(max_workers=min(8, len(bands_to_ocr))) as executor:
            results = list(executor.map(_ocr_band, bands_to_ocr))
            for res in results:
                for text, conf, left, top_pos, width, height in res:
                    words.append(tesseract.Word(text, conf, left, top_pos, width, height))

    return words, gray


def binarized(spec: Image.Image, profile: PdfProfile) -> Image.Image:
    t = profile.spec_template.binarize_threshold
    return spec.convert("L").point(lambda v: 0 if v < t else 255)


def _found_labels(reads: dict[str, FieldRead]) -> int:
    return sum(1 for r in reads.values() if not r.reason.startswith("label "))


def read_table(pdf_path: Path, renders: Renders, profile: PdfProfile, sheet: Sheet, min_confidence: float,
               settings: Settings | None = None) -> tuple[dict[str, FieldRead], Image.Image, list[tesseract.Word], str]:
    """Field reads, the image they refer to, the live words (if used) and the text source.

    The PDF's own text is exact and comes first: its words placed like OCR words (app.ocr.pdf_text)
    and its table cells (app.ocr.pdf_table) fill and cross-check each other. Outlined text is read
    from the rendered table, only when the profile allows it (`ocr`: auto / off / always), by
    Tesseract or, with Settings.text_reader set to an AI provider, by that model in one call
    (Tesseract again if the call fails)."""
    settings = settings or get_settings()
    tpl = profile.spec_template
    image = binarized(renders.spec, profile)
    live = pdf_text.words(pdf_path, renders.spec_box, profile.spec_dpi) if profile.ocr != "always" else []
    if len(live) >= LIVE_TEXT_MIN_WORDS:
        reads = read_fields(live, tpl, image.width)
        if _found_labels(reads) >= LIVE_TEXT_MIN_LABELS * len([r for r in tpl.fields if r.field]):
            for r in reads.values():
                r.source = "pdf_text"
            cells = pdf_table.read_cells(pdf_table.table_cells(pdf_path, renders.spec_box), tpl)
            pdf_table.merge(reads, cells, tpl)
            if profile.ocr != "off":
                second_pass(image, reads, tpl, min_confidence)  # only cells the text layer left blank or invalid
            return reads, image, live, "pdf_text"
    if profile.ocr == "off":
        # No usable text layer and OCR switched off: every field is unread; the job pauses for the details.
        return read_fields([], tpl, image.width), image, live, "none"
    reader = settings.text_reader.lower().strip()
    if reader in ai_table.READERS:
        try:
            return ai_table.read(renders.spec, tpl, reader, settings), image, [], reader
        except ai_table.Unavailable as exc:
            log.warning("text reader %s unavailable, reading the table with Tesseract: %s", reader, exc)
    elif reader != "ocr":
        log.warning("unknown TEXT_READER %r, reading the table with Tesseract", reader)
    spec_layers = None if sheet.mode != "layers" else [n for n in sheet.facts.layers if n not in sheet.artwork_layers]
    words, image = ocr_table(pdf_path, renders, profile, spec_layers)
    retry = max(min_confidence, tpl.retry_below_confidence)
    words = refine_words(image, words, tpl, retry)
    reads = read_fields(words, tpl, image.width)
    second_pass(image, reads, tpl, retry)
    return reads, image, [], "ocr"


def dimension_labels(pdf_path: Path, dims: Image.Image, dims_box: Box, trim: Box, profile: PdfProfile) -> keyline.LabelText:
    """Dimension labels around `trim`: from the PDF's text layer when it has them, else OCR (if allowed)."""
    trim_px = _trim_px(trim, dims_box, profile.spec_dpi)
    if profile.ocr != "always":
        live = pdf_text.words(pdf_path, dims_box, profile.spec_dpi)
        labels = keyline.labels_from_words(live, trim_px)
        if len(labels.numbers) >= 2:
            return labels
    if profile.ocr == "off":
        return keyline.LabelText([], None, [])
    return keyline.read_labels(dims, trim_px, profile.spec_template, profile.spec_dpi)


def _spec_value(reads: dict[str, FieldRead], corrections: dict[str, Any], name: str) -> float | None:
    v = corrections.get(f"spec_table.{name}")
    if v is None:
        r = reads.get(name)
        v = r.value if r is not None else None
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else None


def _blank_below_table(trim: Box, renders: "Renders", reads: dict, open_w: float, height: float, profile: PdfProfile,
                       pdf: Path | None = None) -> SheetLayout | None:
    """A pillow blank drawn under the spec table on the same page, with no technical ink and no
    closed dieline box (FGPO6813): the space below the table's lowest read field, when one open
    width x height blank fits it (with at most a bleed around), is that blank. Its top and bottom are
    the two drawn lines across it exactly its height apart; without them, the side margin is assumed
    at the bottom too (FGPO6813's is 8.4 mm against 11.8 mm at the sides: 3.5 mm off, the top dieline
    and a white strip printed on the faces)."""
    bottoms = [r.bbox[3] for r in reads.values() if getattr(r, "bbox", None)]
    if not bottoms:
        return None
    k = 72 / profile.spec_dpi  # pt per pixel of the table as read (a wrong guess only makes the fit fail)
    table_bottom = renders.spec_box.y1 - max(bottoms) * k  # PDF y (up)
    free_h = (min(table_bottom, trim.y1) - trim.y0) * PT_TO_MM
    sheet_w = trim.width_mm
    margin = (sheet_w - open_w) / 2  # the bleed at the sides; the blank keeps the same at the page bottom
    if not (-profile.finished_size_tolerance_mm <= margin <= 25.0 and free_h >= height + margin):
        return None
    x0, y0 = max(0.0, margin), trim.height_mm - max(0.0, margin) - height  # mm from the sheet's top-left
    if pdf is not None:
        tol = profile.finished_size_tolerance_mm / PT_TO_MM
        rules = horizontal_rules(pdf, None, Box(trim.x0, trim.y0, trim.x1, min(table_bottom, trim.y1)), 0.8)
        pairs = [(a, b) for a in rules for b in rules if b > a and abs((b - a) - height / PT_TO_MM) <= tol]
        if pairs:
            _, top = min(pairs, key=lambda ab: abs((ab[1] - ab[0]) - height / PT_TO_MM))
            y0 = (trim.y1 - top) * PT_TO_MM
    return SheetLayout(kind="multi", axis="horizontal", message="pillow blank under the spec table",
                       panels=[SheetPanel(kind="blank", x_mm=round(x0, 2), y_mm=round(y0, 2), width_mm=open_w, height_mm=height)])


def _blank_front_box(sheet_box: Box, blank: SheetPanel, width: float, open_w: float | None) -> Box:
    """The front panel inside a pillow blank: the middle `width` of the blank's open width (the blank
    may be drawn on its side: open width down the sheet)."""
    cell = panel_box(sheet_box, blank)
    open_w = open_w or 2 * width
    inset = max(0.0, (open_w - width) / 2) / PT_TO_MM
    if blank.rotation in (90, 270):
        return Box(cell.x0, cell.y0 + inset, cell.x1, cell.y1 - inset)
    return Box(cell.x0 + inset, cell.y0, cell.x1 - inset, cell.y1)


def _top_spout_label(words: list[tesseract.Word]) -> bool:
    """A "Top (Center) (Side) Spout" label on the dieline (FGPO3009): the spout sits in the top edge."""
    spouts = [w for w in words if "spout" in w.text.lower()]
    return any(w.text.lower() == "top" and abs(w.top - s.top) <= max(3, s.height / 2) for s in spouts for w in words)


def _ocr_words(pdf: Path, box: Box, lang: str, dpi: int = 150) -> list[tesseract.Word]:
    """Tesseract words of `box` on the page as it renders (sparse text)."""
    import pymupdf

    doc = pymupdf.open(pdf)
    try:
        page = doc[0]
        clip = pymupdf.Rect(box.x0, box.y0, box.x1, box.y1) * page.transformation_matrix
        pix = page.get_pixmap(dpi=dpi, clip=clip.normalize(), colorspace=pymupdf.csGRAY)
        image = Image.frombytes("L", (pix.width, pix.height), pix.samples)
    finally:
        doc.close()
    return tesseract.words(image, psm=11, lang=lang)


def _valve_label(pdf_path: Path, trim: Box) -> tuple[float | None, float | None]:
    """A "(Coffee) Valve" label on or just above the dieline (FGPO5452): its centre (mm from the trim's
    left edge) and the dimension printed under it, the valve centre below the top edge ("90 mm")."""
    margin = 40 / PT_TO_MM
    region = Box(trim.x0, trim.y0 - margin, trim.x1, trim.y1 + margin)
    words = pdf_text.words(pdf_path, region, 72)
    valve = next((w for w in words if "valve" in w.text.lower()), None)
    if valve is None:
        return None, None
    # the whole label ("Coffee Valve"): the words on its line just before it
    label = [w for w in words if abs(w.top - valve.top) <= 3 and valve.left - 60 / PT_TO_MM <= w.left <= valve.left]
    x0, x1 = min(w.left for w in label), max(w.left + w.width for w in label)
    top_px = margin  # the finished top edge, in region pixels (72 dpi = points)
    y = None
    for w in sorted(words, key=lambda w: w.top):
        cx = w.left + w.width / 2
        if x0 <= cx <= x1 and top_px < w.top < top_px + 150 / PT_TO_MM:
            try:
                v = float(w.text.replace(",", "."))
            except ValueError:
                continue
            if 10 <= v <= 400:
                y = v
                break
    return round((x0 + x1) / 2 * PT_TO_MM, 1), y


def panel_box(sheet_box: Box, p: SheetPanel) -> Box:
    k = PT_TO_MM
    return Box(sheet_box.x0 + p.x_mm / k, sheet_box.y1 - (p.y_mm + p.height_mm) / k,
               sheet_box.x0 + (p.x_mm + p.width_mm) / k, sheet_box.y1 - p.y_mm / k)


_WORD_COUNTS: dict[tuple, int] = {}
# Width an upright face is OCR'd at to count its words. 800 px keeps front and back far apart (backs
# 5x and more on FGPO3974/7150/7319/7393/7460) at 70 % of the time 1200 px took; 600 px loses small print.
WORD_COUNT_PX = 800


def _word_count(image: Image.Image, tpl) -> int:
    """Readable words (3+ letters or digits, confident) on an upright panel image."""
    img = image.convert("L")
    if img.width > WORD_COUNT_PX:
        img = img.resize((WORD_COUNT_PX, round(img.height * WORD_COUNT_PX / img.width)), Image.LANCZOS)
    key = (img.size, hash(img.tobytes()), tpl.tesseract_lang)  # the back is counted for the front choice and again for its way up
    if key not in _WORD_COUNTS:
        while len(_WORD_COUNTS) >= 32:
            _WORD_COUNTS.pop(next(iter(_WORD_COUNTS)))
        words = tesseract.words(img, psm=11, lang=tpl.tesseract_lang)
        _WORD_COUNTS[key] = sum(1 for w in words if w.conf >= 0.6 and sum(c.isalnum() for c in w.text) >= 3)
    return _WORD_COUNTS[key]


def choose_front(layout: SheetLayout, sheet_image: Image.Image | None, sheet_mm: tuple[float, float], profile: PdfProfile) -> SheetLayout:
    """Name the faces of a multi-panel sheet front / back."""
    faces = [p for p in layout.panels if p.kind == "face"]
    if not faces:
        return layout
    front = 0
    counts: dict[str, int] = {}
    if len(faces) >= 2:
        if profile.sheet_front == "last":
            front = 1
        elif profile.sheet_front == "auto" and sheet_image is not None:
            sx, sy = sheet_image.width / sheet_mm[0], sheet_image.height / sheet_mm[1]
            from concurrent.futures import ThreadPoolExecutor

            crops = []
            for p in faces[:2]:
                crop = sheet_image.crop((round(p.x_mm * sx), round(p.y_mm * sy), round((p.x_mm + p.width_mm) * sx),
                                         round((p.y_mm + p.height_mm) * sy)))
                # Either way up: which end of a face is up is decided later (from the dieline), and
                # upside-down text reads as many garbage "words" (FGPO3970: 67 against 24).
                crop = crop.rotate(p.rotation) if p.rotation else crop
                crops += [crop, crop.rotate(180)]
            with ThreadPoolExecutor(max_workers=4) as pool:  # four OCR runs, each its own tesseract process
                c = list(pool.map(lambda im: _word_count(im, profile.spec_template), crops))
            n = [max(c[0], c[1]), max(c[2], c[3])]
            counts = {"first": n[0], "second": n[1]}
            # Backs carry the small print (nutrition, address, barcode, directions); fronts the brand.
            if n[0] >= profile.sheet_front_text_ratio * max(n[1], 1):
                front = 1
    for i, p in enumerate(faces):
        p.role = "front" if i == front else ("back" if i == (1 - front) and i < 2 else None)
    return layout.model_copy(update={"front_words": counts})


def _upright_from_side(m: MeasuredKeyline, clockwise: bool = False) -> MeasuredKeyline:
    """A keyline measured on a panel lying on its side, as the upright panel. Turned 90 degrees
    counter-clockwise the sheet's right edge is the panel's top and its top edge the panel's left;
    turned clockwise, the sheet's left edge is the top and its bottom edge the left."""
    rev = lambda lst: NumList(value=list(reversed(lst.value)), confidence=lst.confidence)  # noqa: E731
    if clockwise:
        return m.model_copy(update={
            "overall_width_mm": m.overall_height_mm, "overall_height_mm": m.overall_width_mm,
            "width_segments_mm": rev(m.height_segments_mm), "height_segments_mm": m.width_segments_mm,
            "bleed_left_mm": m.bleed_bottom_mm, "bleed_right_mm": m.bleed_top_mm,
            "bleed_top_mm": m.bleed_left_mm, "bleed_bottom_mm": m.bleed_right_mm,
        })
    return m.model_copy(update={
        "overall_width_mm": m.overall_height_mm, "overall_height_mm": m.overall_width_mm,
        "width_segments_mm": m.height_segments_mm, "height_segments_mm": rev(m.width_segments_mm),
        "bleed_left_mm": m.bleed_top_mm, "bleed_right_mm": m.bleed_bottom_mm,
        "bleed_top_mm": m.bleed_right_mm, "bleed_bottom_mm": m.bleed_left_mm,
    })


def _from_drawn_lines(m: MeasuredKeyline, xs: list[float], width: float, axis: str = "width") -> MeasuredKeyline:
    """Width (or height), its two bleeds and segments of a sheet-cut panel from its drawn lines; its two
    cut edges are lines by construction (the edge line itself may sit just outside the box)."""
    xs = sorted({0.0, round(width, 3), *(round(x, 3) for x in xs if 0.5 < x < width - 0.5)})
    segments = [round(b - a, 3) for a, b in zip(xs, xs[1:])]
    if len(segments) < 2:
        return m
    exact = lambda v: Num(value=round(v, 3), confidence=0.95)  # noqa: E731 - vector geometry, not OCR
    a, b = ("left", "right") if axis == "width" else ("top", "bottom")
    update = {f"{axis}_segments_mm": NumList(value=segments, confidence=0.95), f"bleed_{a}_mm": exact(0), f"bleed_{b}_mm": exact(0)}
    if getattr(m, f"overall_{axis}_mm").confidence < 0.85:
        update[f"overall_{axis}_mm"] = exact(width)
    return m.model_copy(update=update)


def _reads_upside_down(layout: SheetLayout, sheet_image: Image.Image | None, sheet_mm: tuple[float, float], profile: PdfProfile) -> bool:
    """When the dieline cannot say which end is up (seal / body / seal, no zipper): the back's small
    print reads far better turned round (FGPO7152: front printed upside down above an upright back)."""
    back = layout.face("back")
    if back is None or sheet_image is None or layout.axis != "vertical":
        return False
    sx, sy = sheet_image.width / sheet_mm[0], sheet_image.height / sheet_mm[1]
    crop = sheet_image.crop((round(back.x_mm * sx), round(back.y_mm * sy), round((back.x_mm + back.width_mm) * sx),
                             round((back.y_mm + back.height_mm) * sy)))
    crop = crop.rotate(back.rotation) if back.rotation else crop
    as_laid, turned = _word_count(crop, profile.spec_template), _word_count(crop.rotate(180), profile.spec_template)
    return turned >= 8 and turned >= 1.5 * max(as_laid, 1)


def _drawn_upside_down(height_segments: list[float], zipper_y: list[float] | None = None) -> bool:
    """A face's dieline read top to bottom is seal, notch band, zipper band, body, seal: the small
    bands come before the body (the longest segment). Clearly more bands after the body than before
    it (two or more: FGPO7492's 13 / 4.5 / 1.5 / 20 below a 176 body) means the face is drawn upside
    down. Symmetric keylines (seal, body, seal) and a single extra band next to the bottom seal
    (FGPO7165: 10 / 185 / 25 / 10, the gusset seal) are left alone.

    A zipper track drawn on the face (`zipper_y`, from the face's top edge) decides first: a zipper
    runs near the pouch's top, so one in the lower half means the face is drawn upside down
    (FGPO3970: its front and back meet at their tops, the brand face printed upside down above)."""
    total = sum(height_segments)
    if zipper_y and total > 0:
        return zipper_y[0] > total / 2
    if len(height_segments) < 3:
        return False
    k = height_segments.index(max(height_segments))
    return len(height_segments) - 1 - k >= k + 2


def _turned(m: MeasuredKeyline) -> MeasuredKeyline:
    """The keyline of a panel measured upside down on its sheet, as seen upright."""
    hs = list(reversed(m.height_segments_mm.value))
    zipper = m.zipper_y_mm
    if m.zipper_from_band and (y := keyline.zipper_band_centre(hs)) is not None:
        zipper = [y]
    elif zipper and hs:
        zipper = [round(sum(hs) - y, 1) for y in zipper]
    return m.model_copy(update={
        "bleed_left_mm": m.bleed_right_mm, "bleed_right_mm": m.bleed_left_mm,
        "bleed_top_mm": m.bleed_bottom_mm, "bleed_bottom_mm": m.bleed_top_mm,
        "width_segments_mm": NumList(value=list(reversed(m.width_segments_mm.value)), confidence=m.width_segments_mm.confidence),
        "height_segments_mm": NumList(value=hs, confidence=m.height_segments_mm.confidence),
        "zipper_y_mm": zipper,
    })


def run(
    inp: ExtractSpecsInput,
    profile: PdfProfile,
    rules: ValidationRules,
    storage: Storage,
    settings: Settings | None = None,
) -> ExtractSpecsOutput:
    settings = settings or get_settings()
    tpl = profile.spec_template

    sheet = analyse(inp.pdf_path, profile)
    can_ocr = profile.ocr != "off"  # (the XML shortcut below turns table OCR off; reading which way a blank stands still needs it)
    if inp.xml_fields.get("pouch_height_mm") and inp.xml_fields.get("pouch_closed_width_mm"):
        # The ERP gives the pouch (an SAP item master XML): the table is not read at all - no 300 dpi
        # renders, OCR, AI call or ink row. Only what the XML cannot know comes from the PDF's text layer
        # (client name, the Remarks with the linked panel codes); the drawing is measured as always.
        renders, reads, live, source, pending, inks = _xml_table(inp.pdf_path, profile, sheet, inp.xml_fields)
        used_fallback = []
        profile = profile.model_copy(update={"ocr": "off"})  # (dimension labels: the text layer's, if it has them)
    else:
        pending = None
        renders = render_inputs(inp.pdf_path, profile, sheet)
        reads, table_image, live, source = read_table(inp.pdf_path, renders, profile, sheet, rules.min_confidence, settings)
        confirm_with_filename(reads, profile, inp.filename)
        if inp.xml_fields:
            apply_xml(reads, inp.xml_fields, tpl)  # (before the vision fallback: no AI call for what the ERP gives)
        used_fallback = fallback.apply(renders.spec, reads, tpl, rules.min_confidence, settings)
        inks = read_inks(inp.pdf_path, renders.spec, renders.spec_box, profile.spec_dpi, tpl,
                         no_layers=sheet.mode == "separation", live_words=live)
    spec_key = f"{inp.key_prefix}/spec_table.png"  # (stored once its image exists: after the background OCR in XML mode)
    if renders.spec is not None:
        storage.put_bytes(spec_key, _png(renders.spec), "image/png")
    dims_key = storage.put_bytes(f"{inp.key_prefix}/dimensions.png", _png(renders.dims), "image/png")
    va = reads.get("value_additions")
    inks, additions = split_value_additions(inks, va.bbox[0] if va is not None and va.bbox and va.value is None else None)
    names = [a.name for a in additions if a.name]
    if names and va is not None:
        text = " | ".join(names)
        reads["value_additions"] = FieldRead("value_additions", text, text, min(a.confidence for a in additions), True, va.bbox, "", "ink_row")
    table = assemble.spec_table(reads, inks, tpl)

    width = _spec_value(reads, inp.corrections, "pouch_closed_width_mm")
    height = _spec_value(reads, inp.corrections, "pouch_height_mm")
    gusset = _spec_value(reads, inp.corrections, "gusset_full_width_mm")
    open_w = _spec_value(reads, inp.corrections, "pouch_open_width_mm")
    form = inp.corrections.get("spec_table.pouch_or_roll_form") or (reads["pouch_or_roll_form"].value if "pouch_or_roll_form" in reads else None)
    roll = "roll" in str(form or "").lower()
    labels = dimension_labels(inp.pdf_path, renders.dims, renders.dims_box, sheet.drawing_box(sheet.trim), profile)
    layout, front_box, problem, image = SheetLayout(kind="single"), None, None, None
    on_side = False
    with tempfile.TemporaryDirectory() as tmp, dashed_lines(sheet.dashed):
        vec = vectors(inp.pdf_path, profile, sheet, Path(tmp))
        spout_corner = corner_cut(vec.pdf, vec.layers) if sheet.mode in ("separation", "layers") else None
        if not spout_corner and "spout" in " ".join(str(reads[k].value or "") for k in ("sealing_type", "raw_remarks") if k in reads).lower():
            spout_corner = corner_cut_at(inp.pdf_path, sheet.trim)  # marked in process colours (FGPO5834)
        top_spout = not spout_corner and (_top_spout_label(pdf_text.words(inp.pdf_path, sheet.trim, 72)) or (
            # outlined or flattened label (FGPO6292 "Top Center Side Spout"): read on the technical-ink copy,
            # only for a job whose table says spout
            sheet.mode == "separation" and can_ocr
            and "spout" in " ".join(str(reads[k].value or "") for k in ("sealing_type", "raw_remarks") if k in reads).lower()
            and _top_spout_label(_ocr_words(vec.pdf, sheet.trim, tpl.tesseract_lang))))
        if width and height and not roll and sheet.mode in ("separation", "layers"):
            # (a layered export may carry a whole web too: FGPO5149 is a front + back web on one TrimBox)
            lines = dieline(vec.pdf, vec.layers, sheet.drawing_box(sheet.trim))
            pillow = any(k in str(reads["sealing_type"].value or "").lower() for k in ("center", "centre", "pillow", "back seal")) if "sealing_type" in reads else False
            layout = detect(sheet.trim.width_mm, sheet.trim.height_mm, lines.x_mm, lines.y_mm, width, height, gusset,
                            gap_max=profile.sheet_panel_gap_max_mm, tol=profile.finished_size_tolerance_mm, open_width=open_w,
                            prefer_blank=pillow)
            if layout.kind == "unknown":
                # Fallback: lines drawn only part-way across (a spout corner cuts the top seal line; FGPO6786
                # draws only ticks at the front's bottom seal) and lines implied one face / gusset away from
                # a drawn one. Used only when the drawn lines alone give no layout.
                part = dieline(vec.pdf, vec.layers, sheet.drawing_box(sheet.trim), min_span=0.3)
                sizes = [v for v in (height, gusset) if v]
                implied = tuple(sorted({p + d for p in part.y_mm for v in sizes for d in (v, -v)
                                        if 0 <= p + d <= sheet.trim.height_mm} - set(part.y_mm)))
                retry = detect(sheet.trim.width_mm, sheet.trim.height_mm, part.x_mm, part.y_mm, width, height, gusset,
                               gap_max=profile.sheet_panel_gap_max_mm, tol=profile.finished_size_tolerance_mm, open_width=open_w,
                               implied_y=implied)
                if retry.kind == "multi":
                    layout = retry
        elif width and height and not roll and sheet.mode == "page":
            # No technical ink: the dieline may still be drawn, in process colours, around panels on
            # a sheet that also carries the spec tables. Plain artwork (no such cells) stays one page.
            t = sheet.trim
            cells = [((g.box.x0 - t.x0) * PT_TO_MM, (t.y1 - g.box.y1) * PT_TO_MM, g.box.width_mm, g.box.height_mm)
                     for g in dieline_grids(inp.pdf_path)]
            layout = grid_layout(cells, width, height) or layout
            if layout.kind == "single" and open_w and open_w > width:
                layout = _blank_below_table(sheet.trim, renders, reads, open_w, height, profile, inp.pdf_path) or layout
        if layout.kind == "multi" and layout.blank() is not None:
            # Pillow blanks: the front is the middle `closed width` of the first blank.
            front_box = _blank_front_box(sheet.trim, layout.blank(), width, open_w)  # type: ignore[arg-type]
            if layout.blank().rotation == 90 and inp.sheet_image_key and can_ocr:
                # A blank on its side stands up either way round; its dieline is symmetric, so the print
                # says which: the way the blank reads as text (FGPO7058 reads turned clockwise). The whole
                # blank, back included: a stylised front alone reads too few words (FGPO7338 stood upside down).
                image = Image.open(io.BytesIO(storage.get_bytes(inp.sheet_image_key)))
                k = image.width / sheet.trim.width_mm * PT_TO_MM
                t = sheet.trim
                cell = panel_box(sheet.trim, layout.blank())  # type: ignore[arg-type]
                crop = image.crop((round((cell.x0 - t.x0) * k), round((t.y1 - cell.y1) * k),
                                   round((cell.x1 - t.x0) * k), round((t.y1 - cell.y0) * k)))
                ccw, cw = _word_count(crop.rotate(90, expand=True), tpl), _word_count(crop.rotate(270, expand=True), tpl)
                if cw >= 3 and cw >= 1.5 * max(ccw, 1):
                    for panel in layout.panels:
                        if panel.kind == "blank":
                            panel.rotation = 270
        elif layout.kind == "multi":
            image = None
            if inp.sheet_image_key and profile.sheet_front == "auto":
                image = Image.open(io.BytesIO(storage.get_bytes(inp.sheet_image_key)))
                image.load()
            layout = choose_front(layout, image, (sheet.trim.width_mm, sheet.trim.height_mm), profile)
            if sheet.mode == "page":
                side_roles(layout)
            front = layout.face("front")
            front_box = panel_box(sheet.trim, front)
        elif layout.kind == "unknown":
            problem = layout.message
        # Roll form: the dieline is one print repeat (repeat x web), cut exactly at its lines.
        # The drawing is measured against the table's own sizes (the keyline-vs-table check compares
        # the two); a size the table did not give comes from the operator's correction.
        exp_w, exp_h = ((sheet.trim.width_mm, sheet.trim.height_mm) if roll
                        else (table.pouch_closed_width_mm.value or width, table.pouch_height_mm.value or height))
        # A pillow blank drawn on its side (FGPO7058): the pouch height runs across the sheet. It is
        # measured as drawn, then read as the upright panel (turned 90 degrees counter-clockwise).
        on_side = layout.kind == "multi" and layout.blank() is not None and layout.blank().rotation in (90, 270)
        if on_side:
            exp_w, exp_h = exp_h, exp_w
        cut = dieline(vec.pdf, vec.layers, sheet.drawing_box(front_box), min_span=0.3) if front_box is not None and sheet.mode != "page" else None
        lines_x, lines_y = (cut.x_mm, cut.y_mm) if cut else ([], [])
        fb_w, fb_h = ((front_box.x1 - front_box.x0) * PT_TO_MM, (front_box.y1 - front_box.y0) * PT_TO_MM) if front_box is not None else (0.0, 0.0)
        measured, _ = keyline.measure(
            vec.pdf, vec.layers, sheet.drawing_box(front_box or sheet.trim), labels,
            expected_width_mm=exp_w, expected_height_mm=exp_h,
            tol_mm=profile.finished_size_tolerance_mm, exact_bleed=front_box is not None or roll,
            label_tol_mm=profile.label_tolerance_mm, size_tol_mm=rules.dimension_tolerance_mm,
        )
    if on_side:
        clockwise = layout.blank().rotation == 270  # type: ignore[union-attr]
        measured = _upright_from_side(measured, clockwise)
        lines_x, lines_y, fb_w, fb_h = (([fb_h - y for y in lines_y], lines_x) if clockwise else (lines_y, [fb_w - x for x in lines_x])) + (fb_h, fb_w)
    front_face = layout.face("front") if layout.kind == "multi" else None
    if front_face is not None:
        if front_face.rotation == 180:
            measured = _turned(measured)
        drawn_zipper = measured.zipper_y_mm if measured.zipper_line_drawn.value and not measured.zipper_from_band else None
        if _drawn_upside_down(measured.height_segments_mm.value, drawn_zipper) or (
                not drawn_zipper and _reads_upside_down(layout, image, (sheet.trim.width_mm, sheet.trim.height_mm), profile)):
            # The top seal, notch and zipper bands sit below the body: this web is drawn the other way
            # up from the usual (first face upright), e.g. an F+B web joined at the top (FGPO7492).
            # Every face turns the other way; the dieline bands, not sheet order, say which end is up.
            for p in layout.panels:
                if p.kind == "face":
                    p.rotation = (p.rotation + 180) % 360
            measured = _turned(measured)
    if front_box is not None and sheet.mode != "page" and not measured.width_segments_mm.value:
        # A panel cut from the sheet is cut on its dieline lines: when the dimension labels across it
        # cannot be read (FGPO7152), the drawn lines give its width, zero bleed and the segments.
        measured = _from_drawn_lines(measured, lines_x, fb_w)
    if front_box is not None and sheet.mode != "page" and not measured.height_segments_mm.value:
        h = fb_h
        upside_down = front_face is not None and front_face.rotation == 180  # read as drawn: turn to the upright face
        measured = _from_drawn_lines(measured, [h - y for y in lines_y] if upside_down else lines_y, h, "height")
    if sheet.mode == "page" and front_face is not None:
        # No technical ink to measure: the front's dieline cell is the finished size, cut at its lines.
        exact, zero = (lambda v: Num(value=round(v, 3), confidence=0.99)), Num(value=0.0, confidence=0.99)
        measured = measured.model_copy(update={
            "overall_width_mm": exact(front_face.width_mm), "overall_height_mm": exact(front_face.height_mm),
            "bleed_left_mm": zero, "bleed_right_mm": zero, "bleed_top_mm": zero, "bleed_bottom_mm": zero,
        })
    if measured.zipper_from_band and table.zipper.value is not True:
        measured = measured.model_copy(update={"zipper_from_band": False, "zipper_y_mm": []})  # no zipper on this pouch
    if sheet.mode == "page" and width and height and front_face is None:
        # Plain artwork page: whatever the page is larger than the pouch is bleed, split evenly. A page
        # made for the pouch size is a few micrometres off it (points are written to 3 decimals).
        bx, by = (sheet.trim.width_mm - width) / 2, (sheet.trim.height_mm - height) / 2
        if -0.05 <= bx <= 25 and -0.05 <= by <= 25:
            bx, by = max(0.0, bx), max(0.0, by)
            measured = measured.model_copy(update={
                "bleed_left_mm": Num(value=round(bx, 3), confidence=0.99), "bleed_right_mm": Num(value=round(bx, 3), confidence=0.99),
                "bleed_top_mm": Num(value=round(by, 3), confidence=0.99), "bleed_bottom_mm": Num(value=round(by, 3), confidence=0.99),
            })

    if spout_corner:
        # the dieline's diagonal marks the spout corner (FGPO6784); used by a spout pouch's keyline only
        measured = measured.model_copy(update={"spout_position": f"top_{spout_corner}_corner"})
    elif top_spout:
        measured = measured.model_copy(update={"spout_position": "top_center"})
    valve_x, valve_y = _valve_label(inp.pdf_path, sheet.trim)
    if valve_y is not None:
        measured = measured.model_copy(update={"valve_y_mm": valve_y})
    if valve_x is not None:
        # A "(coffee) valve" label over the dieline marks where the one-way valve goes (FGPO5452).
        face = next((p for p in layout.panels if p.kind == "face" and p.x_mm <= valve_x <= p.x_mm + p.width_mm), None)             if layout.kind == "multi" else None
        if face is not None and face.role in ("front", "back"):
            vx = valve_x - face.x_mm
            measured = measured.model_copy(update={"valve_panel": face.role,
                                                   "valve_x_mm": round(face.width_mm - vx if face.rotation == 180 else vx, 1)})
        elif layout.kind != "multi":
            measured = measured.model_copy(update={"valve_panel": "front",
                                                   "valve_x_mm": round(valve_x - (measured.bleed_left_mm.value or 0), 1)})

    if pending is not None:
        # the quick OCR of an outlined table (started with the XML read, done while the drawing was measured)
        try:
            words, spec_image = pending.result()
        except Exception:  # noqa: BLE001 - the background read failed: read it here
            words, spec_image = _table_ocr(inp.pdf_path, renders.spec_box, tpl)
        storage.put_bytes(spec_key, _png(spec_image), "image/png")
        for name, r in read_fields(words, tpl, spec_image.width).items():
            if reads[name].source != "xml" and r.value is not None:
                reads[name] = r
        table = assemble.spec_table(reads, inks, tpl)
    remarks = table.raw_remarks.value or ""
    linked = profile.parse_linked_codes(remarks)
    code_conf = reads["raw_remarks"].code_confidence
    sheet_out = SpecSheet(
        spec_table=table,
        measured_keyline=measured,
        linked_codes=linked,
        linked_code_confidence={role: round(code_conf.get(code, 1.0 if source == "pdf_text" else 0.0), 3) for role, code in linked.items()},
        reference_codes=profile.parse_reference_codes(remarks),
    )
    out = ExtractSpecsOutput(
        sheet=sheet_out, report=ValidationReport(issues=[], bleed_used={}, bleed_source="default"), cells={},
        fallback_fields=used_fallback, spec_image_key=spec_key, dimension_image_key=dims_key,
        tesseract_version=_tesseract_version(profile, source), mode=sheet.mode, repeats=sheet.repeats, roll_form=roll, text_source=source, layout=layout,
        sheet_box_pt=sheet.trim.as_tuple(), front_box_pt=front_box.as_tuple() if front_box else None, layout_problem=problem,
    )
    tw, th = out.front_trim_mm((inp.trim_width_mm, inp.trim_height_mm))
    out.report = validate(
        sheet_out,
        filename_code=profile.item_code_from_filename(inp.filename),
        trim_width_mm=tw,
        trim_height_mm=th,
        item_code_pattern=profile.item_code_pattern,
        rules=rules,
        layout_problem=problem,
        page_mode=sheet.mode == "page",
        roll_form=roll,
    )
    out.cells = {
        name: CellRead(raw=r.raw, confidence=r.confidence, format_ok=r.format_ok, bbox_px=r.bbox, source=r.source, reason=r.reason)
        for name, r in reads.items()
    }
    return out


def _tesseract_version(profile: PdfProfile, source: str) -> str:
    """Tesseract is optional: its version is recorded only when it was (or may have been) used."""
    if profile.ocr == "off" or source == "none":
        return "not used"
    try:
        return tesseract.version()
    except Exception:  # noqa: BLE001 - not installed: the text layer did the work
        return "unavailable"


XML_PREVIEW_DPI = 100
XML_OCR_DPI = 150  # (FGPO7215: 150 dpi reads the Remarks' two codes; 200 dpi lost one and took longer)
_BACKGROUND = ThreadPoolExecutor(max_workers=1, thread_name_prefix="xml-ocr")


def _xml_table(pdf_path: Path, profile: PdfProfile, sheet: Sheet, fields: dict[str, str]):
    """(renders, reads, live words, source) for a job whose specs come from an item master XML: the
    spec table's text layer (if any) for what the XML lacks, the XML for the rest; small previews
    stand in for the 300 dpi renders the OCR would need."""
    from app.pdf.vector import render_gray

    tpl = profile.spec_template
    dims_box = _dims_box(sheet, profile)
    spec_box = _spec_box(sheet, profile, dims_box, pdf_path)  # (by its words: no rule count, no copy of the page)
    live = pdf_text.words(pdf_path, spec_box, profile.spec_dpi)
    reads = read_fields(live, tpl, round(spec_box.width_mm / PT_TO_MM * profile.spec_dpi / 72))
    for r in reads.values():
        r.source = "pdf_text"
    apply_xml(reads, fields, tpl)
    # The inks are the file's own colour plates (exact; the printed ink row is not read), and what neither
    # the XML nor the text layer gives is a known blank, not a weak read
    from app.ocr.inks import InkRead
    from app.pdf.paint import separations

    order = {"cyan": 0, "magenta": 1, "yellow": 2, "black": 3}
    plates = sorted((n for n in separations(pdf_path) if n not in sheet.inks.technical), key=lambda n: (order.get(n.lower(), 4), n))
    inks = [InkRead(n, 1.0, (0.0, 0.0, 0.0), (0, 0, 0, 0)) for n in plates]
    if plates and reads["colour_count"].value is None:
        reads["colour_count"] = FieldRead("colour_count", str(len(plates)), len(plates), 1.0, True, None, "", "pdf_inks")
    for r in reads.values():
        if r.value is None and r.source != "xml":
            r.confidence = 1.0
    # previews for the job page; the dimension drawing from the technical-ink copy (the artwork is the slow part)
    drawing = (technical_copy(pdf_path, Path(tempfile.gettempdir()) / "unused.pdf", sheet.inks.technical)
               if sheet.mode == "separation" and sheet.inks.technical else pdf_path)
    dims = Image.fromarray(render_gray(drawing, dims_box, XML_PREVIEW_DPI))
    pending = None
    if len(live) < LIVE_TEXT_MIN_WORDS and profile.ocr != "off":
        # Outlined table text: what the XML lacks (client name, the Remarks' linked codes) is read by one
        # quick OCR pass at 150 dpi (~3 s, no AI call) - started by the trim step (prefetch_table_ocr), or
        # now, in the background while the drawing is measured; its render is the spec table preview too
        pending = _PREFETCH.pop(_prefetch_key(pdf_path, profile), None) or _BACKGROUND.submit(_table_ocr, pdf_path, spec_box, tpl)
        spec = None
    else:
        spec = Image.fromarray(render_gray(pdf_path, spec_box, XML_PREVIEW_DPI))
    return Renders(spec=spec, spec_box=spec_box, dims=dims, dims_box=dims_box), reads, live, "xml", pending, inks


def _table_ocr(pdf_path: Path, spec_box: Box, tpl) -> tuple[list, Image.Image]:
    from app.pdf.vector import render_gray

    image = Image.fromarray(render_gray(pdf_path, spec_box, XML_OCR_DPI))
    return tesseract.words(image, psm=4, lang=tpl.tesseract_lang), image


_PREFETCH: dict[tuple, Future] = {}


def _prefetch_key(pdf_path: Path, profile: PdfProfile) -> tuple:
    st = pdf_path.stat()
    return (str(pdf_path), st.st_mtime_ns, st.st_size, profile.model_dump_json())


def prefetch_table_ocr(pdf_path: Path, profile: PdfProfile) -> None:
    """For a job whose specs come from an item master XML: start the quick OCR of an outlined spec table
    now (the trim step calls this), so extract_specs finds it done. It waits for the trim step's own
    sheet analysis (two threads must not build the same cached page copies)."""
    key = _prefetch_key(pdf_path, profile)

    def job():
        deadline = time.time() + 300
        while not sheet_impl.analysed(pdf_path, profile):
            if time.time() > deadline:
                raise TimeoutError("sheet not analysed")
            time.sleep(0.2)
        sheet = analyse(pdf_path, profile)
        spec_box = _spec_box(sheet, profile, _dims_box(sheet, profile), pdf_path)
        return _table_ocr(pdf_path, spec_box, profile.spec_template)

    if key not in _PREFETCH and profile.ocr != "off":
        while len(_PREFETCH) >= 4:
            _PREFETCH.pop(next(iter(_PREFETCH)))
        _PREFETCH[key] = _BACKGROUND.submit(job)


def apply_xml(reads: dict[str, FieldRead], fields: dict[str, str], tpl) -> None:
    """The ERP's values over the table read: each parsed like printed text; one that does not fit
    its field (an unknown option, out of range) leaves the table's read in place."""
    rules = {r.field: r for r in tpl.fields if r.field}
    for name, text in fields.items():
        rule = rules.get(name)
        if rule is None:
            continue
        value, ok = parse_value(rule, text, tpl)
        if ok and value is not None:
            old = reads.get(name)
            reads[name] = FieldRead(name, text, value, 1.0, True, old.bbox if old else None, "", "xml")


def confirm_with_filename(reads: dict[str, FieldRead], profile: PdfProfile, filename: str) -> None:
    """Fields that repeat the file name (Item Name) or its item code (Item No.) are confirmed by it."""
    stem = re.sub(r"\s*\(.*?\)\s*$", "", Path(filename).stem)  # drop "(exported)"-style suffixes
    expected = {"stem": stem, "code": profile.item_code_from_filename(filename)}
    for rule in profile.spec_template.fields:
        read = reads.get(rule.field) if rule.field else None
        target = expected.get(rule.confirm_with_filename) if rule.confirm_with_filename else None
        if read is None or read.raw is None or not target:
            continue
        if re.sub(r"[^a-z0-9]", "", read.raw.lower()) == re.sub(r"[^a-z0-9]", "", target.lower()):
            reads[rule.field] = FieldRead(rule.field, read.raw, target, max(read.confidence, 0.95), True, read.bbox, "", read.source + "+filename")


def _png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
