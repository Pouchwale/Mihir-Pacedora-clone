"""Where the artwork, the dimension drawing and the spec table are on an approval PDF.

Three kinds of file are handled (PdfProfile.layout_mode):

layers      ArtPro+ exports. Artwork, dimensions and spec table are separate layers and the TrimBox
            is the artwork plus bleed (spec 2.1). Strict checks: producer, layers, TrimBox.
separation  Files without layers (Adobe Illustrator, PDFium re-saves). Everything is on one page;
            the dieline and the dimension labels are painted in a technical spot ink ("Dimensions
            and text" or a name like it), and the TrimBox is just the page. The artwork area is the
            dieline's outer rectangle, measured from the vector lines of a technical-ink-only copy
            of the page. A sheet may carry the dieline several times (print repeats): the first is
            used and the count recorded.
page        No layers and no dieline (plain artwork). The whole page is the front artwork and the
            job pauses for the pouch details (profile.page_fallback).

Everything downstream works on `Sheet.trim` exactly like on an ArtPro+ TrimBox. The colorant
names the file really uses are classed (white / varnish / technical) once, in `Sheet.inks`.
"""

import tempfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal

from app.errors import NeedsReview
from app.pdf.layers import PT_TO_MM, Box, PdfFacts, read_facts, write_layer_copy
from app.pdf.paint import separations
from app.pdf.profile import InkClasses, PdfProfile
from app.pdf.vector import COPY_FRAC, dashed_lines, copy_offset, dieline, dieline_grids, grid_repeats, line_networks, painted_extent, same_size, typical_network

Mode = Literal["layers", "separation", "page"]


def _area(b: Box) -> float:
    return max(0.0, b.x1 - b.x0) * max(0.0, b.y1 - b.y0)


def _declared_dieline(only: Path, facts: PdfFacts, tol_mm: float = 0.5) -> Box | None:
    """The file's TrimBox when it is a real box on the page (not the page itself, not outside it,
    as PDFium re-saves write) and the technical-ink drawing has a dieline line on each of its four
    edges; otherwise None."""
    tb, mb = facts.trim_box, facts.media_box
    if tb is None or tb.same_as(mb) or tb.width_mm < 20 or tb.height_mm < 20:
        return None
    slack = 1 / PT_TO_MM
    if tb.x0 < mb.x0 - slack or tb.y0 < mb.y0 - slack or tb.x1 > mb.x1 + slack or tb.y1 > mb.y1 + slack:
        return None
    lines = dieline(only, None, tb, raster=False)
    w, h = tb.width_mm, tb.height_mm
    on = lambda values, v: any(abs(x - v) <= tol_mm for x in values)  # noqa: E731
    if on(lines.x_mm, 0) and on(lines.x_mm, w) and on(lines.y_mm, 0) and on(lines.y_mm, h):
        return tb
    return None


def _to_cut_lines(box: Box, nets, only: Path, reach_mm: float = 25.0) -> Box:
    """A copy cut out of a merged grid, stretched along its height to the outermost full-width lines
    of its own drawing (FGPO6786: the grid stops at the gusset's inner seal, 13 mm short of the web's
    bottom cut and bleed)."""
    home = next((n for n in nets if _overlap(n.box, box) >= 0.9 * _area(box)), None)
    if home is None:
        return box
    column = Box(box.x0, home.box.y0, box.x1, home.box.y1)
    ys = dieline(only, None, column, raster=False).y_mm  # mm from the column's top
    if not ys:
        return box
    top, bottom = column.y1 - min(ys) / PT_TO_MM, column.y1 - max(ys) / PT_TO_MM
    reach = reach_mm / PT_TO_MM
    return Box(box.x0, bottom if box.y0 - reach <= bottom < box.y0 else box.y0, box.x1, top if box.y1 < top <= box.y1 + reach else box.y1)


def _first_copy(box: Box, grids, gap_mm: float = 15.0, tol_mm: float = 1.0) -> Box | None:
    """The first of several copies a dieline grid spans side by side (FGPO6786: the artwork column
    and its Sp White preview line up into one 353 mm grid). Copies show as cells of one width whose
    columns are separated by an empty gap; the panels of one web (gusset | face | gusset | face)
    touch or sit a few mm apart, so they never qualify."""
    tol, gap = tol_mm / PT_TO_MM, gap_mm / PT_TO_MM
    # cells within the grid's width (they may reach past its top or bottom edge: FGPO6786's start below it)
    cells = [g.box for g in grids if box.x0 - tol <= g.box.x0 and g.box.x1 <= box.x1 + tol
             and _overlap(g.box, box) >= 0.5 * _area(g.box) and g.box.width_mm < 0.6 * box.width_mm]
    for a in sorted(cells, key=lambda c: c.x0):
        for b in cells:
            if abs((b.x1 - b.x0) - (a.x1 - a.x0)) <= tol and b.x0 - a.x1 >= gap:
                return Box(a.x0, box.y0, a.x1, box.y1)
    return None


def _copy_by_lines(home: Box, grids, only: Path, gap_mm: float = 15.0, tol_mm: float = 0.5) -> Box | None:
    """The first of two copies drawn side by side in one network of lines, found by its repeated
    vertical lines (FGPO6785 / FGPO6787: the artwork and its Sp White preview are joined by their
    dimension lines, and no closed grid frames the artwork copy alone). At least three full-height
    lines must repeat at one shift, with an empty gap between the copies (panels of one web touch).
    Where a closed cell inside the copy is a little narrower (its cut lines, the copy's outer lines
    being the bleed: FGPO6782 / FGPO6784), the copy is cut to that cell's width."""
    xs = sorted(dieline(only, None, home, min_span=0.9, raster=False).x_mm)
    found: list[float] = []
    for d in sorted({round(b - a, 1) for a in xs for b in xs if b - a >= gap_mm}):
        firsts = [a for a in xs if any(abs(b - a - d) <= tol_mm for b in xs)]
        # (the artwork copy is the first: it starts on the network's left edge)
        if len(firsts) > max(2, len(found)) and firsts[0] == xs[0] and d - (firsts[-1] - firsts[0]) >= gap_mm:
            found = firsts
    if not found:
        return None
    x0, x1, tol = home.x0 + found[0] / PT_TO_MM, home.x0 + found[-1] / PT_TO_MM, tol_mm / PT_TO_MM
    cut = next((g.box for g in grids if x0 - tol <= g.box.x0 and g.box.x1 <= x1 + tol
                and tol < (x1 - x0) - (g.box.x1 - g.box.x0) <= 3 / PT_TO_MM), None)
    return Box(cut.x0 if cut else x0, home.y0, cut.x1 if cut else x1, home.y1)


def _is_preview(pdf: Path, box: Box) -> bool:
    """Whether `box` on the page shows a separation preview and nothing else: the white plate drawn
    as a flat grey copy of the artwork (FGPO6786 "Sp White"). Artwork there (FGPO7024: the second
    gusset of a pair) or a blank dieline (FGPO7530: unprinted ups) means the drawings beside the
    first are panels or ups of the job, not a preview of it."""
    import numpy as np
    import pymupdf

    if box.x1 - box.x0 < 10 / PT_TO_MM:
        return False
    doc = pymupdf.open(pdf)
    try:
        page = doc[0]
        clip = pymupdf.Rect(box.x0, box.y0, box.x1, box.y1) * page.transformation_matrix
        pix = page.get_pixmap(dpi=20, clip=clip.normalize(), colorspace=pymupdf.csRGB, alpha=False)
        rgb = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.stride)[:, : pix.width * 3].reshape(pix.height, pix.width, 3).astype(np.int16)
    finally:
        doc.close()
    hi, lo = rgb.max(axis=2), rgb.min(axis=2)
    flat = (hi - lo) < 0.12 * np.maximum(hi, 1)
    grey = flat & (hi >= 110) & (hi < 240)
    coloured = ~flat & (lo < 240)  # (dimension lines, labels and callouts around a preview: FGPO7058 has 9 %)
    return bool(grey.mean() >= 0.2 and coloured.mean() < 0.2)


def _whole_web(cell: Box, nets, grids, tol_mm: float = 1.0) -> Box | None:
    """The web a closed dieline cell is one face of: FGPO7152 draws front (upside down) over back as
    one network of lines 2 x the face tall, but only the back closes into a grid. When the network
    around the cell is a whole multiple (2-4) of it along one axis and no other copy of the cell was
    found there (a second copy would be a print repeat, kept apart), that whole extent is the dieline."""
    tol = tol_mm / PT_TO_MM
    home = next((n for n in nets if _overlap(n.box, cell) >= 0.9 * _area(cell)), None)
    if home is None:
        return None
    n = home.box
    for axis in ("y", "x"):
        lo, hi = (n.y0, n.y1) if axis == "y" else (n.x0, n.x1)
        size = (cell.y1 - cell.y0) if axis == "y" else (cell.x1 - cell.x0)
        k = round((hi - lo) / size)
        if not 2 <= k <= 4 or abs((hi - lo) - k * size) > tol:
            continue
        others = [g for g in grids if g.box is not cell and same_size(g.box, cell, tol_mm=tol_mm) and _overlap(g.box, n) >= 0.9 * _area(g.box)
                  and not (abs(g.box.x0 - cell.x0) <= tol and abs(g.box.y0 - cell.y0) <= tol)]
        if others:
            continue  # the other faces are drawn as closed cells of their own: copies / ups
        return Box(cell.x0, lo, cell.x1, hi) if axis == "y" else Box(lo, cell.y0, hi, cell.y1)
    return None


def _overlap(a: Box, b: Box) -> float:
    return max(0.0, min(a.x1, b.x1) - max(a.x0, b.x0)) * max(0.0, min(a.y1, b.y1) - max(a.y0, b.y0))


@dataclass(frozen=True)
class Sheet:
    mode: Mode
    trim: Box  # artwork area incl. any drawn bleed, PDF user space
    technical: Box | None  # separation: extent of the dieline + dimension drawing
    facts: PdfFacts
    inks: InkClasses
    repeats: int = 1  # separation: how many times the dieline is on the sheet
    # layers: the layers that carry the artwork (the profile's names when the file has them, else
    # every layer that is not a spec / dimension / eyemark layer); warnings: what differs from an
    # ArtPro+ export but does not stop the job
    artwork_layers: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    # separation, several copies of the drawing on the sheet: the lines are read from the fullest
    # copy (the technical preview carries the whole keyline, the artwork copy often only part of it),
    # which lies this far (PDF points) from `trim`, the copy the artwork is rendered from.
    drawing_offset: tuple[float, float] = (0.0, 0.0)
    # the dieline is drawn in dashes: read its lines inside vector.dashed_lines(sheet.dashed)
    dashed: bool = False

    def texture_layers(self, profile: PdfProfile) -> list[str]:
        return [*self.artwork_layers, *(profile.eyemark_layers if profile.include_eyemarks else [])]

    def drawing_box(self, box: Box) -> Box:
        """`box` (inside `trim`) moved onto the copy the keyline is measured from."""
        dx, dy = self.drawing_offset
        return Box(box.x0 + dx, box.y0 + dy, box.x1 + dx, box.y1 + dy)


def artwork_layers_of(facts: PdfFacts, profile: PdfProfile) -> list[str]:
    """The layers that carry the artwork: everything that is not a spec, dimension or eyemark layer
    (so background layers, images and artwork layers all stay visible)."""
    other = {*profile.spec_layers, *profile.dimension_layers, *profile.ignore_layers,
             *(profile.eyemark_layers if not profile.include_eyemarks else [])} - set(profile.artwork_layers)  # (named as artwork: it is)
    art = [n for n in facts.layers if n not in other]
    if art:
        return art
    return [n for n in profile.artwork_layers if n in facts.layers]


def check_layers_pdf(facts: PdfFacts, profile: PdfProfile, strict: bool = False) -> list[str]:
    """The rules of spec 2.1 (f) for layered files. What makes the file unusable raises (no page,
    no TrimBox, no artwork or dimension layer at all); what merely differs from an ArtPro+ export
    (producer, renamed artwork layer, a missing spec layer) is returned as warnings, or raised too
    when the profile forces `layout_mode: layers` (`strict`)."""
    problems: list[dict] = []
    warnings: list[dict] = []
    if facts.page_count != 1:
        problems.append({"code": "page_count", "message": f"Expected 1 page, found {facts.page_count}"})
    if facts.trim_box is None:
        problems.append({"code": "no_trimbox", "message": "PDF has no TrimBox"})
    elif facts.trim_box.same_as(facts.media_box):
        problems.append({"code": "trimbox_is_mediabox", "message": "TrimBox equals MediaBox, so the artwork area is unknown"})
    if not facts.producer.startswith(profile.expected_producer) or not facts.creator.startswith(profile.expected_creator_prefix):
        warnings.append({
            "code": "unexpected_producer",
            "message": f"Not an {profile.expected_creator_prefix} / {profile.expected_producer} export "
                       f"(creator {facts.creator!r}, producer {facts.producer!r})",
        })
    artwork = artwork_layers_of(facts, profile)
    if not any(n in facts.layers for n in profile.artwork_layers):
        # no artwork layer at all (FGPO4003 has only the dimension layer): the artwork is what is
        # painted outside the layers, which a copy with every layer off still shows
        warnings.append({
            "code": "layer_missing",
            "message": f"Expected layer(s) not found: {', '.join(profile.artwork_layers)}; artwork taken from "
                       + (', '.join(artwork) if artwork else "the content outside the layers"),
        })
    missing_dims = [n for n in profile.dimension_layers if n not in facts.layers]
    if missing_dims:
        problems.append({"code": "layer_missing", "message": f"Expected layer(s) not found: {', '.join(missing_dims)}"})
    missing_spec = [n for n in profile.spec_layers if n not in facts.layers]
    if missing_spec:
        warnings.append({"code": "layer_missing", "message": f"Expected layer(s) not found: {', '.join(missing_spec)}"})
    if strict:
        problems, warnings = problems + warnings, []
    if problems:
        raise NeedsReview(
            problems[0]["code"],
            "; ".join(p["message"] for p in problems),
            {"problems": problems, "layers_found": facts.layers},
        )
    return [w["message"] for w in warnings]


def mode_for(facts: PdfFacts, profile: PdfProfile) -> Literal["layers", "separation"]:
    if profile.layout_mode != "auto":
        return profile.layout_mode
    # A file with layers is read as a layered file when it has the dimension layer (the ArtPro+
    # structure, whatever the artwork layers are called); other layered files (a designer's own
    # layers) are read like files without layers: dieline in the technical ink, or the plain page.
    return "layers" if facts.layers and all(n in facts.layers for n in profile.dimension_layers) else "separation"


_COPY_DIR: Path | None = None
_COPIES: dict[tuple, Path] = {}
_SHEETS: dict[tuple, "Sheet"] = {}


def _file_key(pdf: Path) -> tuple:
    st = pdf.stat()
    return (str(pdf), st.st_mtime_ns, st.st_size)


def technical_copy(pdf: Path, dst: Path, technical: set[str], crop: Box | None = None) -> Path:
    """A copy of the page with only the technical ink painted (dieline + dimension labels).

    Filtering a page's paint means parsing its whole content stream (10 s and more on a large sheet),
    and one job needs this copy in every step: the uncropped copy is made once per file and kept for
    the life of the process (the last few files); `dst` is only written for a cropped copy, cut from it."""
    return _filtered_copy(pdf, dst, technical, crop, "only")


def non_technical_copy(pdf: Path, dst: Path, technical: set[str], crop: Box | None = None) -> Path:
    """The page without what the technical ink paints (the artwork and the spec table), cached like
    `technical_copy`: the texture render and the spec-table render are both cut from it."""
    return _filtered_copy(pdf, dst, technical, crop, "strip")


def _copy_path(key: tuple) -> Path:
    global _COPY_DIR
    if _COPY_DIR is None:
        _COPY_DIR = Path(tempfile.mkdtemp(prefix="pouch_technical_"))
    return _COPY_DIR / f"{abs(hash(key)):x}.pdf"


def _filtered_copy(pdf: Path, dst: Path, technical: set[str], crop: Box | None, mode: str) -> Path:
    key = (*_file_key(pdf), tuple(sorted(technical)), mode)
    full = _COPIES.get(key)
    if full is None or not full.exists():
        full = _copy_path(key)
        write_layer_copy(pdf, full, None, read_facts(pdf).media_box, **{mode: technical})
        while len(_COPIES) >= 12:
            _COPIES.pop(next(iter(_COPIES))).unlink(missing_ok=True)
        _COPIES[key] = full
    if crop is None:
        return full
    write_layer_copy(full, dst, None, crop)
    return dst


def artwork_page(pdf: Path) -> int:
    """Which page of a multi-page approval PDF carries the artwork (0-based).

    Printers put a cover page ("STOP! Read carefully before giving approval", QR codes) in front
    of the sheet. The artwork page is the one with the most drawing: images count heavily (the
    design), vector paths (dieline, table, text outlines) count once. Ties go to the first page.
    """
    import pymupdf

    doc = pymupdf.open(pdf)
    try:
        if len(doc) <= 1:
            return 0
        scores = [len(page.get_drawings()) + 25 * len(page.get_images()) for page in doc]
    finally:
        doc.close()
    return max(range(len(scores)), key=lambda i: (scores[i], -i))


def single_page_copy(src: Path, dst: Path, page: int) -> Path:
    """`src` reduced to one page (the rest of the pipeline works on page 1 of a file). A clone keeps
    the document's layers, OutputIntent and metadata; only the other pages go."""
    from pypdf import PdfWriter

    writer = PdfWriter(clone_from=src)
    for i in reversed(range(len(writer.pages))):
        if i != page:
            writer.remove_page(i)
    dst.parent.mkdir(parents=True, exist_ok=True)
    with dst.open("wb") as fh:
        writer.write(fh)
    return dst


def analysed(pdf: Path, profile: PdfProfile) -> bool:
    """Whether `analyse` has this file's sheet cached (another thread may read it without redoing it)."""
    return (*_file_key(pdf), profile.model_dump_json()) in _SHEETS


def analyse(pdf: Path, profile: PdfProfile) -> Sheet:
    """The sheet read normally; a file whose technical ink holds no dieline by the normal reading is
    read again with dashed lines joined (a dieline drawn entirely in dashes: FGPO4583), and keeps
    `dashed` so every later reading of its lines joins them too (vector.dashed_lines)."""
    # (every step of a job, and every panel lookup, asks for the same file's sheet: analysed once)
    key = (*_file_key(pdf), profile.model_dump_json())
    if key in _SHEETS:
        return _SHEETS[key]
    while len(_SHEETS) >= 16:
        _SHEETS.pop(next(iter(_SHEETS)))
    try:
        sheet = _analyse(pdf, profile)
    except NeedsReview as exc:
        if exc.code != "no_dieline":
            raise
        sheet, first = None, exc
    if sheet is not None and not (sheet.mode == "page" and sheet.inks.technical):
        _SHEETS[key] = sheet
        return sheet
    with dashed_lines():
        try:
            again = _analyse(pdf, profile)
        except NeedsReview:
            again = None
    if again is not None and again.mode == "separation":
        sheet = replace(again, dashed=True, warnings=(*again.warnings, "Dieline drawn in dashes: read with the dashes joined"))
    if sheet is None:
        raise first
    _SHEETS[key] = sheet
    return sheet


def _analyse(pdf: Path, profile: PdfProfile) -> Sheet:
    facts = read_facts(pdf)
    inks = profile.classify_inks(separations(pdf))
    if mode_for(facts, profile) == "layers":
        try:
            warnings = check_layers_pdf(facts, profile, strict=profile.layout_mode == "layers")
            return Sheet("layers", facts.trim_box, None, facts, inks, artwork_layers=tuple(artwork_layers_of(facts, profile)),  # type: ignore[arg-type]
                         warnings=tuple(warnings))
        except NeedsReview as exc:
            # no usable TrimBox: the dieline (or the page) tells where the artwork is, as for a file without layers
            if profile.layout_mode == "layers" or exc.code not in ("trimbox_is_mediabox", "no_trimbox"):
                raise

    if facts.page_count != 1:
        raise NeedsReview("page_count", f"Expected 1 page, found {facts.page_count}",
                          {"problems": [{"code": "page_count", "message": f"Expected 1 page, found {facts.page_count}"}]})
    best, technical, warnings, offset = None, None, [], (0.0, 0.0)
    if inks.technical:
        with tempfile.TemporaryDirectory() as tmp:
            only = technical_copy(pdf, Path(tmp) / "technical.pdf", inks.technical)
            declared = _declared_dieline(only, facts)
            if declared is not None:
                # The file says where the pouch is (an ArtPro+ export flattened by Adobe: FGPO3970) and
                # the dieline agrees on all four edges: nothing on the sheet (a separate gusset drawing,
                # a white-ink preview, dimension lines between them) can move it.
                warnings.append(f"Dieline taken from the file's TrimBox ({declared.width_mm:.2f} x {declared.height_mm:.2f} mm), "
                                "confirmed by dieline lines on its four edges")
                return Sheet("separation", declared, painted_extent(only, declared), facts, inks, warnings=tuple(warnings))
            grids = dieline_grids(only)
            if grids:
                # Filter out secondary separation preview plates (e.g. Sp White, Spot Gloss) placed to the right
                # of an artwork dieline of matching size.
                candidates = [
                    g for g in grids
                    if not any(
                        o is not g and o.box.x0 < g.box.x0 - 20 and
                        abs(o.box.width_mm - g.box.width_mm) <= 15 and
                        abs(o.box.height_mm - g.box.height_mm) <= 15
                        for o in grids
                    )
                ]
                use_grids = candidates if candidates else grids
                full = max(use_grids, key=lambda g: g.lines).box
                best = next((g.box for g in use_grids if same_size(g.box, full, tol_mm=10.0)), full)
                repeats = grid_repeats(grids, best)
            # A closed grid that is only a cell of a larger network of crossing lines (an imposition of
            # several ups whose edges are broken at every band line, FGPO7165; a web whose outer lines
            # overshoot the corners, FGPO7442): the network's outer rectangle is the dieline, and the
            # sheet layout splits it into ups and panels. Copies of the network: the first is used.
            nets = line_networks(only)
            typical = typical_network(nets)
            own = None  # the network of the copy the artwork is rendered from
            if best is not None and typical is not None:
                # One closed grid around two identical drawings (FGPO7166: the gusset sheet and its
                # Sp White preview share their outer lines): the first drawing is the dieline.
                twins = sorted((n for n in nets if same_size(n.box, typical.box, frac=COPY_FRAC) and _overlap(n.box, best) >= 0.9 * _area(n.box)),
                               key=lambda n: n.box.x0)
                if len(twins) >= 2 and _is_preview(pdf, twins[-1].box):
                    first_net = twins[0].box
                    warnings.append(f"The {best.width_mm:.2f} mm wide grid spans {len(twins)} identical drawings (artwork + separation preview): "
                                    f"the first, {first_net.width_mm:.2f} mm wide, is used")
                    best = first_net
            if typical is not None and (best is None or _area(best) < 0.25 * _area(typical.box)):
                # No closed grid, or only a cell of the drawing: the dieline is the first copy of the
                # network of crossing lines (the first carries the artwork).
                w, h = typical.box.x1 - typical.box.x0, typical.box.y1 - typical.box.y0
                if best is None:
                    warnings.append(f"No closed grid of technical-ink lines: the dieline is the {w * PT_TO_MM:.2f} x {h * PT_TO_MM:.2f} mm "
                                    "network of crossing lines")
                else:
                    warnings.append(f"Dieline taken from the {w * PT_TO_MM:.2f} x {h * PT_TO_MM:.2f} mm network of crossing lines; "
                                    f"the closed grid found ({best.width_mm:.2f} x {best.height_mm:.2f} mm, {repeats} on the sheet) is one of its cells")
                best, own = typical.box, typical
                repeats = sum(1 for n in nets if same_size(n.box, typical.box, frac=COPY_FRAC))
            elif best is not None:
                # the grid's own network: the first copy inside it (a grid may hold several ups)
                inside = [n for n in nets if _overlap(n.box, best) >= 0.9 * _area(n.box)]
                own = inside[0] if inside else max((n for n in nets if _overlap(n.box, best) > 0.5 * _area(best)), key=lambda n: n.crossings, default=None)
            if best is not None and own is not None:
                # A closed cell found only on a separation preview (FGPO7153: the Sp White copy closes,
                # the artwork copy's outline is broken by the artwork): the artwork is the identical
                # copy to its left, as for grids above. Move the cell onto it.
                lefts = [n for n in nets if n is not own and n.box.x1 <= own.box.x0 and abs(n.box.y0 - own.box.y0) < 10 / PT_TO_MM
                         and same_size(n.box, own.box, frac=COPY_FRAC)]
                first = min(lefts, key=lambda n: n.box.x0) if lefts else None
                to_own = copy_offset(first, own) if first is not None else None
                moved = to_own is not None
                if moved:
                    best = Box(best.x0 - to_own[0], best.y0 - to_own[1], best.x1 - to_own[0], best.y1 - to_own[1])
                    own = first
                    warnings.append("The closed dieline cell is on a separation preview; the artwork copy to its left is used")
            if best is not None and own is not None:
                # The lines are read from the fullest copy of that size, moved onto the artwork copy
                # (copies are translations): a technical preview beside the artwork has the whole
                # keyline, the artwork copy often only part of it (FGPO7165, FGPO7410).
                alike = [n for n in nets if same_size(n.box, own.box, frac=COPY_FRAC)]
                drawing = max(alike, key=lambda n: n.crossings) if alike else own
                # the shift between the copies comes from their crossing points (their boxes may
                # differ by a frame or a dimension line); a copy that does not line up is not used
                shift = copy_offset(own, drawing) if drawing is not own and drawing.crossings > own.crossings else None
                if shift is not None:
                    offset = shift
                    if own is typical and not moved:
                        # the fullest copy's extent, moved back onto the artwork copy (a closed cell moved
                        # off a preview above is already the dieline)
                        d = drawing.box
                        best = Box(d.x0 - shift[0], d.y0 - shift[1], d.x1 - shift[0], d.y1 - shift[1])
                    warnings.append(f"Keyline measured on copy {alike.index(drawing) + 1} of {len(alike)} ({drawing.crossings} line crossings, "
                                    f"the artwork copy has {own.crossings})")
                technical = painted_extent(only, drawing.box if offset != (0.0, 0.0) else best)
            elif best is not None:
                technical = painted_extent(only, best)
            if best is not None:
                home = next((n.box for n in nets if _overlap(n.box, best) >= 0.5 * _area(best)), None)
                # Artwork and preview joined into ONE network by their dimension lines. When the preview
                # is a network of its own (FGPO7165: a 2-up imposition beside its keyline copy), what
                # repeats inside the artwork network is its ups, and the whole of it is the dieline.
                joined = home is None or not any(n.box is not home and same_size(n.box, home, frac=COPY_FRAC) for n in nets)
                bound = home or best

                def beside_is_preview(copy: Box | None) -> bool:
                    """What lies right of `copy` in the drawing is its separation preview only."""
                    # (one copy wide: a second up before the preview makes the rest twice as wide, FGPO6752)
                    return (copy is not None and bound.x1 - copy.x1 <= 1.6 * (copy.x1 - copy.x0)
                            and _is_preview(pdf, Box(copy.x1, bound.y0, bound.x1, bound.y1)))

                first = _first_copy(best, grids) if joined else None
                if not beside_is_preview(first):
                    first = None  # (FGPO6752: the cell is one of two ups; FGPO7024: one of two gussets)
                if first is None and home is not None and joined:
                    copy = _copy_by_lines(home, grids, only)
                    # the dieline found reaches past the artwork copy into its preview
                    if copy is not None and best.x1 > copy.x1 + 3 / PT_TO_MM and beside_is_preview(copy):
                        first = copy
                if first is not None:
                    warnings.append(f"The {best.width_mm:.2f} mm wide dieline holds copies side by side (artwork + separation preview): "
                                    f"the first, {first.width_mm:.2f} mm wide, is used")
                    best = _to_cut_lines(first, nets, only)
                    technical = painted_extent(only, best)
                web = _whole_web(best, nets, grids)
                if web is not None:
                    warnings.append(f"Dieline cell {best.width_mm:.2f} x {best.height_mm:.2f} mm is one face of a {web.width_mm:.2f} x "
                                    f"{web.height_mm:.2f} mm web drawn as one network of lines: the web is used")
                    dx, dy = offset  # the keyline is read on the fullest copy, this far from the artwork copy
                    best, technical = web, painted_extent(only, Box(web.x0 + dx, web.y0 + dy, web.x1 + dx, web.y1 + dy))
    if best is not None:
        return Sheet("separation", best, technical, facts, inks, repeats=repeats, warnings=tuple(warnings), drawing_offset=offset)
    if not profile.page_fallback:
        code = "no_dieline" if inks.technical else "no_technical_ink"
        raise NeedsReview(code, "No dieline (closed grid of technical-ink lines) found around the artwork" if inks.technical else
                          "File has no layers and no technical ink, so the dieline cannot be told apart from the artwork",
                          {"problems": [{"code": code}], "layers_found": facts.layers, "separations": sorted(inks.hidden())})
    return Sheet("page", facts.media_box, None, facts, inks)
