"""Shrink sleeves: what a sleeve approval PDF says about the sleeve, and where its artwork is.

A sleeve sheet (FGSL...) carries the flat sleeve as printed, the dimension lines, a FOLD / FOLDING
AREA band and a small block of text instead of the pouch spec table:

    Size: 115.358 X 300 mm (Teeth* 109 / 3 UPS)    sleeve height (cut length) x printed width
    CLOSE WIDTH : 148.5 mm  /  LAY-FLAT- 86.5 mm   the flat tube: half the container's circumference

The printed width is the circumference plus the seam overlap (300 = 2 x 148.5 + 3). An item-master
XML, when uploaded, wins over these numbers (it is applied after them).
"""

import re
from pathlib import Path

SIZE = re.compile(r"(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*mm", re.I)
LAYFLAT = re.compile(r"(?:lay[\s-]*flat|close[d]?\s*width)\s*[-:=]*\s*(\d+(?:\.\d+)?)\s*mm", re.I)
SLEEVE_WORDS = re.compile(r"\bsleeve\b|lay[\s-]*flat|fold(?:ing)?\s*(?:area|mark)", re.I)
SEAM_MM = 3.0  # overlap assumed when the sheet gives no lay-flat width


def page_text(pdf: Path) -> str:
    import pymupdf

    with pymupdf.open(pdf) as doc:
        return doc[0].get_text() if len(doc) else ""


def is_sleeve(filename: str, text: str) -> bool:
    """A sleeve sheet: an FGSL item code, or the sleeve words a pouch sheet never carries."""
    return bool(re.match(r"\s*FGSL", filename, re.I)) or bool(SLEEVE_WORDS.search(text))


def read(text: str) -> dict[str, str]:
    """Spec fields (as the XML parser names them) from the sheet's text: height, printed width, lay-flat."""
    out: dict[str, str] = {"pouch_or_roll_form": "Shrink Sleeve", "sealing_type": "Shrink Sleeve"}
    size = SIZE.search(text)
    if size:
        height, width = float(size.group(1)), float(size.group(2))
        out["pouch_height_mm"] = f"{height:g}"
        out["pouch_closed_width_mm"] = out["pouch_open_width_mm"] = f"{width:g}"
    lay = LAYFLAT.search(text)
    if lay:
        out["sleeve_layflat_mm"] = lay.group(1)
    code = re.search(r"\bFG(?:SL|PO)\d+", text)
    if code:
        out["item_no"] = code.group(0)
    return out


def layflat(printed_width: float, layflat_mm: float | None) -> float:
    """The flat tube's width: as printed on the sheet, else the printed width less a usual seam, halved."""
    if layflat_mm and 0.3 * printed_width <= layflat_mm <= 0.55 * printed_width:
        return layflat_mm
    return (printed_width - SEAM_MM) / 2


def size_from_filename(filename: str) -> tuple[float, float] | None:
    """'..SLEEVE_57.15 X 170 mm..' in the file name: (height, printed width)."""
    m = SIZE.search(filename)
    return (float(m.group(1)), float(m.group(2))) if m else None


def _rects(pdf: Path) -> list:
    """Every rectangle drawn or filled on the page and every placed image, in PDF points (y up)."""
    import pymupdf

    from app.pdf.layers import Box
    from app.pdf.vector import dieline_grids

    out = []
    try:
        out += [g.box for g in dieline_grids(pdf)]
    except Exception:  # noqa: BLE001 - an unreadable drawing: the page's own rectangles still count
        pass
    with pymupdf.open(pdf) as doc:
        page = doc[0]
        inv = ~page.transformation_matrix
        rects = [d["rect"] for d in page.get_drawings()] + [pymupdf.Rect(i["bbox"]) for i in page.get_image_info()]
        for r in rects:
            q = (r * inv).normalize()
            if q.width > 20 / 25.4 * 72 and q.height > 15 / 25.4 * 72:
                out.append(Box(q.x0, q.y0, q.x1, q.y1))
    return out


def guide_lines(pdf: Path, box) -> list[tuple[bool, float, float]]:
    """The sheet's guides crossing the sleeve: fold, overlap, patch and dimension lines, and the cut lines
    along its edges. Each is a single straight stroke that runs across the printed area and on past its
    edge (FGSL4021's fold lines are 71.9 mm long on a 60.3 mm sleeve); artwork stops at the print.
    Returns (vertical, position, stroke width, from, to) in PDF points (y up) for each."""
    import pymupdf

    out = []
    slack = 1.0 / 25.4 * 72  # 1 mm
    with pymupdf.open(pdf) as doc:
        page = doc[0]
        inv = ~page.transformation_matrix
        # each straight segment of every stroked path (guides are often stroked together with other marks)
        segments = [(it[1], it[2], d) for d in page.get_drawings() if d.get("color") for it in d.get("items") or [] if it[0] == "l"]
        for p1, p2, d in segments:
            a, b = p1 * inv, p2 * inv
            if abs(a.x - b.x) < 0.5:  # down the sleeve
                lo, hi, pos, low, high = min(a.y, b.y), max(a.y, b.y), a.x, box.y0, box.y1
                inside = box.x0 - 0.5 <= pos <= box.x1 + 0.5
            elif abs(a.y - b.y) < 0.5:  # across it
                lo, hi, pos, low, high = min(a.x, b.x), max(a.x, b.x), a.y, box.x0, box.x1
                inside = box.y0 - 0.5 <= pos <= box.y1 + 0.5
            else:
                continue
            crosses = min(hi, high) - max(lo, low) >= 0.9 * (high - low)
            if inside and crosses and (lo < low - slack or hi > high + slack):
                out.append((abs(a.x - b.x) < 0.5, pos, float(d.get("width") or 0.5), lo, hi))
    return out


def callout_leaders(pdf: Path, box) -> list[tuple[bool, float, float, float]]:
    """Proof-note leaders drawn in pieces: thin straight horizontal / vertical pieces (stroked lines, or hairline
    filled outlines) joined end to end along one line, kept when the joined line reaches over 6 mm out past
    `box` and into it. FGPO7838's "FSSAI logo color change into black colour" leader is three 0.2 mm filled
    strips broken at the panel edge: no single piece both starts outside the print and reaches into it.
    Returns (vertical, position, start, end) in PDF points (y up)."""
    import pymupdf

    mm = 72 / 25.4
    pieces: list[tuple[bool, float, float, float]] = []
    with pymupdf.open(pdf) as doc:
        page = doc[0]
        inv = ~page.transformation_matrix
        for d in page.get_drawings():
            items = d.get("items") or []
            if any(it[0] not in ("l", "re") for it in items):
                continue  # curves: lettering or a shape, never a leader (small text is under 1.5 mm tall too)
            r0 = (d["rect"] * inv).normalize()
            # a filled hairline outline (a stroke turned into a shape) is one thin rectangle as a whole
            rects = [r0] if len(items) <= 16 and min(r0.width, r0.height) <= 0.8 * mm else []
            for it in items:
                if it[0] == "l":
                    rects.append(pymupdf.Rect(it[1] * inv, it[2] * inv).normalize())
                elif it[0] == "re":
                    rects.append((it[1] * inv).normalize())
            for r in rects:
                if r.height <= 1.5 * mm and r.width > 3 * r.height and r.width > 2 * mm:
                    pieces.append((False, (r.y0 + r.y1) / 2, r.x0, r.x1))
                elif r.width <= 1.5 * mm and r.height > 3 * r.width and r.height > 2 * mm:
                    pieces.append((True, (r.x0 + r.x1) / 2, r.y0, r.y1))
    joined: list[list] = []
    # (grouped by line first, then along it: pieces of one leader differ in position by a hair, and sorted by
    # exact position they interleaved with the same leader on a preview copy beside it and never met)
    for vertical, pos, lo, hi in sorted(pieces, key=lambda p: (p[0], round(p[1] / (0.5 * mm)), p[2])):
        last = joined[-1] if joined else None
        if last and last[0] == vertical and abs(last[1] - pos) <= 0.5 * mm and lo <= last[3] + 1.5 * mm:
            last[3] = max(last[3], hi)
        else:
            joined.append([vertical, pos, lo, hi])
    out = []
    for vertical, pos, lo, hi in joined:
        x0, x1, y0, y1 = (pos, pos, lo, hi) if vertical else (lo, hi, pos, pos)
        out_far = x0 < box.x0 - 6 * mm or x1 > box.x1 + 6 * mm or y0 < box.y0 - 6 * mm or y1 > box.y1 + 6 * mm
        if out_far and x1 > box.x0 + mm and x0 < box.x1 - mm and y1 > box.y0 + mm and y0 < box.y1 - mm:
            out.append((vertical, pos, lo, hi))
    return out


def has_callout_leaders(pdf: Path, box) -> bool:
    """Whether a proof note's leader runs in from the sheet's margin onto the print (`box`, PDF points, y up):
    a thin straight piece reaching over 6 mm out past it and into it (FGPO5262's "Text Color Change Into
    White"). No artwork starts outside the print beyond its bleed. without_guides(crossing=box) removes them."""
    import pymupdf

    mm = 72 / 25.4
    with pymupdf.open(pdf) as doc:
        page = doc[0]
        inv = ~page.transformation_matrix
        for d in page.get_drawings():
            for it in d.get("items") or []:
                if it[0] == "l":
                    a, b = it[1] * inv, it[2] * inv
                elif it[0] == "re":
                    r = (it[1] * inv).normalize()
                    a, b = r.top_left, r.bottom_right
                else:
                    continue
                x0, x1, y0, y1 = min(a.x, b.x), max(a.x, b.x), min(a.y, b.y), max(a.y, b.y)
                if min(x1 - x0, y1 - y0) > 1.5 * mm:
                    continue
                out_far = x0 < box.x0 - 6 * mm or x1 > box.x1 + 6 * mm or y0 < box.y0 - 6 * mm or y1 > box.y1 + 6 * mm
                if out_far and x1 > box.x0 + mm and x0 < box.x1 - mm and y1 > box.y0 + mm and y0 < box.y1 - mm:
                    return True
    return bool(callout_leaders(pdf, box))  # (a leader drawn in pieces)


def guide_frames(pdf: Path, box) -> list[tuple[float, float, float, float]]:
    """The sheet's technical frames over the sleeve: thin stroke-only rectangles (cyan cut frame, magenta
    fold / panel frame, FGSL4042's round its front panel) spanning nearly all its height or width, which
    no design draws. Returns (x0, y0, x1, y1) in PDF points (y up)."""
    import pymupdf

    out = []
    with pymupdf.open(pdf) as doc:
        page = doc[0]
        inv = ~page.transformation_matrix
        for d in page.get_drawings():
            items = d.get("items") or []
            if len(items) != 1 or items[0][0] != "re" or d.get("fill") or not d.get("color") or float(d.get("width") or 0) > 1.0:
                continue
            r = (d["rect"] * inv).normalize()
            if r.x1 < box.x0 - 2 or r.x0 > box.x1 + 2 or r.y1 < box.y0 - 2 or r.y0 > box.y1 + 2:
                continue
            if r.height >= 0.9 * (box.y1 - box.y0) or r.width >= 0.9 * (box.x1 - box.x0):
                out.append((r.x0, r.y0, r.x1, r.y1))
    return out


# graphics-state operators that may sit between a path and its paint operator
STATE_OPS = {b"w", b"J", b"j", b"M", b"d", b"ri", b"i", b"gs", b"CS", b"cs", b"SC", b"SCN", b"sc", b"scn", b"G", b"g", b"RG", b"rg", b"K", b"k"}


def without_guides(pdf: Path, guides: list, out: Path, frames: list | tuple = (), crossing=None) -> Path:
    """A copy of the sheet with its guide lines taken out (guide_lines), so the sleeve renders as printed:
    text and pictures a fold line ran over come out whole. The drawing operators are edited: a stroked
    two-point sub-path (m, l) lying on a guide is dropped, wherever it is drawn (the page or a form it
    uses; FGSL4021 strokes its fold lines among other marks in one path, so a redaction box never covers
    the path whole, and one that merely touches takes the shapes it crosses too). Nothing else changes.

    `crossing` (the print's box, PDF points y up): also drops callout leaders, any painted sub-path (stroked
    or filled) thinner than 1.5 mm that reaches over 6 mm out past the box (beyond any bleed) and into it
    (FGPO5262's leader, outlined and filled together with its note's lettering)."""
    from pypdf import PdfWriter
    from pypdf.generic import ContentStream, NameObject

    def on_guide(p: tuple[float, float], q: tuple[float, float]) -> bool:
        for vertical, pos, _w, lo, hi in guides:
            a, b = (0, 1) if vertical else (1, 0)  # across, along
            if abs(p[a] - pos) < 0.6 and abs(q[a] - pos) < 0.6 and abs(min(p[b], q[b]) - lo) < 0.6 and abs(max(p[b], q[b]) - hi) < 0.6:
                return True
        return False

    MM = 72 / 25.4
    leaders = callout_leaders(pdf, crossing) if crossing is not None else []

    def crosses(m: list[float], sub: list) -> bool:
        if crossing is None:
            return False
        pts = []
        for operands, op in sub:
            v = [float(x) for x in operands]
            if op == b"re":
                pts += [apply(m, v[0], v[1]), apply(m, v[0] + v[2], v[1] + v[3])]
            else:
                pts += [apply(m, v[k], v[k + 1]) for k in range(0, len(v) - 1, 2)]
        if not pts:
            return False
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        if min(x1 - x0, y1 - y0) > 1.5 * MM:
            return False
        b = crossing
        out_far = x0 < b.x0 - 6 * MM or x1 > b.x1 + 6 * MM or y0 < b.y0 - 6 * MM or y1 > b.y1 + 6 * MM
        reaches_in = x1 > b.x0 + MM and x0 < b.x1 - MM and y1 > b.y0 + MM and y0 < b.y1 - MM
        if out_far and reaches_in:
            return True
        # a piece of a leader drawn in pieces: straight, thin, along one of the joined leaders, within its extent
        if any(op not in (b"m", b"l", b"re", b"h") for _, op in sub):
            return False  # (curves: lettering on the line's height, not the leader)
        for vertical, pos, lo, hi in leaders:
            if vertical and x1 - x0 <= 1.5 * MM and abs((x0 + x1) / 2 - pos) <= 0.5 * MM and y0 >= lo - MM and y1 <= hi + MM:
                return True
            if not vertical and y1 - y0 <= 1.5 * MM and abs((y0 + y1) / 2 - pos) <= 0.5 * MM and x0 >= lo - MM and x1 <= hi + MM:
                return True
        return False

    def on_frame(m: list[float], x: float, y: float, w: float, h: float) -> bool:
        (ax, ay), (bx, by) = apply(m, x, y), apply(m, x + w, y + h)
        r = (min(ax, bx), min(ay, by), max(ax, bx), max(ay, by))
        return any(all(abs(u - v) < 0.8 for u, v in zip(r, f)) for f in frames)

    def mul(m: list[float], n: list[float]) -> list[float]:  # m then n (PDF row-vector matrices)
        return [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
                m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]]

    def apply(m: list[float], x: float, y: float) -> tuple[float, float]:
        return (x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5])

    removed = 0
    seen: set[int] = set()

    def clean(stream, resources, ctm: list[float]):
        nonlocal removed
        ops, out_ops, path, held, stack = ContentStream(stream, writer).operations, [], [], [], []
        for operands, op in ops:
            if path and op in STATE_OPS:
                held.append((operands, op))  # (a stroke's colour / width set between the path and its paint)
                continue
            if op == b"q":
                stack.append(ctm)
            elif op == b"Q" and stack:
                ctm = stack.pop()
            elif op == b"cm":
                ctm = mul([float(v) for v in operands], ctm)
            elif op == b"Do" and resources is not None:
                xo = resources.get("/XObject", {}).get(operands[0])
                xo_obj = xo.get_object() if xo is not None else None
                if xo_obj is not None and xo_obj.get("/Subtype") == "/Form" and id(xo_obj) not in seen:
                    seen.add(id(xo_obj))
                    fm = [float(v) for v in xo_obj.get("/Matrix", [1, 0, 0, 1, 0, 0])]
                    data = clean(xo_obj, xo_obj.get("/Resources", resources), mul(fm, ctm))
                    if data is not None:
                        xo_obj.set_data(data)
            if op in (b"m", b"l", b"c", b"v", b"y", b"h", b"re"):
                path.append((operands, op))
                continue
            if path:
                if op in (b"S", b"s") or (crossing is not None and op in (b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*")):
                    stroke_only = op in (b"S", b"s")
                    keep, i = [], 0
                    while i < len(path):  # sub-paths: each m or re starts one
                        j = i + 1
                        while j < len(path) and path[j][1] not in (b"m", b"re"):
                            j += 1
                        sub = path[i:j]
                        line = [o for o in sub if o[1] != b"h"]  # (closing a two-point path draws the same line)
                        if crosses(ctm, line):
                            removed += 1
                        elif stroke_only and len(line) == 1 and line[0][1] == b"re" and on_frame(ctm, *map(float, line[0][0])):
                            removed += 1
                        elif (stroke_only and len(line) == 2 and line[0][1] == b"m" and line[1][1] == b"l"
                                and on_guide(apply(ctm, *map(float, line[0][0])), apply(ctm, *map(float, line[1][0])))):
                            removed += 1
                        else:
                            keep += sub
                        i = j
                    out_ops += held + keep
                    path, held = [], []
                    if not keep:
                        continue  # nothing left to stroke
                else:
                    out_ops += held + path
                    path, held = [], []
            out_ops.append((operands, op))
        out_ops += held + path
        if len(out_ops) == len(ops):
            return None
        cs = ContentStream(None, writer)
        cs.operations = out_ops
        return cs.get_data()

    writer = PdfWriter(clone_from=str(pdf))
    page = writer.pages[0]
    m0 = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    data = clean(page.get_contents(), page.get("/Resources"), m0)
    if data is not None:
        cs = ContentStream(None, writer)
        cs.set_data(data)
        page.replace_contents(cs)
    with open(out, "wb") as fh:
        writer.write(fh)
    return out


def _variety(pdf: Path, box) -> int:
    """How many distinct colours (each over 0.3 % of the area) `box` shows: a separation preview (the white
    plate in grey, gloss / matt in two flat tints) has two or three, the printed artwork many more."""
    import numpy as np
    import pymupdf

    with pymupdf.open(pdf) as doc:
        page = doc[0]
        clip = (pymupdf.Rect(box.x0, box.y0, box.x1, box.y1) * page.transformation_matrix).normalize() & page.rect
        if clip.is_empty:
            return 0
        pix = page.get_pixmap(dpi=25, clip=clip, colorspace=pymupdf.csRGB, alpha=False)
    rgb = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.stride)[:, : pix.width * 3].reshape(-1, 3) >> 4
    _, counts = np.unique(rgb, axis=0, return_counts=True)
    return int((counts >= 0.003 * len(rgb)).sum())


def _copy_of(pdf: Path, trim, alike: list):
    """One of several same-size rectangles: the printed sleeve, not a separation preview of it (FGSL4036's
    white plate beside it, FGSL4046 / 4109's gloss & matt above it: picked by list order they gave black or
    empty sleeves). One inside the file's own artwork area first, then the one with the most colours."""
    def inside(b) -> bool:
        return b.x0 >= trim.x0 - 3 and b.y0 >= trim.y0 - 3 and b.x1 <= trim.x1 + 3 and b.y1 <= trim.y1 + 3

    pool = [b for b in alike if inside(b)] or alike
    return max(pool, key=lambda b: _variety(pdf, b))


def artwork_box(pdf: Path, trim, width_mm: float | None, height_mm: float | None):
    """The sleeve's printed area on the sheet (PDF points, y up), with its size: the drawn rectangle
    closest to the stated height x printed width (the drawing wins: FGSL4091 states 182 mm, draws 176);
    with no stated size, the largest rectangle that is not the page frame; else the TrimBox. Of several
    copies of that size (artwork + separation previews) the printed one (_copy_of)."""
    rects = _rects(pdf)
    if width_mm and height_mm:
        near = [b for b in rects if abs(b.height_mm - height_mm) <= 4 and abs(b.width_mm - width_mm) <= 12]
        if near:
            score = lambda b: 2 * abs(b.height_mm - height_mm) + abs(b.width_mm - width_mm)  # noqa: E731
            best = min(near, key=score)
            alike = [b for b in near if score(b) <= score(best) + 3]
            return best if len(alike) == 1 else _copy_of(pdf, trim, alike)
    else:
        import pymupdf

        with pymupdf.open(pdf) as doc:
            page = doc[0].rect
        if trim.width_mm < page.width * 25.4 / 72 - 2 or trim.height_mm < page.height * 25.4 / 72 - 2:
            return trim  # a TrimBox set round the artwork (ArtPro / Esko exports: FGSL4034)
        inner = [b for b in rects if b.width_mm < 0.95 * trim.width_mm and b.height_mm < 0.95 * trim.height_mm
                 and 1.0 <= b.width_mm / max(b.height_mm, 1) <= 6]
        if inner:
            big = max(inner, key=lambda b: b.width_mm * b.height_mm)
            alike = [b for b in inner if abs(b.width_mm - big.width_mm) <= 3 and abs(b.height_mm - big.height_mm) <= 3]
            return big if len(alike) == 1 else _copy_of(pdf, trim, alike)
    return trim

