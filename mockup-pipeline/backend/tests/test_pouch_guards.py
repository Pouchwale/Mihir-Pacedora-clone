"""Guards against pouch mockups going wrong in ways seen on real jobs."""
import io
import types

from PIL import Image, ImageDraw

from app.steps.trim_artwork import TrimArtworkOutput
from app.workflow.steps import link_panels as lp


class _Store:
    def __init__(self, files: dict[str, bytes]):
        self.files = files

    def get_bytes(self, key: str) -> bytes:
        return self.files[key]

    def put_bytes(self, key: str, data: bytes, content_type: str) -> str:
        self.files[key] = data
        return key


def test_approval_sheet_page_gives_its_artwork_not_the_sheet():
    """FGPO5635: no dieline, so the whole 600 x 300 mm sheet (spec table, ink dots, keyline drawing and
    a grey white-separation preview beside the artwork) was wrapped round the pouch."""
    k = 4  # px per mm
    page = Image.new("RGB", (600 * k, 300 * k), "white")
    d = ImageDraw.Draw(page)
    for y in range(20, 280, 12):  # the spec table: thin lines and text on white
        d.line([(10 * k, y * k), (200 * k, y * k)], fill="black", width=2)
    for i, c in enumerate(["black", "yellow", "magenta", "cyan"]):  # ink dots
        d.ellipse([(20 + 14 * i) * k, 240 * k, (30 + 14 * i) * k, 252 * k], fill=c)
    d.rectangle([300 * k, 80 * k, 385 * k, 218 * k], fill=(30, 120, 40))  # the artwork, 85 x 138 mm
    d.rectangle([470 * k, 80 * k, 555 * k, 218 * k], fill=(200, 200, 200))  # white-separation preview (grey)
    buf = io.BytesIO()
    page.save(buf, "PNG")
    store = _Store({"jobs/1/sheet_bleed.png": buf.getvalue()})
    pt = 72 / 25.4
    trim = TrimArtworkOutput(item_code="FGPO0001", panel="front", sha256="x", creator="", producer="", layers=[], layers_rendered=[],
                             trim_box_pt=(0.0, 0.0, 600 * pt, 300 * pt), trim_width_mm=600.0, trim_height_mm=300.0, dpi=100,
                             bleed_key="jobs/1/sheet_bleed.png", bleed_px=page.size, colour_profile="none", suppressed_colour_spaces=[],
                             mode="page", technical_box_pt=None, repeats=1, warnings=[])
    ctx = types.SimpleNamespace(storage=store, log=lambda *a, **k: None)
    cut = lp._art_block(ctx, trim, (85.0, 138.0))
    assert cut is not None
    assert abs(cut.trim_width_mm - 85) <= 4 and abs(cut.trim_height_mm - 138) <= 4
    x0 = cut.trim_box_pt[0] / pt
    assert 296 <= x0 <= 304  # the green artwork, not the table or the grey preview
