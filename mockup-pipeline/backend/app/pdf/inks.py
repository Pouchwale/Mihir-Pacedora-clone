"""Separation-aware colour handling.

ArtPro+ files carry non-visible separations (white underlay, UV varnish, the technical
"Dimensions and text" ink) as DeviceN/Separation colorants whose alternate CMYK is a preview
tint (Sp White previews as ~C20 M14 Y13 grey). Rendered as-is, that grey is mixed into every
colour printed over white. For the colour texture we rewrite each tint transform so the chosen
colorants contribute nothing; for material masks we do the opposite and keep only them.
"""

from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject, NumberObject


def _colorant_names(cs) -> list[str]:
    kind = str(cs[0])
    if kind == "/Separation":
        return [str(cs[1])[1:]]
    if kind == "/DeviceN":
        return [str(n)[1:] for n in cs[1].get_object()]
    return []


def _zero_inputs_function(n_inputs: int, zero: list[int], original) -> DecodedStreamObject:
    """A Type 4 function that zeroes input components `zero`, then evaluates `original`.

    `original` must be Type 4 (its body is inlined) or Type 2 (inlined as C0 + t*(C1-C0), N=1).
    """
    prefix = []
    for k in zero:
        depth = n_inputs - k
        prefix.append(f"{depth} -1 roll pop 0 {depth} 1 roll")
    ftype = int(original["/FunctionType"])
    if ftype == 4:
        body = original.get_data().decode("latin-1").strip()
        assert body.startswith("{") and body.endswith("}")
        body = body[1:-1]
    elif ftype == 2 and float(original.get("/N", 1)) == 1:
        c0 = [float(v) for v in original.get("/C0", [0])]
        c1 = [float(v) for v in original.get("/C1", [1])]
        # t on stack -> c0_i + t*(c1_i - c0_i) for each output
        parts = []
        for i, (a, b) in enumerate(zip(c0, c1)):
            parts.append(f"{i} index {b - a:.6f} mul {a:.6f} add")
            # each output is pushed above t; keep t at the bottom until all are computed
        body = " ".join(parts) + f" {len(c0) + 1} -1 roll pop"
    else:
        raise ValueError(f"unsupported tint transform type {ftype}")
    fn = DecodedStreamObject()
    fn.set_data((" { " + " ".join(prefix) + " " + body + " } ").encode("latin-1"))
    fn[NameObject("/FunctionType")] = NumberObject(4)
    fn[NameObject("/Domain")] = ArrayObject([FloatObject(v) for _ in range(n_inputs) for v in (0, 1)])
    rng = original.get("/Range")
    if rng is None:
        rng = ArrayObject([FloatObject(v) for _ in range(len(original.get("/C0", [0, 0, 0, 0]))) for v in (0, 1)])
    fn[NameObject("/Range")] = rng
    return fn


def suppress_inks(writer: PdfWriter, inks: set[str]) -> list[str]:
    """Make the named colorants contribute zero ink everywhere on every page. Returns what was changed."""
    changed: list[str] = []
    seen: set[int] = set()
    for page in writer.pages:
        for res in _all_resources(page):
            spaces = res.get("/ColorSpace")
            if not spaces:
                continue
            spaces = spaces.get_object()
            for key in list(spaces.keys()):
                cs = spaces[key].get_object()
                if not isinstance(cs, ArrayObject) or str(cs[0]) not in ("/Separation", "/DeviceN"):
                    continue
                names = _colorant_names(cs)
                zero = [i for i, n in enumerate(names) if n in inks]
                if not zero or id(cs) in seen:
                    continue
                seen.add(id(cs))
                fn_index = 3
                original = cs[fn_index].get_object()
                cs[fn_index] = writer._add_object(_zero_inputs_function(len(names), zero, original))
                changed.append(f"{key}:{'+'.join(names[i] for i in zero)}")
    return changed


def emphasize_inks(writer: PdfWriter, inks: set[str]) -> list[str]:
    """Make colour spaces made only of the named colorants print as black (K = tint).

    Rendered against a copy where they are suppressed, the difference is exactly where those
    separations print: used for spot-varnish masks.
    """
    changed: list[str] = []
    for page in writer.pages:
        for res in _all_resources(page):
            spaces = res.get("/ColorSpace")
            if not spaces:
                continue
            spaces = spaces.get_object()
            for key in list(spaces.keys()):
                cs = spaces[key].get_object()
                if not isinstance(cs, ArrayObject) or str(cs[0]) not in ("/Separation", "/DeviceN"):
                    continue
                names = _colorant_names(cs)
                if not names or not all(n in inks for n in names):
                    continue
                n = len(names)
                fn = DecodedStreamObject()
                # max of the inputs -> K; C = M = Y = 0
                body = (" max" * (n - 1)) + " 0 0 0 4 -1 roll"
                fn.set_data(("{ " + body + " }").encode("latin-1"))
                fn[NameObject("/FunctionType")] = NumberObject(4)
                fn[NameObject("/Domain")] = ArrayObject([FloatObject(v) for _ in range(n) for v in (0, 1)])
                fn[NameObject("/Range")] = ArrayObject([FloatObject(v) for _ in range(4) for v in (0, 1)])
                cs[3] = writer._add_object(fn)
                if str(cs[2]) != "/DeviceCMYK":
                    cs[2] = NameObject("/DeviceCMYK")
                changed.append(f"{key}:{'+'.join(names)}")
    return changed


def _all_resources(page):
    """Page resources plus those of nested Form XObjects (depth-first, each once)."""
    stack = [page.get("/Resources")]
    visited: set[int] = set()
    while stack:
        res = stack.pop()
        if res is None:
            continue
        res = res.get_object()
        if id(res) in visited:
            continue
        visited.add(id(res))
        yield res
        for xobj in (res.get("/XObject") or DictionaryObject()).get_object().values():
            xobj = xobj.get_object()
            if xobj.get("/Subtype") == "/Form" and "/Resources" in xobj:
                stack.append(xobj["/Resources"])
