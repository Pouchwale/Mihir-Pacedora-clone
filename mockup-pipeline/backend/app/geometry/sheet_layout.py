"""Panels on one sheet: which part of the dieline is the front, the back, the gusset or a side.

Some approval PDFs draw the whole printed web of one pouch instead of the front alone, e.g. a
stand-up pouch as front (upright) + bottom gusset + back (upside down, folded at the gusset):

    +---------+  0      top seal / notch / zipper bands ...
    |  front  |
    +---------+  210    (pouch height H)
    +---------+  213    3 mm unprinted strip
    | gusset  |         (gusset full width G, centre fold in the middle)
    +---------+  293
    +---------+  296
    |  back   |  upside down
    +---------+  506

The dieline's lines are exact (vector geometry) and the spec table gives H, W and G, so the sheet
is split by finding a chain of dieline intervals whose lengths are H (a face: front or back) or G
(a gusset / side), with only narrow unprinted strips between them. Faces laid out along the height
after the first one are upside down (the web is folded at the bottom); side-by-side panels are
all upright. Which face is the front is decided by the caller (text density, see extract_specs).

A centre-seal (pillow) pouch is drawn as its flat blank instead, `open width` across and H tall,
often several blanks side by side (FGPO7396: two 170 x 108 blanks on a 344 mm sheet):

    | fin | half back |  front  | half back | fin |   x n

A blank panel is split later into the front (its middle `closed width`) and the back (the two
outer strips joined at the fin seal), the same way as a roll-form repeat.

A sheet may carry the same web several times across ("ups": FGPO7410 draws its 90.49 x 130
front + back web twice side by side). The first up (reading order) is used and the count kept.
The last panel of a chain may end on the sheet's bleed edge without a line of its own: its end is
then taken `size` from its start when that leaves only a bleed-sized margin.
"""

from typing import Literal

from pydantic import BaseModel


class SheetPanel(BaseModel):
    kind: Literal["face", "gusset", "blank"]  # face = front/back sized; gusset = bottom/side gusset sized; blank = a whole pillow blank
    x_mm: float  # finished panel inside the sheet, from the sheet's top-left corner
    y_mm: float
    width_mm: float
    height_mm: float
    rotation: int = 0  # degrees counter-clockwise that turn the cut-out upright: 0, 90 (a blank drawn on its side) or 180
    role: str | None = None  # front / back for faces (set by the caller); gussets get theirs in link_panels


class SheetLayout(BaseModel):
    kind: Literal["single", "multi", "unknown"]
    axis: Literal["vertical", "horizontal"] | None = None
    panels: list[SheetPanel] = []
    ups: int = 1  # how many times the web is on the sheet across the chain axis (the first is used)
    message: str = ""
    front_words: dict[str, int] = {}  # words read per face when deciding which one is the front

    def face(self, role: str) -> SheetPanel | None:
        return next((p for p in self.panels if p.role == role), None)

    def blank(self) -> SheetPanel | None:
        """The first pillow blank on the sheet (reading order), if the sheet is laid out in blanks."""
        return next((p for p in self.panels if p.kind == "blank"), None)


def grid_layout(cells: list[tuple[float, float, float, float]], width: float, height: float, tol: float = 1.0) -> SheetLayout | None:
    """Panels of a sheet whose dieline is drawn in process colours (no technical ink: FGPO1788, an
    Illustrator sheet with two spec tables above a front + side gusset web and a back + side gusset
    web). `cells` are the closed dieline cells (x, y from the sheet's top-left, width, height; mm).

    The panels are the topmost row of cells as tall as the pouch, left to right: a cell about the
    pouch width is a face (the drawing may include the side seals: 234 mm for a 230 mm pouch), a
    narrower one a gusset / side. None when the sheet has no such row with a face in it."""
    tall = [c for c in cells if abs(c[3] - height) <= tol]
    # a cell that holds other cells (the frame around a web) is not a panel
    tall = [c for c in tall if not any(o is not c and o[0] >= c[0] - tol and o[0] + o[2] <= c[0] + c[2] + tol for o in tall
                                       if abs(o[1] - c[1]) <= tol)]
    if not tall:
        return None
    top = min(c[1] for c in tall)
    row = sorted((c for c in tall if abs(c[1] - top) <= tol), key=lambda c: c[0])
    panels = []
    for x, y, w, h in row:
        if abs(w - width) <= 0.1 * width:
            panels.append(SheetPanel(kind="face", x_mm=x, y_mm=y, width_mm=w, height_mm=h))
        elif w < 0.75 * width:
            panels.append(SheetPanel(kind="gusset", x_mm=x, y_mm=y, width_mm=w, height_mm=h))
    if not any(p.kind == "face" for p in panels):
        return None
    return SheetLayout(kind="multi", axis="horizontal", panels=panels, message="dieline cells in process colours")


def side_roles(layout: SheetLayout) -> None:
    """Name the gussets of a side-by-side web side_left / side_right from the face they join: the
    one right of the front (or left of the back) is the pouch's right side, the other its left."""
    for i, p in enumerate(layout.panels):
        if p.kind != "gusset":
            continue
        before = layout.panels[i - 1].role if i > 0 else None
        after = layout.panels[i + 1].role if i + 1 < len(layout.panels) else None
        if before == "front" or after == "back":
            p.role = "side_right"
        elif before == "back" or after == "front":
            p.role = "side_left"


def _chain(positions: list[float], length: float, sizes: dict[str, float], gap_max: float, margin_max: float, tol: float,
           virtual: frozenset[float] = frozenset(), implied: frozenset[float] = frozenset()):
    """Best split of [0, length] into panels of the given sizes, narrow gaps and edge margins.

    Returns [(kind, start, end)] or None. Most panels win, then the fewest `implied` (undrawn, derived)
    positions used and the most drawn ones, then a chain ending on a drawn line over one ending on a
    `virtual` (undrawn) position, then fewest gaps, then least margin. Without implied positions the
    order is as before.
    """
    virtual = frozenset(round(v, 4) for v in virtual)
    implied = frozenset(round(v, 4) for v in implied)
    p = sorted(set(round(v, 4) for v in positions) | implied)
    n = len(p)
    best: list[tuple | None] = [None] * n  # per position: (score, path)
    for i, v in enumerate(p):
        if v <= margin_max + tol:
            best[i] = ((0, -(v in implied), int(bool(implied) and v not in implied and v > tol), 0, -v), [])
    for i in range(n):
        if best[i] is None:
            continue
        (panels, neg_implied, drawn, neg_gaps, neg_margin), path = best[i]
        for j in range(i + 1, n):
            d = p[j] - p[i]
            ni = neg_implied - (p[j] in implied)
            dr = drawn + int(bool(implied) and p[j] not in implied)  # counted only when implied positions are in play
            steps = [(k, (panels + 1, ni, dr, neg_gaps, neg_margin)) for k, s in sizes.items() if s and abs(d - s) <= tol]
            if 0 < d <= gap_max and path and path[-1][0] != "gap":
                steps.append(("gap", (panels, ni, dr, neg_gaps - 1, neg_margin)))
            for kind, score in steps:
                cand = (score, [*path, (kind, p[i], p[j])])
                if best[j] is None or cand[0] > best[j][0]:
                    best[j] = cand
    ends = [((b[0][0], b[0][1], b[0][2], -1 if p[j] in virtual else 0, b[0][3], b[0][4] - (length - p[j])), b[1]) for j, b in enumerate(best)
            if b is not None and length - p[j] <= margin_max + tol and b[1] and b[1][-1][0] != "gap"]
    if not ends:
        return None
    return max(ends, key=lambda e: e[0])[1]


def _finished_span(positions: list[float], total: float, size: float, tol: float) -> tuple[float, float] | None:
    """Where a panel of `size` sits across the sheet: the pair of dieline lines that far apart (the most
    centred pair when several), else centred in the sheet (the bleed is symmetric; a sheet may draw
    only one of the two edge lines, FGPO7492)."""
    pairs = [(a, b) for a in positions for b in positions if b > a and abs((b - a) - size) <= tol]
    if pairs:
        # closest to the size first (FGPO7404: 217.00 beats a 216.63 pair of neighbouring lines), then centred
        return min(pairs, key=lambda ab: (round(abs((ab[1] - ab[0]) - size), 1), abs(ab[0] - (total - ab[1]))))
    if total - size >= -tol:
        margin = max(0.0, (total - size) / 2)
        return (margin, margin + size)
    return None


def detect(
    sheet_w: float, sheet_h: float, xs: list[float], ys: list[float],
    width: float, height: float, gusset: float | None,
    gap_max: float = 20.0, bleed_max: float = 25.0, tol: float = 0.5, open_width: float | None = None,
    implied_y: tuple[float, ...] = (), prefer_blank: bool = False,
) -> SheetLayout:
    """Split a sheet (mm, dieline positions measured from its top-left) into pouch panels.

    `open_width` (the table's Pouch Open Width) enables the pillow-blank layout: cells of
    open width x height, side by side or stacked, when no face / gusset chain fits.
    `prefer_blank` (the table says centre seal): blanks are looked for first, since lines inside a
    blank can sit a face apart by coincidence (FGPO7058: a 164 mm run inside its 170 mm blanks)."""
    if -tol <= sheet_w - width <= 2 * bleed_max and -tol <= sheet_h - height <= 2 * bleed_max:
        return SheetLayout(kind="single")
    if prefer_blank and open_width and open_width > width + tol:
        blanks = _blanks(sheet_w, sheet_h, xs, ys, open_width, height, gap_max, bleed_max, tol)
        if blanks is not None:
            return blanks
    faces = _faces(sheet_w, sheet_h, xs, ys, width, height, gusset, gap_max, bleed_max, tol, implied_y)
    if faces is not None:
        return faces
    if open_width and open_width > width + tol:
        blanks = _blanks(sheet_w, sheet_h, xs, ys, open_width, height, gap_max, bleed_max, tol)
        if blanks is not None:
            return blanks
    g = gusset or 0.0
    return SheetLayout(kind="unknown", message=(
        f"The {sheet_w:.2f} x {sheet_h:.2f} mm dieline is not one {width} x {height} mm panel, and no chain of "
        f"{height} mm / {width} mm faces{f' and {g} mm gussets' if g else ''}"
        f"{f' (nor of {open_width} mm blanks)' if open_width else ''} was found on it"))


def _blanks(sheet_w: float, sheet_h: float, xs: list[float], ys: list[float], open_width: float, height: float,
            gap_max: float, bleed_max: float, tol: float) -> SheetLayout | None:
    """Pillow blanks (open width x height) side by side ("horizontal"), or drawn on their side and
    stacked ("vertical": open width runs down the sheet, the blank is turned 90 degrees upright).
    Both ways are tried with the whole sheet first; a cut-off repeat at the end only after that."""
    for cut_tail in (False, True):
        found = _blanks_way(sheet_w, sheet_h, xs, ys, open_width, height, gap_max, bleed_max, tol, cut_tail)
        if found is not None:
            return found
    return None


def _blanks_way(sheet_w: float, sheet_h: float, xs: list[float], ys: list[float], open_width: float, height: float,
                gap_max: float, bleed_max: float, tol: float, cut_tail: bool) -> SheetLayout | None:
    for axis in ("horizontal", "vertical"):
        along, across = (xs, ys) if axis == "horizontal" else (ys, xs)
        length, cross = (sheet_w, sheet_h) if axis == "horizontal" else (sheet_h, sheet_w)
        # (several blanks across the chain too: FGPO7058 has two 164 mm ups beside each other)
        ups = _ups_across(cross, height, bleed_max, gap_max, tol)
        if ups is None:
            # the blank does not fill the sheet across (FGPO6813: one blank under the spec table on the
            # same page): it is where two drawn lines sit exactly its height apart
            drawn = [(a, b) for a in across for b in across if b > a and abs((b - a) - height) <= tol]
            if not drawn:
                continue
            ups, span = 1, min(drawn, key=lambda ab: abs((ab[1] - ab[0]) - height))
        else:
            span = (_finished_span([0.0, *across, cross], cross, height, tol) if ups == 1
                    else _first_up([0.0, *across, cross], cross, height, ups, tol))
        if span is None:
            continue
        chain = _chain([0.0, *along, length], length, {"blank": open_width}, gap_max, bleed_max, tol)
        if not chain and cut_tail:
            # the next repeat cut off by the sheet edge (FGPO7338: three flavours across, a second row of
            # them starting 7 mm below the first and running off the sheet): end before that tail
            for end in sorted({p for p in along if 0 < length - p < open_width + gap_max}, reverse=True):
                chain = _chain([0.0, *[p for p in along if p <= end + tol]], end, {"blank": open_width}, gap_max, bleed_max, tol)
                if chain:
                    break
        if not chain:
            continue
        panels = []
        for kind, a, b in chain:
            if kind == "gap":
                continue
            x0, x1 = ((a, b) if axis == "horizontal" else span)
            y0, y1 = (span if axis == "horizontal" else (a, b))
            panels.append(SheetPanel(kind="blank", x_mm=round(x0, 2) + 0.0, y_mm=round(y0, 2) + 0.0, width_mm=round(x1 - x0, 2),
                                     height_mm=round(y1 - y0, 2), rotation=0 if axis == "horizontal" else 90))
        if panels:
            return SheetLayout(kind="multi", axis=axis, panels=panels, ups=ups)
    return None


def _ups_across(cross: float, size: float, bleed_max: float, gap_max: float, tol: float, most: int = 8) -> int | None:
    """How many `size` wide ups fill the sheet across the chain axis: a bleed at most on each side
    and, between ups, an unprinted strip up to `gap_max` (FGPO7165: four 150 mm ups on a 650 mm web)."""
    for k in range(1, most + 1):
        if -tol <= cross - k * size <= 2 * bleed_max + (k - 1) * gap_max:
            return k
    return None


def _first_up(positions: list[float], cross: float, size: float, ups: int, tol: float) -> tuple[float, float] | None:
    """Where the first up's panel sits across the sheet: the most centred pair of lines `size` apart
    inside the first cell (cross / ups wide), else centred in that cell (a sheet may draw only one of
    the two edge lines, FGPO7492)."""
    cell = cross / ups
    pairs = [(a, b) for a in positions for b in positions if b > a and abs((b - a) - size) <= tol and b <= cell + tol]
    if pairs:
        return min(pairs, key=lambda ab: (round(abs((ab[1] - ab[0]) - size), 1), abs(ab[0] - (cell - ab[1]))))
    if cell - size >= -tol:
        margin = max(0.0, (cell - size) / 2)
        return (margin, margin + size)
    return None


def _with_undrawn_ends(positions: list[float], length: float, sizes: dict[str, float], margin_max: float, tol: float) -> tuple[list[float], frozenset[float]]:
    """Positions plus the end a panel would have when it runs to the sheet's bleed edge without a line
    of its own (FGPO7410 draws the back's bottom seal line but not its cut line): `size` from any
    line, when the margin left after it matches a margin drawn at the start (bleed is symmetric)
    and no drawn line is near. The added positions are returned too, so a chain that ends on one
    ranks below one ending on a drawn line."""
    out = sorted(set(positions))
    leading = [q for q in out if 0 < q <= margin_max + tol]
    added: set[float] = set()
    for p in positions:
        for s in sizes.values():
            if not s:
                continue
            end = p + s
            trailing = length - end
            if 0 <= trailing <= margin_max + tol and any(abs(trailing - m) <= 2 * tol for m in leading) and not any(abs(end - q) <= tol for q in out):
                out.append(end)
                added.add(end)
    return sorted(out), frozenset(added)


def _faces(sheet_w: float, sheet_h: float, xs: list[float], ys: list[float], width: float, height: float, gusset: float | None,
           gap_max: float, bleed_max: float, tol: float, implied_y: tuple[float, ...] = ()) -> SheetLayout | None:
    """`implied_y`: undrawn line positions a face may start or end on (ranked below drawn ones)."""
    g = gusset or 0.0
    for axis in ("vertical", "horizontal"):
        along, across = (ys, xs) if axis == "vertical" else (xs, ys)
        length, cross = (sheet_h, sheet_w) if axis == "vertical" else (sheet_w, sheet_h)
        face_len, cross_len = (height, width) if axis == "vertical" else (width, height)
        ups = _ups_across(cross, cross_len, bleed_max, gap_max, tol)
        if ups is None:
            continue
        span = _first_up([0.0, *across, cross], cross, cross_len, ups, tol)
        if span is None:
            continue
        sizes = {"face": face_len, "gusset": g}
        positions, virtual = _with_undrawn_ends([0.0, *along, length], length, sizes, bleed_max, tol)
        chain = _chain(positions, length, sizes, gap_max, bleed_max, tol, virtual, frozenset(implied_y if axis == "vertical" else ()))
        for copies in (2, 3, 4):
            if chain:
                break
            # the web repeated along the sheet (FGPO6059: the artwork, then its white-ink plate drawn
            # as a second copy 34 mm below): read the first copy, its `length / copies` share
            part = length / copies
            near = [p for p in positions if p <= part + tol]
            chain = _chain([*near, part], part, sizes, gap_max, bleed_max, tol, virtual, frozenset(implied_y if axis == "vertical" else ()))
        if not chain:
            continue
        pieces = [c for c in chain if c[0] != "gap"]
        if len(pieces) < 2 or not any(k == "face" for k, _, _ in pieces):
            continue
        panels: list[SheetPanel] = []
        seen_face = seen_fold = False
        for kind, a, b in pieces:
            rotation = 0
            if axis == "vertical" and kind == "face":
                rotation = 180 if (seen_face or seen_fold) else 0
                seen_face = True
            if axis == "vertical" and kind == "gusset" and seen_face:
                seen_fold = True
            x0, x1 = (span if axis == "vertical" else (a, b))
            y0, y1 = ((a, b) if axis == "vertical" else span)
            # 0.01 mm: dieline positions come from point coordinates and carry micrometre noise.
            panels.append(SheetPanel(kind=kind, x_mm=round(x0, 2) + 0.0, y_mm=round(y0, 2) + 0.0, width_mm=round(x1 - x0, 2),
                                     height_mm=round(y1 - y0, 2), rotation=rotation))
        return SheetLayout(kind="multi", axis=axis, panels=panels, ups=ups)
    return None
