"""Optional-content (layer) and page-box handling with pypdf.

Rendering never trusts a viewer's layer state: we write a temporary copy of the PDF whose default
OC configuration turns on exactly the layers we want, and whose CropBox is the region to render.
"""

from dataclasses import dataclass
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, NameObject, RectangleObject

from app.errors import NeedsReview

PT_TO_MM = 25.4 / 72


@dataclass(frozen=True)
class Box:
    """A PDF rectangle in points (PDF user space, y up)."""

    x0: float
    y0: float
    x1: float
    y1: float

    @classmethod
    def of(cls, rect) -> "Box":
        r = [float(v) for v in rect]
        return cls(min(r[0], r[2]), min(r[1], r[3]), max(r[0], r[2]), max(r[1], r[3]))

    @property
    def width_mm(self) -> float:
        return (self.x1 - self.x0) * PT_TO_MM

    @property
    def height_mm(self) -> float:
        return (self.y1 - self.y0) * PT_TO_MM

    def same_as(self, other: "Box", tol_pt: float = 0.5) -> bool:
        return all(abs(a - b) <= tol_pt for a, b in zip(self.as_tuple(), other.as_tuple()))

    def as_tuple(self) -> tuple[float, float, float, float]:
        return (self.x0, self.y0, self.x1, self.y1)


@dataclass(frozen=True)
class PdfFacts:
    creator: str
    producer: str
    page_count: int
    media_box: Box
    trim_box: Box | None
    layers: list[str]


def read_facts(path: Path) -> PdfFacts:
    reader = PdfReader(path)
    meta = reader.metadata or {}
    page = reader.pages[0]
    media = Box.of(page.mediabox)
    trim = Box.of(page["/TrimBox"]) if "/TrimBox" in page else None
    # A TrimBox that is not inside the page is left over from another document (seen on a PDFium
    # re-save whose TrimBox was several times the page): it says nothing about this page.
    if trim is not None and not (trim.x0 >= media.x0 - 1 and trim.y0 >= media.y0 - 1 and trim.x1 <= media.x1 + 1 and trim.y1 <= media.y1 + 1):
        trim = None
    return PdfFacts(
        creator=str(meta.get("/Creator", "")),
        producer=str(meta.get("/Producer", "")),
        page_count=len(reader.pages),
        media_box=media,
        trim_box=trim,
        layers=_layer_names(reader),
    )


def _layer_names(reader: PdfReader) -> list[str]:
    ocp = reader.trailer["/Root"].get("/OCProperties")
    if ocp is None:
        return []
    return [str(ocg.get_object()["/Name"]) for ocg in ocp.get_object()["/OCGs"]]


def require_layers(facts: PdfFacts, expected: list[str]) -> None:
    missing = [name for name in expected if name not in facts.layers]
    if missing:
        raise NeedsReview(
            "layer_missing",
            f"Expected layer(s) not found: {', '.join(missing)}",
            {"missing": missing, "found": facts.layers},
        )


def write_layer_copy(
    src: Path,
    dst: Path,
    layers_on: list[str] | None,
    crop: Box,
    suppress: set[str] | None = None,
    transform=None,
    strip: set[str] | None = None,
    only: set[str] | None = None,
) -> list[str]:
    """Copy `src` to `dst` with only `layers_on` visible and the CropBox set to `crop`.

    Sets /D /ON and /D /OFF explicitly and drops /AS auto-state entries, which viewers
    (and poppler) would otherwise apply on top of /ON and /OFF. `layers_on=None` (or a file
    without layers) leaves visibility alone. Colorants in `suppress` are made to contribute no
    ink (see app.pdf.inks); painting in `strip` colorants is removed, or with `only` everything
    else is (see app.pdf.paint). Returns what was changed.
    """
    from app.pdf.inks import suppress_inks
    from app.pdf.paint import filter_paint

    writer = PdfWriter(clone_from=src)
    changed = suppress_inks(writer, suppress) if suppress else []
    if transform is not None:
        changed += transform(writer)
    if strip and filter_paint(writer, strip, "strip"):
        changed.append("strip:" + "+".join(sorted(strip)))
    if only is not None and filter_paint(writer, only, "only"):
        changed.append("only:" + "+".join(sorted(only)))
    ocp = writer._root_object.get("/OCProperties")
    if ocp is not None and layers_on is not None:
        ocp = ocp.get_object()
        ocgs = [ref for ref in ocp["/OCGs"]]
        on = ArrayObject(r for r in ocgs if str(r.get_object()["/Name"]) in layers_on)
        off = ArrayObject(r for r in ocgs if str(r.get_object()["/Name"]) not in layers_on)
        d = ocp["/D"].get_object()
        d[NameObject("/BaseState")] = NameObject("/OFF")
        d[NameObject("/ON")] = on
        d[NameObject("/OFF")] = off
        for key in ("/AS", "/Configs"):
            d.pop(key, None)
            ocp.pop(key, None)

    rect = RectangleObject(crop.as_tuple())
    for page in writer.pages:
        page.cropbox = rect
        page.mediabox = rect
    dst.parent.mkdir(parents=True, exist_ok=True)
    with dst.open("wb") as fh:
        writer.write(fh)
    return changed


def output_intent_profile(path: Path) -> bytes | None:
    """The CMYK ICC profile from the PDF's OutputIntent (ArtPro+ embeds e.g. Coated FOGRA39)."""
    root = PdfReader(path).trailer["/Root"]
    for intent in root.get("/OutputIntents") or []:
        profile = intent.get_object().get("/DestOutputProfile")
        if profile is not None:
            data = profile.get_object().get_data()
            if data[16:20] == b"CMYK":
                return data
    return None
