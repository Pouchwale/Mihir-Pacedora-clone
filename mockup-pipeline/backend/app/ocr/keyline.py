"""Measured keyline: the dieline around the artwork, from vector geometry confirmed by its labels.

Line positions come from the PDF's vector paths (exact to 0.001 mm). The dimension labels are
OCR'd; a measured segment is trusted when a label with the same number is printed. A segment no
label confirms gets low confidence, so a designer's drawing error reaches review instead of a mockup.
"""

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from app.ocr import tesseract
from app.ocr.template import SpecTemplate
from app.pdf.layers import Box
from app.pdf.vector import Dieline, dieline
from app.specs.schema import Bool, DimensionLabel, MeasuredKeyline, Num, NumList, Str

CONFIRMED = 0.99
UNCONFIRMED = 0.8  # below the default review threshold on purpose: a label exists that does not agree
NO_LABELS = 0.9  # geometry alone, nothing printed to compare with
LABEL_TOL_MM = 0.05


@dataclass
class LabelText:
    numbers: list[float]
    notch_text: str | None
    labels: list[DimensionLabel]


def erase_long_runs(image: Image.Image, max_run: int) -> Image.Image:
    """Whiten vertical and horizontal runs of dark pixels longer than `max_run`."""
    arr = np.asarray(image.convert("L")).copy()
    dark = arr < 128
    for axis in (0, 1):
        d = dark if axis == 0 else dark.T
        out = arr if axis == 0 else arr.T  # a view: writes go to arr
        padded = np.pad(d, ((1, 1), (0, 0)), constant_values=False).astype(np.int8)
        edges = np.diff(padded, axis=0)
        for col in np.nonzero((d.sum(axis=0) > max_run))[0]:
            starts = np.nonzero(edges[:, col] == 1)[0]
            ends = np.nonzero(edges[:, col] == -1)[0]
            for s, e in zip(starts, ends):
                if e - s > max_run:
                    out[s:e, col] = 255
    return Image.fromarray(arr)


def read_labels(render: Image.Image, trim_px: tuple[int, int, int, int], tpl: SpecTemplate, dpi: int) -> LabelText:
    """OCR the dimension labels in the four strips around the TrimBox (`trim_px` in render pixels).

    Top/bottom strips are read upright; left/right strips are rotated both ways and the more
    confident reading wins (ArtPro+ writes vertical labels bottom-to-top, but templates vary).
    """
    gray = render.convert("L").point(lambda v: 0 if v < tpl.binarize_threshold else 255)
    # Dimension and extension lines run up to (and between) the digits; remove every straight
    # run longer than any glyph stroke so only the label text is left.
    gray = erase_long_runs(gray, max_run=round(tpl.dimension_label_max_stroke_mm / 25.4 * dpi))
    w, h = gray.size
    # (a box reaching outside the render gives empty strips, not a crash)
    x0, y0, x1, y1 = (min(max(v, 0), lim) for v, lim in zip(trim_px, (w, h, w, h)))
    strips = [
        ("horizontal", "top", gray.crop((0, 0, w, y0 + 5)), (0,)),
        ("horizontal", "bottom", gray.crop((0, y1 - 5, w, h)), (0,)),
        ("vertical", "left", gray.crop((0, 0, x0 + 5, h)), (-90, 90)),
        ("vertical", "right", gray.crop((x1 - 5, 0, w, h)), (-90, 90)),
    ]
    labels: list[DimensionLabel] = []
    notch = None
    from concurrent.futures import ThreadPoolExecutor

    jobs = []
    for axis, where, strip, angles in strips:
        if not strip.width or not strip.height:
            continue
        # Every orientation and two sparse-text modes; a number only confirms a measurement when
        # it equals it, so an extra reading cannot make a wrong value look right.
        for angle in angles:
            image = strip.rotate(angle, expand=True) if angle else strip
            image = image.resize((image.width * 2, image.height * 2), Image.LANCZOS)
            jobs += [(axis, where, image, psm) for psm in (11, 6)]
    with ThreadPoolExecutor(max_workers=6) as pool:
        reads = list(pool.map(lambda j: tesseract.words(j[2], psm=j[3], lang=tpl.tesseract_lang), jobs))
    for (axis, where, _image, _psm), words in zip(jobs, reads):
        if True:
            if True:
                for row in _lines(words):
                    # Low-confidence words count too: arrowheads touching digits ("e+13>") lower
                    # the confidence, and a number only confirms a measurement it equals exactly.
                    text = " ".join(x.text for x in row)
                    if "notch" in text.lower() and notch is None:
                        notch = text
                    for m in re.finditer(r"\d+(?:\.\d+)?", text):
                        labels.append(DimensionLabel(text=text, value_mm=float(m.group()), axis=axis, position=where))
    return LabelText(sorted({lab.value_mm for lab in labels if lab.value_mm is not None}), notch, labels)


def labels_from_words(words: list[tesseract.Word], trim_px: tuple[int, int, int, int]) -> LabelText:
    """Dimension labels from the PDF's own text (words positioned in render pixels, see
    app.ocr.pdf_text): exact numbers, no OCR. Words in the strips above / below the TrimBox are
    horizontal labels, those left / right of it vertical ones; words inside the TrimBox are artwork."""
    x0, y0, x1, y1 = trim_px
    labels: list[DimensionLabel] = []
    notch = None
    for w in words:
        cx, cy = w.left + w.width / 2, w.cy
        if cy <= y0 + 5:
            axis, where = "horizontal", "top"
        elif cy >= y1 - 5:
            axis, where = "horizontal", "bottom"
        elif cx <= x0 + 5:
            axis, where = "vertical", "left"
        elif cx >= x1 - 5:
            axis, where = "vertical", "right"
        else:
            continue
        text = w.text
        if "notch" in text.lower() and notch is None:
            notch = text
        for m in re.finditer(r"\d+(?:\.\d+)?", text.replace(",", ".")):
            labels.append(DimensionLabel(text=text, value_mm=float(m.group()), axis=axis, position=where))
    return LabelText(sorted({lab.value_mm for lab in labels if lab.value_mm is not None}), notch, labels)


def _lines(words) -> list[list[tesseract.Word]]:
    from app.ocr.table import group_rows

    return [r.words for r in group_rows(words)]


def _label_for(value: float, numbers: list[float], tol: float = LABEL_TOL_MM) -> float | None:
    near = [n for n in numbers if abs(value - n) <= tol]
    return min(near, key=lambda n: abs(value - n)) if near else None


def _finished_pair(lines: list[float], total: float, expected: float | None, tol: float) -> tuple[float, float] | None:
    """The two lines whose distance is the finished size: the closest to it (to 0.1 mm), then the
    most symmetric (a neighbouring pair 0.4 mm short must not win by being more central)."""
    if expected is None:
        return None
    pairs = [(a, b) for a in lines for b in lines if b > a and abs((b - a) - expected) <= tol]
    if not pairs:
        return None
    return min(pairs, key=lambda p: (round(abs((p[1] - p[0]) - expected), 1), abs(p[0] - (total - p[1]))))




def zipper_band_centre(height_segments: list[float]) -> float | None:
    """Where the zipper runs when no track is drawn: keylines draw the top seal, then narrow bands
    (notch, gap, zipper) above the body. The zipper band is the widest band between the top seal and
    the body; the zipper runs along its middle. FGPO7215: 10/12/13/267/10 -> 28.5 (track drawn at 28);
    FGPO7404: 10/9/3/13/250/10 -> 28.5; FGPO7535: 10/7/13/170/10 -> 23.5."""
    hs = height_segments
    if len(hs) < 4:  # FGPO7002: 20 (tear line) / 13 (zipper band) / 221 / 10 -> 26.5
        return None
    between = hs[1:-2]  # after the top seal, before the body and the bottom seal
    if not between:
        return None
    i = 1 + max(range(len(between)), key=lambda k: between[k])
    return round(sum(hs[:i]) + hs[i] / 2, 1)


def measure(
    pdf: Path,
    dimension_layers: list[str] | None,
    trim: Box,
    labels: LabelText,
    expected_width_mm: float | None,
    expected_height_mm: float | None,
    tol_mm: float = 0.5,
    exact_bleed: bool = False,
    label_tol_mm: float = LABEL_TOL_MM,
    size_tol_mm: float | None = None,
) -> tuple[MeasuredKeyline, Dieline]:
    """Keyline of the panel in `trim` (PDF user space).

    `exact_bleed`: `trim` was chosen by us from the dieline (a panel cut from a multi-panel sheet),
    so its edges are dieline lines by construction and the bleed/overall values need no printed label.
    """
    line = dieline(pdf, dimension_layers, trim)
    W, H = trim.width_mm, trim.height_mm
    nums = labels.numbers
    # No labels to check against at all (outlined labels with OCR off, a drawing without numbers):
    # the vector geometry is the only evidence and stands on its own; with labels present, a segment
    # none of them confirms stays below the review threshold.
    unconfirmed = UNCONFIRMED if nums else NO_LABELS

    def num(v: float | None) -> Num:
        """A confirmed measurement takes the printed label's value (2.2377 geometry -> '2.2375')."""
        if v is None:
            return Num(value=None, confidence=0.0)
        label = _label_for(v, nums, label_tol_mm)
        return Num(value=label if label is not None else round(v, 3), confidence=CONFIRMED if label is not None else unconfirmed)

    def exact(v: float | None, conf: float = CONFIRMED) -> Num:
        # 0.01 mm: the panel box comes from point coordinates and carries micrometre noise.
        return num(v) if not exact_bleed or v is None else Num(value=round(v, 2) + 0.0, confidence=conf)

    def segments(lines: list[float], pair: tuple[float, float] | None) -> NumList:
        if pair is None:
            return NumList(value=[], confidence=0.0)
        inner = [x for x in lines if pair[0] - 0.01 <= x <= pair[1] + 0.01]
        found = [num(b - a) for a, b in zip(inner, inner[1:])]
        return NumList(value=[f.value for f in found], confidence=min((f.confidence for f in found), default=0.0))

    # `size_tol_mm` (the index's dimension tolerance): a drawing whose finished size is that close to
    # the table's is still this pouch's keyline (FGPO7002: drawn 20 + 13 + 221 + 10 = 264, table 265)
    loose = max(tol_mm, size_tol_mm or 0.0)
    xp = _finished_pair(line.x_mm, W, expected_width_mm, tol_mm) or _finished_pair(line.x_mm, W, expected_width_mm, loose)
    yp = _finished_pair(line.y_mm, H, expected_height_mm, tol_mm) or _finished_pair(line.y_mm, H, expected_height_mm, loose)

    def bleed(v: float | None) -> float | None:
        # A box cut exactly at the dieline (a TrimBox that is the dieline, FGPO3970) puts the cut lines
        # a few micrometres outside it: no bleed, not a negative one.
        return 0.0 if v is not None and -0.1 < v < 0 else v
    finished_top = yp[0] if yp else 0.0
    widths, heights = segments(line.x_mm, xp), segments(line.y_mm, yp)
    if exact_bleed:
        # A panel cut at the dieline: its segments are exact vector geometry, and when they add up to the
        # spec table's size that second source confirms them (the printed labels on a sheet cut this way
        # are often too small to read).
        for lst, expected in ((widths, expected_width_mm), (heights, expected_height_mm)):
            if lst.value and expected is not None and abs(sum(lst.value) - expected) <= label_tol_mm:
                lst.confidence = max(lst.confidence, 0.9)
    zipper_y = [round(y - finished_top, 1) for y in line.zipper_y_mm]
    band = False
    if not zipper_y and (y := zipper_band_centre(heights.value)) is not None:
        zipper_y, band = [y], True
    keyline = MeasuredKeyline(
        overall_width_mm=exact(W, widths.confidence),
        overall_height_mm=exact(H, heights.confidence),
        bleed_left_mm=exact(bleed(xp[0] if xp else None)),
        bleed_right_mm=exact(bleed(W - xp[1] if xp else None)),
        bleed_top_mm=exact(bleed(yp[0] if yp else None)),
        bleed_bottom_mm=exact(bleed(H - yp[1] if yp else None)),
        width_segments_mm=widths,
        height_segments_mm=heights,
        zipper_line_drawn=Bool(value=bool(line.zipper_y_mm), confidence=0.95),
        zipper_y_mm=zipper_y,
        zipper_from_band=band,
        labels=labels.labels,
    )
    return keyline, line
