"""Ink names under the colour dots of the spec table.

Dots are found as vector circles; the name printed under each is OCR'd from an "ink amount"
image (255 - min(R, G, B)), in which yellow and light-grey "Sp White" text are as dark as black text.
"""

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

from PIL import Image, ImageChops

from app.ocr import tesseract
from app.ocr.table import erase_rules
from app.ocr.template import SpecTemplate
from app.pdf.layers import PT_TO_MM, Box
from app.pdf.vector import Dot, ink_dots

# Expected word in the label for process-colour dots, by dot colour.
_PROCESS = {
    "cyan": lambda r, g, b: r < 0.35 and g > 0.45 and b > 0.75,
    "magenta": lambda r, g, b: r > 0.75 and g < 0.35 and b > 0.35,
    "yellow": lambda r, g, b: r > 0.8 and g > 0.8 and b < 0.35,
    "black": lambda r, g, b: max(r, g, b) < 0.3,
    "white": lambda r, g, b: min(r, g, b) > 0.7 and max(r, g, b) - min(r, g, b) < 0.1,
}


@dataclass
class InkRead:
    name: str | None
    confidence: float
    dot_rgb: tuple[float, float, float]
    bbox: tuple[int, int, int, int]  # label area in render pixels
    dot_x: int = 0  # dot centre in render pixels


def _dot_class(rgb: tuple[float, float, float]) -> str | None:
    return next((name for name, test in _PROCESS.items() if test(*rgb)), None)


def read_inks(pdf: Path, render: Image.Image, render_box: Box, dpi: int, tpl: SpecTemplate,
              no_layers: bool = False, live_words: list[tesseract.Word] | None = None) -> list[InkRead]:
    """`render` is the colour render of `render_box` (PDF user space) at `dpi`.

    Dots are looked for on the template's ink-dot layers, or anywhere in `render_box` for files
    without layers. `live_words` (PDF text in render pixels) name a dot exactly when its label is live text.
    """
    dot_layers = None if no_layers else tpl.ink_dot_layers
    dots: list[Dot] = [d for d in ink_dots(pdf, dot_layers, tpl.ink_dot_diameter_mm) if _inside(d.box, render_box)]
    if not dots and dot_layers:
        # the dots on another layer than the template's (FGPO4002 has them beside its Dynamic Marks layer)
        dots = [d for d in ink_dots(pdf, None, tpl.ink_dot_diameter_mm) if _inside(d.box, render_box)]
    if not dots:
        dots = raster_dots(render, render_box, dpi, tpl.ink_dot_diameter_mm)  # dots drawn as images or clipped fills
    scale = dpi / 72
    label_h = tpl.ink_label_height_mm / PT_TO_MM
    out: list[InkRead] = []
    for i, dot in enumerate(dots):
        # Label spans half-way to the neighbouring dots.
        left = (dots[i - 1].box.x1 + dot.box.x0) / 2 if i > 0 else dot.box.x0 - (dot.box.x1 - dot.box.x0) / 4
        right = (dot.box.x1 + dots[i + 1].box.x0) / 2 if i + 1 < len(dots) else dot.box.x1 + (dot.box.x1 - dot.box.x0) / 4
        box = (
            max(0, round((left - render_box.x0) * scale)),
            max(0, round((render_box.y1 - dot.box.y0) * scale)),
            min(render.width, round((right - render_box.x0) * scale)),
            min(render.height, round((render_box.y1 - (dot.box.y0 - label_h)) * scale)),
        )
        if box[2] - box[0] < 2 or box[3] - box[1] < 2:
            continue  # a dot at the render's edge (a round artwork element beside the table): no label to read
        live = [w for w in live_words or [] if box[0] <= w.left + w.width / 2 <= box[2] and box[1] <= w.cy <= box[3]]
        if live:
            words = sorted(live, key=lambda w: w.left)
        else:
            words = _best_reading(_label_image(render.crop(box), dot.rgb), tpl)
        name = " ".join(w.text for w in words).strip(" |_—.:") or None
        conf = min((w.conf for w in words), default=0.0)
        expected = _dot_class(dot.rgb)
        if name:
            cleaned = _pantone(name)
            if cleaned != name or _PANTONE.fullmatch(name):
                name, conf = cleaned, max(conf, 0.86)  # a well-formed Pantone code confirms the read
            known = max(tpl.known_inks, key=lambda k: SequenceMatcher(None, k.lower(), name.lower()).ratio())
            if SequenceMatcher(None, known.lower(), name.lower()).ratio() >= 0.8:
                # Two independent signals agree (label spelling and dot colour): trust the known name.
                if expected and expected in known.lower():
                    conf = max(conf, 0.9)
                name = known
            if expected and expected not in name.lower():
                conf = min(conf, 0.5)  # a cyan dot labelled "Magenta" is suspect
        if expected and (not name or conf < 0.5):
            # The label is unreadable but the dot itself is unmistakably a process colour / a white plate.
            name, conf = expected.capitalize(), max(conf, 0.86)
        out.append(InkRead(name, round(conf, 3), dot.rgb, box, round(((dot.box.x0 + dot.box.x1) / 2 - render_box.x0) * scale)))
    return out


def split_value_additions(inks: list[InkRead], label_right_px: int | None) -> tuple[list[InkRead], list[InkRead]]:
    """(inks, value additions): dots right of the "Value Additions" label mark a value addition
    (e.g. a pink dot "Fully MATT Finish Pouch"), not an ink."""
    real = [i for i in inks if label_right_px is None or i.dot_x < label_right_px]
    if not real:  # the label is not after the ink row on this sheet: leave the dots alone
        return inks, []
    return real, [i for i in inks if i not in real]


def _first_line(img: Image.Image, min_rows: int = 6) -> Image.Image:
    """The first line of text in a dark-on-white band (rows up to the first blank gap after it)."""
    import numpy as np

    dark = (np.asarray(img.convert("L")) < 128).sum(axis=1) > 0
    rows = np.nonzero(dark)[0]
    if not len(rows):
        return img
    start = rows[0]
    end = start
    while end + 1 < len(dark) and (dark[end + 1] or (end + 2 < len(dark) and dark[end + 2])):
        end += 1
    if end - start + 1 < min_rows:
        return img
    pad = 6
    return img.crop((0, max(0, start - pad), img.width, min(img.height, end + pad + 1)))


_PANTONE = re.compile(r"(P(?:ANTONE)?)\s*([0-9A-Za-z]{3,5})\s*([CUM])", re.IGNORECASE)


def _pantone(name: str) -> str:
    """'P35z C' / 'PANTONE 2O5 C' -> 'P352 C': OCR letter/digit confusions inside a Pantone code."""
    m = _PANTONE.fullmatch(name.strip())
    if not m:
        return name
    digits = m.group(2).translate(str.maketrans("zZsSoOlIB", "225500118"))
    if not digits.isdigit():
        return name
    prefix = m.group(1).upper()
    gap = " " if prefix != "P" or re.match(r"P\s", name.strip(), re.IGNORECASE) else ""  # keep the printed "P 6053 C" / "P352 C" spacing
    return f"{prefix}{gap}{digits} {m.group(3).upper()}"


def _label_score(words: list[tesseract.Word], tpl: SpecTemplate) -> float:
    """How plausible an ink label reading is: a known ink or a Pantone code beats junk."""
    text = " ".join(w.text for w in words).strip(" |_—.:")
    if not text:
        return 0.0
    conf = min(w.conf for w in words)
    if _PANTONE.fullmatch(_pantone(text)) and re.search(r"\d{3,4}", _pantone(text)):
        return 3 + conf
    known = max(SequenceMatcher(None, k.lower(), text.lower()).ratio() for k in tpl.known_inks)
    if known >= 0.8:
        return 2 + conf
    letters = sum(c.isalnum() for c in text) / max(1, len(text))
    return letters + conf * 0.5


def _label_image(band: Image.Image, dot_rgb: tuple[float, float, float]) -> Image.Image:
    """The label under a dot as dark text on white, whatever colour it is printed in.

    Ink amount = 255 - min(R, G, B) makes yellow, light green or pale grey text as dark as black text
    once it is scaled by the dot's own ink amount (the label is printed in the dot's colour). The
    band is cut to its first text line before that, so a rule or the next row's black text below
    cannot set the contrast.
    """
    import numpy as np

    r, g, b = band.convert("RGB").split()
    ink = ImageChops.invert(ImageChops.darker(ImageChops.darker(r, g), b))  # 0 = paper
    a = np.asarray(ink)
    rough = erase_rules(Image.fromarray(np.where(a > 30, 0, 255).astype(np.uint8), "L"))
    rows = np.nonzero((np.asarray(rough) < 128).sum(axis=1) > 0)[0]
    top = int(rows[0]) if len(rows) else 0
    line = ink.crop((0, max(0, top - 6), ink.width, min(ink.height, top - 6 + _first_line(rough).height)))
    dot_ink = 255 - min(int(c * 255) for c in dot_rgb)
    norm = np.clip(np.asarray(line).astype(float) / max(40, dot_ink) * 255, 0, 255)
    return erase_rules(Image.fromarray((255 - norm).astype(np.uint8), "L"))


def _best_reading(line: Image.Image, tpl: SpecTemplate) -> list[tesseract.Word]:
    """OCR the label at several scales and page modes, grey and binarised; the most plausible reading wins."""
    best: list[tesseract.Word] = []
    best_score = -1.0
    for scale in (2, 3):
        img = line.resize((line.width * scale, line.height * scale), Image.LANCZOS)
        for variant in (img, img.point(lambda v: 0 if v < 128 else 255)):
            for psm in (7, 8):
                words = tesseract.words(variant, psm=psm, lang=tpl.tesseract_lang)
                text = " ".join(w.text for w in words).strip(" |_.:").lower()
                if words and min(w.conf for w in words) >= 0.85 and any(text == k.lower() for k in tpl.known_inks):
                    return words  # a confident, exact ink name: the other seven readings cannot beat it
                score = _label_score(words, tpl)
                if score > best_score:
                    best, best_score = words, score
    return best


def _inside(inner: Box, outer: Box) -> bool:
    return outer.x0 <= inner.x0 and inner.x1 <= outer.x1 and outer.y0 <= inner.y0 and inner.y1 <= outer.y1


def raster_dots(render: Image.Image, render_box: Box, dpi: int, diameter_mm: tuple[float, float], work_dpi: int = 30) -> list[Dot]:
    """Round colour blobs of dot size in the table render (for dots that are not vector circles).

    Works on a low-resolution copy: every non-white pixel is ink, connected regions whose box is
    near-square, of dot size and about pi/4 full are dots. Text and rules never pass those tests.
    """
    from collections import deque

    import numpy as np

    f = dpi / work_dpi
    small = render.convert("RGB").resize((max(1, round(render.width / f)), max(1, round(render.height / f))), Image.BOX)
    from app.ocr.keyline import erase_long_runs

    a = np.asarray(small).astype(int)
    ink = (a.max(axis=2) < 232) | ((a.max(axis=2) - a.min(axis=2)) > 40)  # dark, grey or coloured (light-grey White dots included)
    lo, hi = diameter_mm[0] / 25.4 * work_dpi, diameter_mm[1] / 25.4 * work_dpi
    # Table rules touch the dots at this resolution: whiten every straight run longer than a dot.
    cleaned = erase_long_runs(Image.fromarray(np.where(ink, 0, 255).astype(np.uint8), "L"), max_run=int(hi * 1.2))
    ink = np.asarray(cleaned) < 128
    H, W = ink.shape
    seen = np.zeros(ink.shape, dtype=bool)
    full = np.asarray(render.convert("RGB"))
    out: list[Dot] = []
    for y0, x0 in zip(*np.nonzero(ink)):
        if seen[y0, x0]:
            continue
        # 4-connected component by breadth-first search (a few tens of thousands of ink pixels at 30 dpi)
        queue, pixels = deque([(int(y0), int(x0))]), []
        seen[y0, x0] = True
        while queue:
            y, x = queue.popleft()
            pixels.append((y, x))
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < H and 0 <= nx < W and ink[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    queue.append((ny, nx))
        if len(pixels) < 4:
            continue
        ry, rx = np.array([p[0] for p in pixels]), np.array([p[1] for p in pixels])
        w, h = rx.max() - rx.min() + 1, ry.max() - ry.min() + 1
        if lo <= w <= hi and lo <= h <= hi and abs(w - h) <= 0.15 * max(w, h) and 0.65 <= len(pixels) / (w * h) <= 0.9:
            bx0, by0, bx1, by1 = rx.min() * f, ry.min() * f, (rx.max() + 1) * f, (ry.max() + 1) * f
            cy, cx = min(full.shape[0] - 1, int((by0 + by1) / 2)), min(full.shape[1] - 1, int((bx0 + bx1) / 2))
            colour = tuple(float(v) / 255 for v in full[cy, cx])
            s = 72 / dpi
            out.append(Dot(Box(render_box.x0 + bx0 * s, render_box.y1 - by1 * s, render_box.x0 + bx1 * s, render_box.y1 - by0 * s), colour))
    # The ink row is the one row of dots (a round logo elsewhere on the sheet is not an ink).
    rows: list[list[Dot]] = []
    for d in sorted(out, key=lambda d: -d.box.y1):
        cy = (d.box.y0 + d.box.y1) / 2
        row = next((r for r in rows if abs((r[0].box.y0 + r[0].box.y1) / 2 - cy) <= (r[0].box.y1 - r[0].box.y0) / 2), None)
        if row is None:
            rows.append([d])
        else:
            row.append(d)
    best = max(rows, key=len, default=[])
    return sorted(best, key=lambda d: d.box.x0) if len(best) >= 3 else []
