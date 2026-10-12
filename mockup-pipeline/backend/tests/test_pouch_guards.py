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


def _lathe_glb(profile, z_up: bool) -> bytes:
    """A turned shape as a GLB: `profile` is [(radius, height), ...] bottom to top; few rings, tall faces."""
    import json
    import math
    import struct

    import numpy as np

    seg, pos, idx = 48, [], []
    for r, h in profile:
        for j in range(seg):
            a = 2 * math.pi * j / seg
            pos.append((r * math.cos(a), r * math.sin(a), h) if z_up else (r * math.cos(a), h, r * math.sin(a)))
    for i in range(len(profile) - 1):
        for j in range(seg):
            a, b = i * seg + j, i * seg + (j + 1) % seg
            idx += [a, a + seg, b, b, a + seg, b + seg]
    p, ix = np.array(pos, np.float32), np.array(idx, np.uint32)
    binary = p.tobytes() + ix.tobytes()
    g = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
         "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}], "buffers": [{"byteLength": len(binary)}],
         "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": p.nbytes}, {"buffer": 0, "byteOffset": p.nbytes, "byteLength": ix.nbytes}],
         "accessors": [{"bufferView": 0, "componentType": 5126, "count": len(p), "type": "VEC3"},
                       {"bufferView": 1, "componentType": 5125, "count": len(ix), "type": "SCALAR"}]}
    j = json.dumps(g).encode()
    j += b" " * (-len(j) % 4)
    return (struct.pack("<4sII", b"glTF", 2, 28 + len(j) + len(binary)) + struct.pack("<I4s", len(j), b"JSON") + j
            + struct.pack("<I4s", len(binary), b"BIN\0") + binary)


def test_container_model_is_measured_upright_with_its_lid():
    """An uploaded container model: stood up whichever way it was exported, its height for its girth, and the
    lid found (the sleeve stops there); a waisted bottle's middle is no lid."""
    from app.geometry.glb_shape import measure

    # a jar 2 wide and 2.5 tall, body to 1.8, a neck of radius 0.7 at 1.9, a wider lid 0.8 up to 2.5 (Z-up export)
    jar = [(0.9, 0), (1, 0.1), (1, 1.6), (0.85, 1.8), (0.7, 1.9), (0.8, 1.95), (0.8, 2.5)]
    aspect, top, up = measure(_lathe_glb(jar, z_up=True))
    assert up == 2 and abs(aspect - 1.25) < 0.05 and 0.72 <= top <= 0.8
    # a waisted bottle (Y-up): narrowest in the middle, no lid
    waist = [(1, 0), (1, 0.4), (0.7, 1.5), (1, 2.6), (1, 3.0), (0.4, 3.4), (0.4, 4)]
    _, top, up = measure(_lathe_glb(waist, z_up=False))
    assert up == 1 and top == 1.0


def test_model_container_grows_its_body_to_fit_the_sleeve():
    """A model a little squatter than the real jar: its body grows to fit the sleeve (the cap keeps its size),
    instead of the sleeve's top being cut off; the team's own height and place are kept."""
    from app.geometry import sleeve as S
    from app.index.schemas import Container

    c = {"m": Container(name="m", shape="bottle", sleeve_from=0.0, model="containers/" + "0" * 64 + ".glb")}
    measured = lambda key: (0.95, 0.68, 2)  # noqa: E731 - height / width, lid at 68 %, Z-up
    s = S.build(c, "m", "", 290.0, 60.32, 139.0, measure_model=measured)
    natural = s.diameter_mm * 0.95
    cap = 0.32 * natural
    assert abs(s.container_height_mm - (cap + 60.32)) < 0.05 and abs(s.model_top * s.container_height_mm - 60.32) < 0.05
    s = S.build(c, "m", "", 290.0, 60.32, 139.0, style={"height_mm": 110, "sleeve_from": 0.1}, measure_model=measured)
    assert s.container_height_mm == 110 and abs(s.sleeve_from - 0.1) < 1e-3 and abs((1 - s.model_top) * 110 - cap) < 0.05
