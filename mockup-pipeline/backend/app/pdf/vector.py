"""Vector geometry from the PDF (PyMuPDF drawings, which carry their optional-content layer).

Coordinates returned here are PDF user space (points, y up) so they line up with page boxes and
with renders made by app.pdf.render. PyMuPDF's own page space (y down, origin at the MediaBox's
top-left) is converted with the page's transformation matrix, never by hand.
"""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path

import pymupdf

from app.pdf.layers import PT_TO_MM, Box

# A dieline drawn entirely in dashes (FGPO4583: 3.53 mm dashes and gaps, even the cut edge) has
# no piece long enough to be a line. Such files are read with dashes joined; only files whose normal
# reading finds no dieline at all switch this on (app.pdf.sheet), so zipper tracks and teeth on every
# other file are read as before.
_DASHED: ContextVar[bool] = ContextVar("dashed_dieline", default=False)
DASH_MIN_MM, DASH_GAP_MAX_MM, DASH_MIN_COUNT = 2.5, 4.0, 4


@contextmanager
def dashed_lines(on: bool = True):
    token = _DASHED.set(on)
    try:
        yield
    finally:
        _DASHED.reset(token)


@dataclass(frozen=True)
class Dot:
    box: Box  # PDF user space
    rgb: tuple[float, float, float]


@dataclass(frozen=True)
class Dieline:
    """Long straight lines of the dieline, as offsets from the TrimBox's left / top edge in mm."""

    x_mm: list[float]
    y_mm: list[float]
    zipper_y_mm: list[float]  # centre lines of long zig-zag / dashed tracks


_DRAWINGS_CACHE: dict[tuple[str, int, int], tuple] = {}
_SEGMENT_CACHE: dict[tuple, tuple] = {}
_INK_CACHE: dict[tuple, tuple] = {}


def _drawings(pdf: Path):
    """A page's drawings and the matrix to PDF user space; the last few files are kept (one analysis
    reads the same technical-ink copy three or four times, and an 85 MB sheet takes seconds each)."""
    st = pdf.stat()
    key = (str(pdf), st.st_mtime_ns, st.st_size)
    hit = _DRAWINGS_CACHE.get(key)
    if hit is not None:
        return hit
    doc = pymupdf.open(pdf)
    try:
        page = doc[0]
        out = (page.get_drawings(), ~page.transformation_matrix)
    finally:
        doc.close()  # Windows keeps an open file locked (temporary copies must be deletable)
    while len(_DRAWINGS_CACHE) >= 6:
        _DRAWINGS_CACHE.pop(next(iter(_DRAWINGS_CACHE)))
    _DRAWINGS_CACHE[key] = out
    return out


def render_gray(pdf: Path, box: Box, dpi: int):
    """`box` (PDF user space) of page 1 as a greyscale array, rendered in-process (no Poppler run)."""
    import numpy as np

    doc = pymupdf.open(pdf)
    try:
        page = doc[0]
        clip = pymupdf.Rect(box.x0, box.y0, box.x1, box.y1) * page.transformation_matrix
        pix = page.get_pixmap(dpi=dpi, clip=clip.normalize(), colorspace=pymupdf.csGRAY)
        return np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.stride)[:, : pix.width].copy()
    finally:
        doc.close()


_RASTER_CACHE: dict[tuple, tuple[list[float], list[float]]] = {}
RASTER_DPI, RASTER_LINE_MAX_MM = 300, 1.2


def _raster_lines(pdf: Path, trim: Box, min_span: float) -> tuple[list[float], list[float]]:
    """Thin straight lines painted by images, as mm from the trim's left / top edge.

    Some exports flatten the dieline into raster tiles (FGPO6292: every seal and fold line of the web
    is an image in DeviceN process + "Dimensions and text"; only the frame is a vector). On a copy
    already filtered to the technical ink those tiles are all the page's images, so a row or column
    that is ink across at least `min_span` of the box, in a band no thicker than a stroke, is a
    dieline line. A page without images is never rendered."""
    st = pdf.stat()
    box_key = (str(pdf), st.st_mtime_ns, st.st_size, round(trim.x0, 1), round(trim.y0, 1), round(trim.x1, 1), round(trim.y1, 1))
    key = (*box_key, min_span)
    if key in _RASTER_CACHE:
        return _RASTER_CACHE[key]
    import numpy as np

    if box_key not in _INK_CACHE:  # the render is the cost; every span of one box reads the same one
        doc = pymupdf.open(pdf)
        try:
            page = doc[0]
            ink, first = None, (0.0, 0.0)
            if page.get_images():
                clip = pymupdf.Rect(trim.x0, trim.y0, trim.x1, trim.y1) * page.transformation_matrix
                clip.normalize()
                pix = page.get_pixmap(dpi=RASTER_DPI, clip=clip, colorspace=pymupdf.csGRAY)
                ink = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.stride)[:, : pix.width] < 200
                scale = RASTER_DPI / 72
                # where the pixmap starts before the clip's edge (it is snapped to whole pixels)
                first = (pix.x - clip.x0 * scale, pix.y - clip.y0 * scale)
        finally:
            doc.close()
        while len(_INK_CACHE) >= 4:
            _INK_CACHE.pop(next(iter(_INK_CACHE)))
        _INK_CACHE[box_key] = (None, None, first) if ink is None else (ink.mean(axis=0), ink.mean(axis=1), first)
    cols, rows, first = _INK_CACHE[box_key]
    out: tuple[list[float], list[float]] = ([], [])
    if cols is not None:
        per_mm = RASTER_DPI / 25.4

        def bands(share: "np.ndarray", first_px: float) -> list[float]:
            hit, found, start = share >= min_span, [], None
            for i, on in enumerate([*hit, False]):
                if on and start is None:
                    start = i
                elif not on and start is not None:
                    if i - start <= RASTER_LINE_MAX_MM * per_mm:
                        found.append(round(((start + i) / 2 + first_px) / per_mm, 2))
                    start = None
            # rows packed under 1 mm apart are a zipper track's teeth (FGPO6164), not dieline lines
            return [v for v in found if all(o == v or abs(o - v) > 1.0 for o in found)]

        out = (bands(cols, first[0]), bands(rows, first[1]))
    while len(_RASTER_CACHE) >= 32:
        _RASTER_CACHE.pop(next(iter(_RASTER_CACHE)))
    _RASTER_CACHE[key] = out
    return out


def _to_pdf(rect, inv) -> Box:
    r = pymupdf.Rect(rect) * inv
    return Box(r.x0, r.y0, r.x1, r.y1)


def _on(d, layers: list[str] | None) -> bool:
    """`layers=None` accepts every drawing (files without layers, or an already filtered copy)."""
    return layers is None or d.get("layer") in layers


def corner_cut(pdf: Path, layers: list[str] | None, length_mm: tuple[float, float] = (30.0, 120.0)) -> str | None:
    """The top corner a long ~45 degree line cuts off: "left" or "right" (FGPO6784: the spout corner,
    a 50 x 50 mm diagonal on the dieline). A line rising to the right ("/") cuts a top-left corner;
    it keeps that slope on a panel printed upside down. None without such a line, or when they disagree.
    ponytail: page-wide, so a sheet with front and back (opposite slopes) gives None; scan per panel then."""
    drawings, _ = _drawings(pdf)
    lo, hi = (v / PT_TO_MM for v in length_mm)
    found = set()
    for d in drawings:
        if not _on(d, layers):
            continue
        for item in d["items"]:
            if item[0] != "l":
                continue
            dx, dy = item[2].x - item[1].x, item[2].y - item[1].y  # page space: y runs down
            if lo <= (dx * dx + dy * dy) ** 0.5 <= hi and dx and 0.8 <= abs(dy / dx) <= 1.25:
                found.add("left" if dx * dy < 0 else "right")
    return found.pop() if len(found) == 1 else None


def ink_dots(pdf: Path, layers: list[str] | None, diameter_mm: tuple[float, float]) -> list[Dot]:
    drawings, inv = _drawings(pdf)
    dots = []
    for d in drawings:
        r = d["rect"]
        if not _on(d, layers) or not d.get("fill"):
            continue
        dia = r.width * PT_TO_MM
        is_round = any(item[0] == "c" for item in d["items"])
        if is_round and abs(r.width - r.height) < 0.02 * r.width and diameter_mm[0] <= dia <= diameter_mm[1]:
            dots.append(Dot(_to_pdf(r, inv), tuple(d["fill"])))
    return sorted(dots, key=lambda dot: (round(dot.box.y1), dot.box.x0))


def dieline(pdf: Path, layers: list[str] | None, trim: Box, min_span: float = 0.5, tol_mm: float = 0.3, raster: bool = True) -> Dieline:
    """Vertical/horizontal lines inside the TrimBox that span at least `min_span` of it.

    Lines are the merged straight segments (pieces joined, outline pairs at their centre), so a
    flattened stroke broken where another line crosses still counts as one full-length line, and a
    cut edge drawn in pieces counts as long as its pieces together (FGPO7165's right edge is drawn
    only where no shared cut line runs beside it: 51 % of its up). Below half the panel a line is a
    guide or a mark (FGPO7165 has one across 45 % of the body), not a keyline."""
    all_drawings, inv = _drawings(pdf)
    tol = tol_mm / PT_TO_MM
    # (one job reads the same drawing's lines a dozen times, for different boxes and spans)
    skey = (id(all_drawings), len(all_drawings), tuple(layers) if layers is not None else None, _DASHED.get())
    if skey not in _SEGMENT_CACHE:
        while len(_SEGMENT_CACHE) >= 8:
            _SEGMENT_CACHE.pop(next(iter(_SEGMENT_CACHE)))
        drawings = [d for d in all_drawings if _on(d, layers)]
        _SEGMENT_CACHE[skey] = (drawings, *_segments(drawings, inv, 0))
    drawings, hs, vs = _SEGMENT_CACHE[skey]
    # A cut edge drawn as pieces that meet at every band line (FGPO7165: one piece per band) is one
    # line as long as its pieces together, whatever their own lengths; only what lies inside the
    # box counts (an up of an imposition shares its heights with the ups beside it).
    xs = {round((x - trim.x0) * PT_TO_MM, 4) for x, covered in _covered(vs, trim.y0, trim.y1)
          if covered >= min_span * (trim.y1 - trim.y0) and trim.x0 - tol <= x <= trim.x1 + tol}
    ys = {round((trim.y1 - y) * PT_TO_MM, 4) for y, covered in _covered(hs, trim.x0, trim.x1)
          if covered >= min_span * (trim.x1 - trim.x0) and trim.y0 - tol <= y <= trim.y1 + tol}
    if layers is None and raster:
        # lines flattened into raster tiles (FGPO6292): measured on a render, added where no vector line is
        rx, ry = _raster_lines(pdf, trim, min_span)
        xs |= {v for v in rx if all(abs(v - o) > 0.5 for o in xs)}
        ys |= {v for v in ry if all(abs(v - o) > 0.5 for o in ys)}

    small: dict[int, list[Box]] = {}  # 1 mm y-bucket -> small shapes inside the trim
    for d in drawings:
        box = _to_pdf(d["rect"], inv)
        if box.width_mm < 10 and box.height_mm < 5 and trim.x0 <= box.x0 and box.x1 <= trim.x1 and trim.y0 <= box.y0 and box.y1 <= trim.y1:
            y_mm = (trim.y1 - (box.y0 + box.y1) / 2) * PT_TO_MM
            small.setdefault(round(y_mm), []).append(box)

    # A zipper track is drawn as a row of many small shapes across most of the panel width, or as a
    # dashed line: evenly spaced dashes across most of the width (FGPO3970: six 7.5 mm dashes).
    zippers: list[float] = []
    for bucket in sorted(small):
        row = small.get(bucket - 1, []) + small[bucket] + small.get(bucket + 1, [])
        span = (max(b.x1 for b in row) - min(b.x0 for b in row)) / (trim.x1 - trim.x0)
        if len(row) >= 30 and span >= 0.6:
            y = sorted((trim.y1 - (b.y0 + b.y1) / 2) * PT_TO_MM for b in row)[len(row) // 2]
            if not zippers or y - zippers[-1] > 3:
                zippers.append(round(y, 1))
    for y in _dashed_rows(hs, trim.x0, trim.x1, trim.y0, trim.y1):
        y_mm = round((trim.y1 - y) * PT_TO_MM, 1)
        if all(abs(y_mm - z) > 3 for z in zippers):
            zippers.append(y_mm)
    return Dieline(_dedupe(xs), _dedupe(ys), sorted(zippers))


def _dashed_rows(hs, x0: float, x1: float, y0: float, y1: float, min_dashes: int = 4, pos_tol_mm: float = 0.35,
                 max_dash_mm: float = 25.0, min_spread: float = 0.6) -> list[float]:
    """y of dashed lines inside [x0, x1] x [y0, y1]: at least `min_dashes` short pieces on one line,
    no gap wider than a quarter of the width (dashes may come in pairs: FGPO3970 alternates 5.3 and
    22 mm gaps), the dashes covering at least 15 % of the width, from first to last dash across at
    least `min_spread` of it. Solid lines and dimension ticks outside the box never qualify."""
    pos_tol, max_dash = pos_tol_mm / PT_TO_MM, max_dash_mm / PT_TO_MM
    pieces = sorted((y, a, b) for y, a, b in hs if b - a <= max_dash and a >= x0 - pos_tol and b <= x1 + pos_tol and y0 < y < y1)
    rows: list[list[tuple[float, float, float]]] = []
    for p in pieces:
        if rows and p[0] - rows[-1][-1][0] <= pos_tol:
            rows[-1].append(p)
        else:
            rows.append([p])
    out = []
    for row in rows:
        row.sort(key=lambda p: p[1])
        if len(row) < min_dashes:
            continue
        gaps = [b[1] - a[2] for a, b in zip(row, row[1:])]
        width = x1 - x0
        if min(gaps) <= 0 or max(gaps) > 0.25 * width or sum(b - a for _, a, b in row) < 0.15 * width:
            continue
        if (row[-1][2] - row[0][1]) >= min_spread * width:
            out.append(sum(p[0] for p in row) / len(row))
    return out


def _covered(lines: list[tuple[float, float, float]], lo: float, hi: float, pos_tol_mm: float = 0.35, join_mm: float = 1.5,
             min_piece_mm: float = 5.0) -> list[tuple[float, float]]:
    """(position, covered length within [lo, hi]) per line, where a line is every piece within a
    stroke width of one position: pieces of at least `min_piece_mm` that touch or nearly touch
    (`join_mm`) cover their union. A whole line stays as it is; a row of short dashes (a zipper
    track) covers nothing; what lies outside [lo, hi] counts for nothing."""
    pos_tol, join, min_piece = pos_tol_mm / PT_TO_MM, join_mm / PT_TO_MM, min_piece_mm / PT_TO_MM
    out: list[tuple[float, float]] = []
    group: list[tuple[float, float, float]] = []

    def flush() -> None:
        if not group:
            return
        pieces = sorted((max(s, lo), min(e, hi)) for _, s, e in group if min(e, hi) - max(s, lo) >= min_piece)
        covered = 0.0
        if pieces:
            cur_s, cur_e = pieces[0]
            for s, e in pieces[1:]:
                if s <= cur_e + join:
                    cur_e = max(cur_e, e)
                else:
                    covered += cur_e - cur_s
                    cur_s, cur_e = s, e
            covered += cur_e - cur_s
        longest = max(group, key=lambda l: min(l[2], hi) - max(l[1], lo))
        out.append((longest[0], max(covered, min(longest[2], hi) - max(longest[1], lo))))

    for line in sorted(lines):
        if group and line[0] - group[-1][0] > pos_tol:
            flush()
            group = []
        group.append(line)
    flush()
    return out


_TRACE = None  # debugging hook: called with the merged lines before outline clustering


def _segments(drawings, inv, min_len_pt: float, join_gap_mm: float = 1.5, min_piece_mm: float = 5.0
              ) -> tuple[list[tuple[float, float, float]], list[tuple[float, float, float]]]:
    """Straight horizontal (y, x0, x1) and vertical (x, y0, y1) lines, collinear pieces merged.

    A stroke flattened to a filled outline (a thin closed rectangle sub-path, <= 1 mm across) is one
    line at its centre, not its two edges. Pieces up to `join_gap_mm` apart join (a flattened stroke
    breaks where another line crosses), but a line must contain a piece of at least `min_piece_mm`,
    so rows of small shapes (zipper teeth) never fuse into a line."""
    # pos, start, end, from a filled path, half thickness (a thin filled rectangle is a band, an edge is 0)
    hs: list[tuple[float, float, float, bool, float]] = []
    vs: list[tuple[float, float, float, bool, float]] = []
    thin = 1.0 / PT_TO_MM

    def add(a, b, filled: bool) -> None:
        if abs(a.y - b.y) < 0.05 and abs(a.x - b.x) > 0.5:
            hs.append(((a.y + b.y) / 2, min(a.x, b.x), max(a.x, b.x), filled, 0.0))
        elif abs(a.x - b.x) < 0.05 and abs(a.y - b.y) > 0.5:
            vs.append(((a.x + b.x) / 2, min(a.y, b.y), max(a.y, b.y), filled, 0.0))

    def rect(x0, y0, x1, y1, filled: bool) -> None:
        w, h = x1 - x0, y1 - y0
        if filled and min(w, h) <= thin and max(w, h) > 2 * thin:
            if h <= thin:
                hs.append(((y0 + y1) / 2, x0, x1, True, h / 2))  # a stroke drawn as a thin filled rectangle
            else:
                vs.append(((x0 + x1) / 2, y0, y1, True, w / 2))
            return
        p = pymupdf.Point
        add(p(x0, y0), p(x1, y0), filled)
        add(p(x0, y1), p(x1, y1), filled)
        add(p(x0, y0), p(x0, y1), filled)
        add(p(x1, y0), p(x1, y1), filled)

    def flush(chain, filled: bool) -> None:
        """A run of connected line items: a closed axis-aligned rectangle, or plain segments."""
        pts = [chain[0][0], *(b for _, b in chain)]
        closed = len(pts) == 5 and abs(pts[0].x - pts[4].x) < 0.01 and abs(pts[0].y - pts[4].y) < 0.01
        xs, ys = {round(q.x, 2) for q in pts}, {round(q.y, 2) for q in pts}
        if closed and len(xs) == 2 and len(ys) == 2:
            rect(min(xs), min(ys), max(xs), max(ys), filled)
            return
        for a, b in chain:
            add(a, b, filled)

    for d in drawings:
        filled = d["type"] == "f"
        chain: list = []
        for item in d["items"]:
            if item[0] == "l":
                a, b = pymupdf.Point(item[1]) * inv, pymupdf.Point(item[2]) * inv
                if chain and (abs(chain[-1][1].x - a.x) > 0.01 or abs(chain[-1][1].y - a.y) > 0.01):
                    flush(chain, filled)
                    chain = []
                chain.append((a, b))
                continue
            if chain:
                flush(chain, filled)
                chain = []
            if item[0] == "re":
                rr = _to_pdf(item[1], inv)
                rect(rr.x0, rr.y0, rr.x1, rr.y1, filled)
        if chain:
            flush(chain, filled)

    gap, min_piece, pair, band_max = join_gap_mm / PT_TO_MM, min_piece_mm / PT_TO_MM, 0.45 / PT_TO_MM, 1.0 / PT_TO_MM

    dashed = _DASHED.get()
    dash_min, dash_gap = DASH_MIN_MM / PT_TO_MM, DASH_GAP_MAX_MM / PT_TO_MM

    def merge(pieces):
        # Pieces of one line differ in position by rounding noise: bucket the position before sorting.
        out: list[list] = []  # pos, start, end, longest piece, filled, half thickness, last piece, dash joins
        for pos, s, e, filled, hw in sorted(pieces, key=lambda p: (round(p[0] * 5), p[1])):
            same = out and abs(pos - out[-1][0]) < 0.2 and out[-1][4] == filled
            if same and s <= out[-1][2] + gap:
                o = out[-1]
                o[1], o[2], o[3], o[5], o[6] = min(o[1], s), max(o[2], e), max(o[3], e - s), max(o[5], hw), e - s
            elif same and dashed and s <= out[-1][2] + dash_gap and max(out[-1][6], e - s) >= dash_min:
                o = out[-1]  # the next dash of a dashed line (a dash cut by a crossing line may be short)
                o[1], o[2], o[3], o[5], o[6], o[7] = min(o[1], s), max(o[2], e), max(o[3], e - s), max(o[5], hw), e - s, o[7] + 1
            else:
                out.append([pos, s, e, e - s, filled, hw, e - s, 0])
        lines = [l[:6] for l in out if l[2] - l[1] >= min_len_pt and (l[3] >= min_piece or l[7] >= DASH_MIN_COUNT)]
        # A flattened stroke arrives as edges, thin rectangles and hairlines within one stroke width
        # of each other, all with the same extent: they are one line at the middle of the band they
        # cover. Stroked lines are never clustered: two real lines may be that close.
        lines.sort()
        if _TRACE is not None:
            _TRACE(lines)
        merged: list[tuple[float, float, float]] = []
        open_: list[list[float]] = []  # band lo, band hi, start, end

        def centre(c) -> tuple[float, float, float]:
            return ((c[0] + c[1]) / 2, c[2], c[3])

        for pos, s, e, _, filled, hw in lines:
            if not filled:
                merged.append((pos, s, e))
                continue
            keep = []
            for c in open_:
                (merged if (pos - hw) - c[1] > pair else keep).append(centre(c) if (pos - hw) - c[1] > pair else c)
            open_ = keep
            # Fragments of an edge (cut where other lines cross) each overlap the long edge beside them:
            # every open band the line overlaps is one band with it, as long as the band stays no
            # wider than a stroke (a bleed line 1.2 mm from the cut edge is another line, FGPO7165).
            hits = [c for c in open_ if min(e, c[3]) - max(s, c[2]) >= 0.8 * min(e - s, c[3] - c[2])
                    and max(c[1], pos + hw) - min(c[0], pos - hw) <= band_max]
            if hits:
                c = hits[0]
                for other in hits[1:]:
                    c[0], c[1], c[2], c[3] = min(c[0], other[0]), max(c[1], other[1]), min(c[2], other[2]), max(c[3], other[3])
                    open_.remove(other)
                c[0], c[1], c[2], c[3] = min(c[0], pos - hw), max(c[1], pos + hw), min(c[2], s), max(c[3], e)
            else:
                open_.append([pos - hw, pos + hw, s, e])
        merged += [centre(c) for c in open_]
        return sorted(merged)

    return merge(hs), merge(vs)


@dataclass(frozen=True)
class Grid:
    box: Box  # outer rectangle, PDF user space
    lines: int  # horizontal + vertical lines forming it (more = a fuller dieline)


def dieline_grids(pdf: Path, min_len_mm: float = 20, tol_mm: float = 0.6) -> list[Grid]:
    """Closed grids of lines in a file whose drawings are all technical-ink (PDF user space).

    A dieline is a grid: several horizontal lines that all run between the same two x (the outer
    vertical lines) and several vertical lines that all run between the same two y. Dimension and
    extension lines around it never form such a closed grid. Grids that lie inside a bigger grid are
    its cells, not dielines. Sorted in reading order (top-left first). `tol_mm` covers a flattened
    stroke drawn as two outline edges one stroke width (0.35 mm) apart.
    """
    drawings, inv = _drawings(pdf)
    tol = tol_mm / PT_TO_MM
    hs, vs = _segments(drawings, inv, min_len_mm / PT_TO_MM)

    def groups(lines):
        out: list[list[tuple[float, float, float]]] = []
        for line in sorted(lines, key=lambda l: (l[1], l[2])):
            for g in out:
                if abs(g[0][1] - line[1]) <= tol and abs(g[0][2] - line[2]) <= tol:
                    g.append(line)
                    break
            else:
                out.append([line])
        return [g for g in out if len(g) >= 2]

    def near(a: float, b: float) -> bool:
        return abs(a - b) <= tol

    found: dict[tuple[int, int, int, int], Grid] = {}

    def add(x0: float, y0: float, x1: float, y1: float, n: int) -> None:
        key = (round(x0 / tol), round(y0 / tol), round(x1 / tol), round(y1 / tol))
        if key not in found or found[key].lines < n:
            found[key] = Grid(Box(x0, y0, x1, y1), n)

    # Driven by the horizontal lines of one extent: the verticals must lie within that extent (two
    # repeats side by side share the same vertical extents, so verticals are never grouped alone).
    for hg in groups(hs):
        x0, x1 = hg[0][1], hg[0][2]
        y0, y1 = min(h[0] for h in hg), max(h[0] for h in hg)
        vin = [v for v in vs if x0 - tol <= v[0] <= x1 + tol and near(v[1], y0) and near(v[2], y1)]
        if any(near(v[0], x0) for v in vin) and any(near(v[0], x1) for v in vin):
            add(x0, y0, x1, y1, len(hg) + len(vin))
    for vg in groups(vs):  # and the same the other way round
        y0, y1 = vg[0][1], vg[0][2]
        x0, x1 = min(v[0] for v in vg), max(v[0] for v in vg)
        hin = [h for h in hs if y0 - tol <= h[0] <= y1 + tol and near(h[1], x0) and near(h[2], x1)]
        if any(near(h[0], y0) for h in hin) and any(near(h[0], y1) for h in hin):
            add(x0, y0, x1, y1, len(vg) + len(hin))
    if not found:
        # Relaxed pass, only when no closed grid exists. Two copies of the dieline side by side (the
        # artwork and its technical preview, FGPO7492) share one long line at one end, so no pair of
        # lines has exactly one copy's extent. Take every pair of parallel lines with the same span
        # and accept the rectangle when a line covers each of its other two sides (the covering line
        # may run on past the corner). Fullness = lines inside, so a copy beats its cells.
        min_apart = min_len_mm / PT_TO_MM

        def covered(lines, pos: float, lo: float, hi: float) -> bool:
            return any(near(l[0], pos) and l[1] <= lo + tol and l[2] >= hi - tol for l in lines)

        for i, a in enumerate(vs):
            for b in vs[i + 1:]:
                lo, hi = (a, b) if a[0] <= b[0] else (b, a)
                if hi[0] - lo[0] < min_apart or not (near(a[1], b[1]) and near(a[2], b[2])):
                    continue
                y0, y1 = min(a[1], b[1]), max(a[2], b[2])
                if covered(hs, y0, lo[0], hi[0]) and covered(hs, y1, lo[0], hi[0]):
                    add(lo[0], y0, hi[0], y1, _inside_count(hs, vs, lo[0], y0, hi[0], y1, tol))
        for i, a in enumerate(hs):
            for b in hs[i + 1:]:
                lo, hi = (a, b) if a[0] <= b[0] else (b, a)
                if hi[0] - lo[0] < min_apart or not (near(a[1], b[1]) and near(a[2], b[2])):
                    continue
                x0, x1 = min(a[1], b[1]), max(a[2], b[2])
                if covered(vs, x0, lo[0], hi[0]) and covered(vs, x1, lo[0], hi[0]):
                    add(x0, lo[0], x1, hi[0], _inside_count(hs, vs, x0, lo[0], x1, hi[0], tol))
    grids = list(found.values())
    outer = [g for g in grids if not any(o is not g and _inside(g.box, o.box, tol) and not _inside(o.box, g.box, tol) for o in grids)]
    return sorted(outer, key=lambda g: (-g.box.y1, g.box.x0))


def _inside(a: Box, b: Box, tol: float) -> bool:
    return a.x0 >= b.x0 - tol and a.y0 >= b.y0 - tol and a.x1 <= b.x1 + tol and a.y1 <= b.y1 + tol


def _inside_count(hs, vs, x0: float, y0: float, x1: float, y1: float, tol: float) -> int:
    """How many lines lie within a rectangle (its own edges included): the grid's fullness."""
    n = sum(1 for h in hs if y0 - tol <= h[0] <= y1 + tol and h[1] >= x0 - tol and h[2] <= x1 + tol)
    return n + sum(1 for v in vs if x0 - tol <= v[0] <= x1 + tol and v[1] >= y0 - tol and v[2] <= y1 + tol)


def dieline_grid(pdf: Path, min_len_mm: float = 20, tol_mm: float = 0.6) -> Box | None:
    """The dieline with the most lines (first in reading order among equals), or None."""
    grids = dieline_grids(pdf, min_len_mm, tol_mm)
    if not grids:
        return None
    return max(grids, key=lambda g: g.lines).box


def grid_repeats(grids: list[Grid], chosen: Box, tol_mm: float = 1.0) -> int:
    """How many grids of the chosen one's size the sheet carries (print repeats / ups)."""
    w, h = chosen.x1 - chosen.x0, chosen.y1 - chosen.y0
    tol = tol_mm / PT_TO_MM
    return sum(1 for g in grids if abs((g.box.x1 - g.box.x0) - w) <= tol and abs((g.box.y1 - g.box.y0) - h) <= tol)


def painted_extent(pdf: Path, seed: Box, gap_mm: float = 15.0) -> Box:
    """Extent (PDF user space) of the drawings connected to `seed`: every drawing within `gap_mm` of
    what is already included joins, repeatedly. The dimension drawing around a dieline is one such
    cluster; the same ink used elsewhere on the sheet (e.g. in the spec table) stays out."""
    drawings, inv = _drawings(pdf)
    boxes = [_to_pdf(d["rect"], inv) for d in drawings if d["rect"].width > 0 or d["rect"].height > 0]  # lines have no area
    gap = gap_mm / PT_TO_MM
    ext = seed
    grown = True
    while grown:
        grown = False
        rest = []
        for b in boxes:
            dx = max(0.0, b.x0 - ext.x1, ext.x0 - b.x1)
            dy = max(0.0, b.y0 - ext.y1, ext.y0 - b.y1)
            if max(dx, dy) <= gap:
                ext = Box(min(ext.x0, b.x0), min(ext.y0, b.y0), max(ext.x1, b.x1), max(ext.y1, b.y1))
                grown = True
            else:
                rest.append(b)
        boxes = rest
    return ext


@dataclass(frozen=True)
class Network:
    box: Box  # outer rectangle of the crossing points, PDF user space
    crossings: int
    points: tuple[tuple[float, float], ...] = ()  # the crossing points themselves


def copy_offset(own: "Network", other: "Network", tol_mm: float = 1.0, min_share: float = 0.8) -> tuple[float, float] | None:
    """The translation that lays `own` onto `other` (another copy of the same drawing), from their
    crossing points: the shift that lands the most of own's points on other's points. The boxes'
    corners give the candidate shifts (copies' boxes may differ by a frame line or a dimension
    drawing on one side, so every corner pairing is tried). None when no shift lands `min_share`."""
    if not own.points or not other.points:
        return None
    tol = tol_mm / PT_TO_MM
    cells = {(round(x / tol), round(y / tol)) for x, y in other.points}

    def hit(x: float, y: float) -> bool:
        cx, cy = round(x / tol), round(y / tol)
        return any((cx + i, cy + j) in cells for i in (-1, 0, 1) for j in (-1, 0, 1))

    a, b = own.box, other.box
    best, best_share = None, 0.0
    for dx in {b.x0 - a.x0, b.x1 - a.x1}:
        for dy in {b.y0 - a.y0, b.y1 - a.y1}:
            share = sum(1 for x, y in own.points if hit(x + dx, y + dy)) / len(own.points)
            if share > best_share:
                best, best_share = (dx, dy), share
    return best if best_share >= min_share else None


def line_networks(pdf: Path, min_len_mm: float = 5, tol_mm: float = 0.6, split_gap_mm: float = 30) -> list[Network]:
    """Connected networks of crossing lines in a technical-ink-only file, each as the outer rectangle
    of its crossing points (PDF user space), in reading order.

    An imposition (FGPO7165: two copies of four ups of a front + back web, the column edges broken
    into pieces at every band line) or a web whose outer lines overshoot the corners (FGPO7442) has
    no closed grid with the web's extent, only cells; but every cut and seal line crosses others, and
    overshoots add no crossing. Lines whose crossings all lie at their own ends (dimension lines,
    their extension lines, leaders) are dropped first, repeatedly. Copies side by side or stacked
    share at most a sheet-wide line, never a crossing, so a network is split wherever a strip wider
    than `split_gap_mm` holds no crossing point.
    """
    drawings, inv = _drawings(pdf)
    tol = tol_mm / PT_TO_MM
    hs, vs = _segments(drawings, inv, min_len_mm / PT_TO_MM)
    nh = len(hs)
    lines = [*hs, *vs]  # (position, start, end); horizontals first
    # crossings between horizontal i and vertical nh + j, at (the vertical's x, the horizontal's y)
    pairs = [(i, nh + j) for i, (y, hx0, hx1) in enumerate(hs) for j, (x, vy0, vy1) in enumerate(vs)
             if hx0 - tol <= x <= hx1 + tol and vy0 - tol <= y <= vy1 + tol]
    # A line crossed somewhere along its length belongs to the network. A line crossed only at its
    # ends may be a dimension or extension line (crossed by nothing else) or a piece of a cut edge
    # broken at the band lines (FGPO7165): the crossing counts when the other line is a network line,
    # which keeps the edge piece's corner and drops the dimension line met by its extension lines.
    interior = [False] * len(lines)
    for i, j in pairs:
        for k, p in ((i, lines[j][0]), (j, lines[i][0])):
            if abs(p - lines[k][1]) > tol and abs(p - lines[k][2]) > tol:
                interior[k] = True
    # A long line crossed only at its ends is a dimension line (or a long extension line): nothing
    # it crosses counts, or the box would grow to the dimension offset. A short one is a piece of a
    # cut edge broken at the band lines, whose corners are wanted.
    short = 30 / PT_TO_MM
    counts = [interior[k] or lines[k][2] - lines[k][1] <= short for k in range(len(lines))]
    live = [(i, j) for i, j in pairs if counts[i] and counts[j]]
    if not live:
        return []
    pts = [(lines[j][0], lines[i][0]) for i, j in live]
    used = {k for pair in live for k in pair}
    h_lines = [lines[k] for k in used if k < nh]
    v_lines = [lines[k] for k in used if k >= nh]
    out: list[Network] = []
    # The period is a property of the whole drawing (ups need not touch each other, and a dimension
    # line may join two of them and skip the one between), so the split works on every crossing
    # point at once, on both axes, until no copy splits further. (Two unrelated drawings on one
    # sheet, e.g. a pouch web and a separate gusset drawing, are therefore not told apart here;
    # sheet.analyse settles such files by their TrimBox when the dieline confirms it: FGPO3970.)
    for part in _split_copies(pts, h_lines, v_lines, tol):
        xs, ys = [p[0] for p in part], [p[1] for p in part]
        if _extent(part) >= 5 / PT_TO_MM:  # (an extension line meeting its dimension line is one crossing, not a network)
            out.append(Network(Box(min(xs), min(ys), max(xs), max(ys)), len(part), tuple(part)))
    return _reading_order(out)


def _split_copies(pts, h_lines, v_lines, tol: float, depth: int = 0) -> list[list[tuple[float, float]]]:
    if depth < 6:
        for axis, along in ((0, h_lines), (1, v_lines)):
            groups = _copies(pts, axis, tol, along)
            if len(groups) > 1:
                return [part for g in groups for part in _split_copies(g, h_lines, v_lines, tol, depth + 1)]
    return [pts]


def _reading_order(nets: list[Network]) -> list[Network]:
    """Top row first, left to right within a row; a row is a set of boxes overlapping vertically by
    at least half (a dimension drawing kept with one copy shifts its top, not its row)."""
    rows: list[list] = []  # [y0, y1, nets]
    for n in sorted(nets, key=lambda n: -n.box.y1):
        for row in rows:
            overlap = min(row[1], n.box.y1) - max(row[0], n.box.y0)
            if overlap >= 0.5 * min(n.box.y1 - n.box.y0, row[1] - row[0]):
                row[0], row[1] = min(row[0], n.box.y0), max(row[1], n.box.y1)
                row[2].append(n)
                break
        else:
            rows.append([n.box.y0, n.box.y1, [n]])
    rows.sort(key=lambda r: -r[1])
    return [n for r in rows for n in sorted(r[2], key=lambda n: n.box.x0)]


def typical_network(nets: list[Network]) -> Network | None:
    """The first network (reading order) of the commonest size: the ups of an imposition agree in
    size while the pieces around them (frames, dimension columns) do not; ties go to more crossings."""
    if not nets:
        return None
    alike = {id(n): [m for m in nets if same_size(m.box, n.box, frac=COPY_FRAC)] for n in nets}
    lead = max(nets, key=lambda n: (len(alike[id(n)]), n.crossings))
    return alike[id(lead)][0]


MIN_PERIOD_MM = 30.0


def _copies(pts: list[tuple[float, float]], axis: int, tol: float, along) -> list[list[tuple[float, float]]]:
    """Crossing points split into the copies of a drawing repeated along `axis` that lie apart.

    The body of a pouch and the strip between two copies are both free of crossings, so nothing
    local tells them apart; what copies have is translation symmetry: shifted by one period the
    crossing points land on crossing points again. With the period known, copies are walked from
    the first point (see `_walk_copies`). Only copies separated by an empty strip of at least
    `MIN_PERIOD_MM` count, empty meaning that no line runs through it apart from sheet-wide ones
    (`along`: the lines that could, the horizontals for x): the ups of an imposition touch each
    other and are split by the sheet layout instead (`sheet_layout.detect`, ups across); a front and
    its back, whose lines also repeat when the seals are alike, meet at a fold band a few
    millimetres wide; and the body of a panel, empty of crossings, has the panel's own lines
    running through it.
    """
    lo, hi = min(p[axis] for p in pts), max(p[axis] for p in pts)
    min_period = MIN_PERIOD_MM / PT_TO_MM
    if hi - lo < 2 * min_period:
        return [pts]
    near = 3 / PT_TO_MM
    xs = sorted({round(p[axis], 2) for p in pts})
    local = [l for l in along if l[2] - l[1] < 0.9 * (hi - lo)]  # (a sheet-wide line runs through every gap)
    # Smallest period first; a period whose walk gives no copies lying apart hands over to the next
    # (an imposition's ups repeat every up, its copies every group of ups).
    for period in _periods(pts, axis, tol, lo, hi, min_period):
        groups = _walk_copies(pts, xs, axis, period, lo, hi, tol, near)
        if len(groups) < 2:
            continue
        extents = [max(p[axis] for p in g) - min(p[axis] for p in g) for g in groups]
        # copies lie apart and are alike in extent (a sparse dimension column between two copies is
        # neither a copy nor a gap inside one)
        if all(_apart(a, b, axis, tol, local, min_period) for a, b in zip(groups, groups[1:])) and min(extents) >= 0.75 * max(extents):
            return groups
    return [pts]


def _apart(a: list[tuple[float, float]], b: list[tuple[float, float]], axis: int, tol: float, local, min_period: float) -> bool:
    """Whether an empty strip of at least `min_period` separates two consecutive groups: no crossing
    in it and fewer than three `local` lines running through it (a panel's body has its edges and
    seal lines running through; a stray dimension line reaching into the gap between copies is one)."""
    start = min(p[axis] for p in b)
    before = [p[axis] for p in a if p[axis] < start - tol]
    if not before:
        return False
    end = max(before)
    if start - end < min_period:
        return False
    return sum(1 for l in local if l[1] < end + tol and l[2] > start - tol) < 3


def _walk_copies(pts, xs: list[float], axis: int, period: float, lo: float, hi: float, tol: float, near: float) -> list[list[tuple[float, float]]]:
    """Copies of `period` walked from the first crossing position: the next copy starts at the first
    position a period on (or later, after a gap between groups of copies) that is itself followed by
    another start a period later, or is the last before a gap or the sheet's end. Whatever lies
    between copies (dimension drawings, a frame line) stays with the copy before it, and a short
    tail is merged into it."""

    def periodic(c: float) -> bool:
        return c + period > hi + near or any(abs(x - (c + period)) <= near for x in xs)

    def next_periodic(c: float) -> float | None:
        return next((x for x in xs if x > c + tol and periodic(x)), None)

    bounds = [lo]
    while True:
        expected = bounds[-1] + period
        if expected > hi - tol:
            break
        nxt = None
        for c in (x for x in xs if x >= expected - tol):
            follower = next_periodic(c)
            if periodic(c) or follower is None or follower >= c + period - near:
                nxt = c
                break
        if nxt is None or nxt > hi - tol:
            break
        bounds.append(nxt)
    if len(bounds) < 2:
        return [pts]
    groups = [[p for p in pts if a - tol <= p[axis] < b - tol] for a, b in zip(bounds, [*bounds[1:], hi + 2 * tol])]
    groups = [g for g in groups if g]
    extent = lambda g: max(p[axis] for p in g) - min(p[axis] for p in g)  # noqa: E731
    merged: list[list[tuple[float, float]]] = []
    for g in groups:
        if merged and extent(g) < 0.3 * period:
            merged[-1] = merged[-1] + [p for p in g if p not in merged[-1]]
        else:
            merged.append(g)
    return merged


def _matching(pts, tol: float, image) -> float:
    """The fraction of points whose `image` lands on a point (within a cell of `tol`)."""
    cells = {(round(p[0] / tol), round(p[1] / tol)) for p in pts}

    def has(x: float, y: float) -> bool:
        cx, cy = round(x / tol), round(y / tol)
        return any((cx + i, cy + j) in cells for i in (-1, 0, 1) for j in (-1, 0, 1))

    return sum(1 for p in pts if has(*image(p))) / len(pts)


def _periods(pts, axis: int, tol: float, lo: float, hi: float, min_period: float) -> list[float]:
    """The shifts along `axis` (>= min_period, smallest first) that map most of the crossing points
    that can land inside the extent onto crossing points."""
    other = 1 - axis
    rows: dict[int, set[float]] = {}
    for p in pts:
        rows.setdefault(round(p[other] / (2 * tol)), set()).add(round(p[axis], 1))
    counts: dict[int, int] = {}
    for row in rows.values():
        xs = sorted(row)
        for i, a in enumerate(xs):
            for b in xs[i + 1:]:
                if b - a >= min_period:
                    counts[round((b - a) / tol)] = counts.get(round((b - a) / tol), 0) + 1
    if not counts:
        return []
    cells = {(round(p[0] / tol), round(p[1] / tol)) for p in pts}

    def has(x: float, y: float) -> bool:
        cx, cy = round(x / tol), round(y / tol)
        return any((cx + i, cy + j) in cells for i in (-1, 0, 1) for j in (-1, 0, 1))

    found: list[float] = []
    for k in sorted(counts, key=lambda k: -counts[k])[:40]:
        d = k * tol
        # two copies at least: a period and then a copy of at least half a period (the last copy
        # of a row is narrower than the period when no gap follows it)
        if d > (hi - lo) / 1.5 + tol:
            continue
        cand = [p for p in pts if p[axis] + d <= hi + tol]
        if not cand:
            continue
        hits = sum(1 for p in cand if (has(p[0] + d, p[1]) if axis == 0 else has(p[0], p[1] + d)))
        # 0.6: with three ups per group the last up of each group has no image one period on
        if hits / len(cand) >= 0.6:
            found.append(d)
    return sorted(found)


def _extent(pts: list[tuple[float, float]]) -> float:
    if not pts:
        return 0.0
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(max(xs) - min(xs), max(ys) - min(ys))


def same_size(a: Box, b: Box, tol_mm: float = 3.0, frac: float = 0.05) -> bool:
    """Boxes of one size, within `tol_mm` or `frac` of the size on each axis (a dimension drawing
    kept with one copy stretches its box by the dimension offset, not more)."""
    tol_w = max(tol_mm, frac * max(a.width_mm, b.width_mm))
    tol_h = max(tol_mm, frac * max(a.height_mm, b.height_mm))
    return abs(a.width_mm - b.width_mm) <= tol_w and abs(a.height_mm - b.height_mm) <= tol_h


COPY_FRAC = 0.10  # copies of a drawing: one may carry a dimension column the other lacks


def horizontal_rules(pdf: Path, layers: list[str] | None, region: Box, min_span: float) -> list[float]:
    """y (PDF user space) of horizontal rules in `region` covering >= `min_span` of the table width.

    Table grids are drawn per cell (line pieces, rectangle edges, thin filled bars), so the pieces
    at the same y (within 1 pt) are merged and their covered x-length is compared to the table's
    overall width.
    """
    drawings, inv = _drawings(pdf)
    pieces: list[tuple[float, float, float]] = []  # (y, x0, x1)

    def add(y: float, xa: float, xb: float) -> None:
        x0, x1 = sorted((xa, xb))
        if x1 - x0 > 2 and x0 >= region.x0 - 1 and x1 <= region.x1 + 1 and region.y0 <= y <= region.y1:
            pieces.append((y, x0, x1))

    for d in drawings:
        if not _on(d, layers):
            continue
        for item in d["items"]:
            if item[0] == "l":
                a, b = pymupdf.Point(item[1]) * inv, pymupdf.Point(item[2]) * inv
                if abs(a.y - b.y) < 0.05:
                    add(a.y, a.x, b.x)
            elif item[0] == "re":
                r = _to_pdf(item[1], inv)
                if r.y1 - r.y0 < 2:
                    add((r.y0 + r.y1) / 2, r.x0, r.x1)
                else:
                    add(r.y0, r.x0, r.x1)
                    add(r.y1, r.x0, r.x1)
    if not pieces:
        return []
    table_width = max(x1 for _, _, x1 in pieces) - min(x0 for _, x0, _ in pieces)
    groups: list[list[tuple[float, float, float]]] = []
    for p in sorted(pieces):
        if groups and p[0] - groups[-1][-1][0] <= 1.0:
            groups[-1].append(p)
        else:
            groups.append([p])
    rules = []
    for g in groups:
        covered, end = 0.0, float("-inf")
        for _, x0, x1 in sorted(g, key=lambda p: p[1]):
            if x1 > end:
                covered += x1 - max(x0, end)
                end = x1
        if covered >= min_span * table_width:
            rules.append(sum(p[0] for p in g) / len(g))
    return rules


def _dedupe(values: set[float], eps: float = 0.1) -> list[float]:
    """Positions closer than `eps` mm are one line (rounding noise between pieces): their mean is kept."""
    runs: list[list[float]] = []
    for v in sorted(values):
        if runs and v - runs[-1][-1] <= eps:
            runs[-1].append(v)
        else:
            runs.append([v])
    return [round(sum(r) / len(r), 4) + 0.0 for r in runs]  # + 0.0 turns -0.0 into 0.0
