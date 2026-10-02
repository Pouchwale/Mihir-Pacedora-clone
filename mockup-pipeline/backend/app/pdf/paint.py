"""Remove (or keep only) what is painted with chosen separations, by editing the content streams.

Files without layers (Adobe Illustrator exports) paint the dieline and its dimension labels with
the technical spot ink straight over the artwork. Rewriting that ink's tint transform to "no ink"
(app.pdf.inks.suppress_inks) is not enough there: its alternate colour is opaque, so the lines
would still knock the artwork out in white. Instead every painting operator whose colour is made
only of those colorants becomes a no-op: paths end with `n` (clipping kept), text is shown with
render mode 3 (invisible), images and shadings are skipped. That is exactly what turning a layer
off does. The opposite mode keeps only those operators (a clean dimensions-only drawing).
"""

from dataclasses import dataclass, replace
from typing import Literal

from pypdf import PdfWriter
from pypdf.generic import ArrayObject, ContentStream, DictionaryObject, NameObject, NumberObject

from app.pdf.inks import _colorant_names

Mode = Literal["strip", "only"]

# Pseudo-ink for the studio's annotation colour: paint set to C0 M100 Y100 with K 0 to 70 (`k` / `K`, or `sc` in CMYK)
# (callout lines and labels such as "Metalic Effect" / "Coffee Valve" drawn over the artwork, FGPO4004).
ANNOTATION_RED = "<annotation red: CMYK 0 100 100 0-70>"


def _is_annotation_red(operands) -> bool:
    try:
        # (K up to 70 %: the same red darkened to show on a dark background, FGPO7058's callouts over brown)
        return (len(operands) == 4 and all(abs(float(v) - t) < 1e-3 for v, t in zip(operands, (0, 1, 1)))
                and 0 <= float(operands[3]) <= 0.7 + 1e-3)
    except (TypeError, ValueError):
        return False

def _inked(operands, positions) -> bool:
    try:
        return any(float(operands[i]) > 0 for i in positions)
    except (IndexError, TypeError, ValueError):
        return False


# path painting operator -> (paints fill, paints stroke, replacement when only the fill is removed,
# replacement when only the stroke is removed)
_PATHS: dict[bytes, tuple[bool, bool, bytes | None, bytes | None]] = {
    b"S": (False, True, None, None),
    b"s": (False, True, None, None),
    b"f": (True, False, None, None),
    b"F": (True, False, None, None),
    b"f*": (True, False, None, None),
    b"B": (True, True, b"S", b"f"),
    b"B*": (True, True, b"S", b"f*"),
    b"b": (True, True, b"s", b"f"),
    b"b*": (True, True, b"s", b"f*"),
}
_TEXT_SHOW = {b"Tj", b"TJ", b"'", b'"'}
_FILL_MODES = {0, 2, 4, 6}
_STROKE_MODES = {1, 2, 5, 6}


@dataclass(frozen=True)
class _State:
    fill: bool = False  # current fill colour is one of the chosen inks
    stroke: bool = False
    text_mode: int = 0
    # strip: where the chosen inks sit in a DeviceN that mixes them with other colorants. A path or
    # text painted with one of those tints set is drawn in the chosen ink (FGPO7058: callout lines in
    # "Dimensions and text" + Magenta + Yellow, which would stay behind as red lines); with the tint
    # at 0 it is artwork that merely shares the colour space.
    fill_mix: tuple[int, ...] = ()
    stroke_mix: tuple[int, ...] = ()
    # the current colour space is DeviceCMYK (set by `k` or `/DeviceCMYK cs`): a following `sc` gives
    # CMYK tints too (FGPO7058 sets its callout red with `0 1 1 0 sc`)
    fill_cmyk: bool = False
    stroke_cmyk: bool = False


class _Filter:
    def __init__(self, writer: PdfWriter, inks: set[str], mode: Mode):
        self.writer, self.inks, self.mode = writer, inks, mode
        self.forms: dict[int, bool] = {}  # form object id -> still paints something
        self.changed = 0

    # -- colour spaces
    def _chosen(self, cs) -> bool:
        """strip: every colorant is a chosen ink (nothing visible would be lost);
        only: any colorant is a chosen ink (a DeviceN mix of white + technical ink paints technical ink)."""
        cs = cs.get_object() if hasattr(cs, "get_object") else cs
        if isinstance(cs, ArrayObject) and len(cs) > 1 and str(cs[0]) == "/Indexed":
            return self._chosen(cs[1])
        if isinstance(cs, ArrayObject) and str(cs[0]) in ("/Separation", "/DeviceN"):
            names = _colorant_names(cs)
            if not names:
                return False
            return all(n in self.inks for n in names) if self.mode == "strip" else any(n in self.inks for n in names)
        return False

    def _named(self, res: DictionaryObject, name) -> bool:
        spaces = res.get("/ColorSpace")
        spaces = spaces.get_object() if spaces is not None else {}
        return name in spaces and self._chosen(spaces[name])

    def _mix(self, res: DictionaryObject, name) -> tuple[int, ...]:
        if self.mode != "strip":
            return ()
        spaces = res.get("/ColorSpace")
        cs = (spaces.get_object() if spaces is not None else {}).get(name)
        cs = cs.get_object() if cs is not None else None
        if not (isinstance(cs, ArrayObject) and str(cs[0]) == "/DeviceN"):
            return ()
        names = _colorant_names(cs)
        at = tuple(i for i, n in enumerate(names) if n in self.inks)
        return at if 0 < len(at) < len(names) else ()

    def _removed(self, chosen: bool) -> bool:
        return chosen if self.mode == "strip" else not chosen

    # -- streams
    def run_page(self, page) -> None:
        content = page.get_contents()
        if content is None:
            return
        res = (page.get("/Resources") or DictionaryObject()).get_object()
        changed, _ = self._filter(content, res, _State())
        if changed:
            page.replace_contents(content)

    def _form(self, xobj, state: _State) -> bool:
        """Filter a form XObject once; returns whether it still paints anything."""
        if id(xobj) in self.forms:
            return self.forms[id(xobj)]
        self.forms[id(xobj)] = True  # a form drawing itself: assume it paints
        content = ContentStream(xobj, self.writer)
        res = (xobj.get("/Resources") or DictionaryObject()).get_object()
        changed, paints = self._filter(content, res, state)
        if changed:
            data = content.get_data()
            try:
                xobj.set_data(data)
            except Exception:  # noqa: BLE001 - a filter pypdf cannot re-encode: store it plain
                for key in ("/Filter", "/DecodeParms"):
                    xobj.pop(key, None)
                xobj._data = data  # noqa: SLF001
        self.forms[id(xobj)] = paints
        return paints

    def _filter(self, content: ContentStream, res: DictionaryObject, state: _State) -> tuple[bool, bool]:
        """Rewrite `content` in place; returns (changed, still paints something)."""
        stack: list[_State] = []
        out: list = []
        changed = paints = False
        xobjects = (res.get("/XObject") or DictionaryObject()).get_object()
        shadings = (res.get("/Shading") or DictionaryObject()).get_object()
        for operands, op in content.operations:
            if op == b"q":
                stack.append(state)
            elif op == b"Q":
                state = stack.pop() if stack else _State()
            elif op == b"cs":
                mix = self._mix(res, operands[0])  # (a colour space starts with every tint at 1)
                state = replace(state, fill=self._named(res, operands[0]) or bool(mix), fill_mix=mix, fill_cmyk=str(operands[0]) == "/DeviceCMYK")
            elif op == b"CS":
                mix = self._mix(res, operands[0])
                state = replace(state, stroke=self._named(res, operands[0]) or bool(mix), stroke_mix=mix, stroke_cmyk=str(operands[0]) == "/DeviceCMYK")
            elif op in (b"sc", b"scn") and state.fill_mix:
                state = replace(state, fill=_inked(operands, state.fill_mix))
            elif op in (b"SC", b"SCN") and state.stroke_mix:
                state = replace(state, stroke=_inked(operands, state.stroke_mix))
            elif op in (b"sc", b"scn") and state.fill_cmyk:
                state = replace(state, fill=ANNOTATION_RED in self.inks and _is_annotation_red(operands))
            elif op in (b"SC", b"SCN") and state.stroke_cmyk:
                state = replace(state, stroke=ANNOTATION_RED in self.inks and _is_annotation_red(operands))
            elif op in (b"g", b"rg", b"k"):
                state = replace(state, fill=op == b"k" and ANNOTATION_RED in self.inks and _is_annotation_red(operands), fill_mix=(), fill_cmyk=op == b"k")
            elif op in (b"G", b"RG", b"K"):
                state = replace(state, stroke=op == b"K" and ANNOTATION_RED in self.inks and _is_annotation_red(operands), stroke_mix=(), stroke_cmyk=op == b"K")
            elif op == b"Tr":
                state = replace(state, text_mode=int(operands[0]))
            elif op in _PATHS:
                fills, strokes, keep_stroke, keep_fill = _PATHS[op]
                rf = fills and self._removed(state.fill)
                rs = strokes and self._removed(state.stroke)
                if (rf or not fills) and (rs or not strokes):
                    out.append(([], b"n"))
                    changed = True
                    continue
                if rf:
                    out.append(([], keep_stroke))
                    changed = paints = True
                    continue
                if rs:
                    out.append(([], keep_fill))
                    changed = paints = True
                    continue
                paints = True
            elif op in _TEXT_SHOW:
                m = state.text_mode
                used = [self._removed(state.fill)] * (m in _FILL_MODES) + [self._removed(state.stroke)] * (m in _STROKE_MODES)
                if used and all(used):
                    hidden = 7 if m >= 4 else 3  # keep the clipping of modes 4-6
                    out += [([NumberObject(hidden)], b"Tr"), (operands, op), ([NumberObject(m)], b"Tr")]
                    changed = True
                    continue
                paints = paints or bool(used)
            elif op == b"sh":
                sh = shadings.get(operands[0])
                if sh is not None and self._removed(self._chosen(sh.get_object().get("/ColorSpace"))):
                    changed = True
                    continue
                paints = True
            elif op == b"Do":
                xobj = xobjects.get(operands[0])
                xobj = xobj.get_object() if xobj is not None else None
                if xobj is not None and xobj.get("/Subtype") == "/Form":
                    if not self._form(xobj, state) and self.mode == "only":
                        changed = True  # nothing of the chosen inks inside: drop the whole group
                        continue
                    paints = True
                elif xobj is not None and xobj.get("/Subtype") == "/Image":
                    chosen = state.fill if xobj.get("/ImageMask") else self._chosen(xobj.get("/ColorSpace"))
                    if self._removed(chosen):
                        changed = True
                        continue
                    paints = True
            elif op == b"INLINE IMAGE":
                settings = operands.get("settings", {}) if isinstance(operands, dict) else {}
                cs = settings.get("/CS", settings.get("/ColorSpace"))
                mask = settings.get("/IM", settings.get("/ImageMask"))
                chosen = state.fill if mask else (self._named(res, cs) if isinstance(cs, NameObject) else False)
                if self._removed(chosen):
                    changed = True
                    continue
                paints = True
            out.append((operands, op))
        if changed:
            content.operations = out
            self.changed += 1
        return changed, paints


def filter_paint(writer: PdfWriter, inks: set[str], mode: Mode) -> int:
    """Strip (mode "strip") or keep only (mode "only") painting in `inks`. Returns streams changed."""
    f = _Filter(writer, inks, mode)
    for page in writer.pages:
        f.run_page(page)
    return f.changed


def separations(path) -> set[str]:
    """Names of every Separation / DeviceN colorant the first page (and its forms) can paint with."""
    from pypdf import PdfReader

    from app.pdf.inks import _all_resources

    names: set[str] = set()
    page = PdfReader(path).pages[0]
    for res in _all_resources(page):
        spaces = res.get("/ColorSpace")
        for cs in (spaces.get_object() if spaces else {}).values():
            cs = cs.get_object()
            if isinstance(cs, ArrayObject) and str(cs[0]) in ("/Separation", "/DeviceN"):
                names.update(_colorant_names(cs))
        for xobj in (res.get("/XObject") or DictionaryObject()).get_object().values():
            cs = xobj.get_object().get("/ColorSpace")
            cs = cs.get_object() if cs is not None else None
            if isinstance(cs, ArrayObject) and str(cs[0]) in ("/Separation", "/DeviceN"):
                names.update(_colorant_names(cs))
    return names


def flattened_images(path, inks: set[str]) -> bool:
    """Whether an image on the first page mixes one of `inks` with other colorants in one DeviceN
    raster (FGPO6786: artwork tiles in Black/Yellow/Magenta/Cyan + "Dimensions and text", the dieline
    flattened into them): what those inks drew cannot be taken out of such an image by its paint."""
    from pypdf import PdfReader

    from app.pdf.inks import _all_resources

    for res in _all_resources(PdfReader(path).pages[0]):
        for xobj in (res.get("/XObject") or DictionaryObject()).get_object().values():
            xobj = xobj.get_object()
            cs = xobj.get("/ColorSpace")
            cs = cs.get_object() if cs is not None else None
            if xobj.get("/Subtype") == "/Image" and isinstance(cs, ArrayObject) and str(cs[0]) == "/DeviceN":
                names = set(_colorant_names(cs))
                if names & inks and names - inks:
                    return True
    return False


def paints_annotation_red(path) -> bool:
    """Whether any content stream of the first page sets C0 M100 Y100 K0 with `k` / `K` at all: a scan
    of the raw streams, so a file without the annotation colour skips the (slow) paint filtering."""
    import re

    from pypdf import PdfReader

    from app.pdf.inks import _all_resources

    red = re.compile(rb"(?<![\d.])0(?:\.0+)?\s+1(?:\.0+)?\s+1(?:\.0+)?\s+0(?:\.\d+)?\s+(?:[kK]|sc|SC|scn|SCN)\b")
    page = PdfReader(path).pages[0]
    contents = page.get_contents()
    streams = [contents] if contents is not None else []
    for res in _all_resources(page):
        for xobj in (res.get("/XObject") or DictionaryObject()).get_object().values():
            xobj = xobj.get_object()
            if xobj.get("/Subtype") == "/Form":
                streams.append(xobj)
    return any(red.search(st.get_data()) for st in streams)
