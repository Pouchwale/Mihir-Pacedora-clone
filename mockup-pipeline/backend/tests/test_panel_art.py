"""Job-page artwork editing baked into panel textures: fitting an upload, colour correction, overlays."""

import io

import pymupdf
import pytest
from PIL import Image

from app.workflow import panel_art
from app.workflow.adjust import Overlay, PanelAdjust


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _two_tone(w=200, h=100) -> Image.Image:
    """Left half red, right half blue."""
    img = Image.new("RGB", (w, h), "#ff0000")
    img.paste("#0000ff", (w // 2, 0, w, h))
    return img


def test_kind_of_by_content_and_name():
    assert panel_art.kind_of("x.png", _png(Image.new("RGB", (2, 2)))) == "image"
    assert panel_art.kind_of("x.bin", b"%PDF-1.4 ...") == "pdf"
    assert panel_art.kind_of("x.png", b"not an image") is None
    assert (panel_art.kind_of("a.JPG"), panel_art.kind_of("a.webp"), panel_art.kind_of("a.pdf"), panel_art.kind_of("a.txt")) == ("image", "image", "pdf", None)


def test_open_upload_image_and_pdf_page():
    img = panel_art.open_upload(_png(_two_tone()))
    assert img.mode == "RGBA" and img.size == (200, 100)
    doc = pymupdf.open()
    page = doc.new_page(width=72 * 4, height=72 * 2)  # 4 x 2 inch
    page.draw_rect(pymupdf.Rect(0, 0, 144, 144), color=None, fill=(0, 0.5, 0))
    pdf = doc.tobytes()
    rendered = panel_art.open_upload(pdf, dpi=100)
    assert rendered.size == (400, 200)
    assert rendered.getpixel((50, 50))[:3] in ((0, 127, 0), (0, 128, 0)) and rendered.getpixel((350, 50))[:3] == (255, 255, 255)
    capped = panel_art.open_upload(pdf, dpi=300, max_side=600)  # the long side never passes max_side
    assert max(capped.size) == 600


def test_pixel_size_follows_dpi_and_the_cap():
    assert panel_art.pixel_size((240, 312), 300) == (2835, 3685)
    w, h = panel_art.pixel_size((1000, 500), 300)
    assert (w, h) == (6000, 3000)


@pytest.mark.parametrize("fit, corner, centre_left, centre_right", [
    # a 200 x 100 two-tone picture on a 100 x 100 panel
    ("cover", None, "#ff0000", "#0000ff"),      # scaled to 200 x 100, cropped to the middle: red | blue
    ("contain", "#00ff00", "#ff0000", "#0000ff"),  # 100 x 50 in the middle over the background
    ("stretch", None, "#ff0000", "#0000ff"),    # squeezed to 100 x 100
])
def test_fit_modes(fit, corner, centre_left, centre_right):
    out = panel_art.fit_image(_two_tone(), (100, 100), fit, "#00ff00")
    assert out.size == (100, 100)
    hexed = lambda p: "#%02x%02x%02x" % out.getpixel(p)  # noqa: E731
    assert hexed((25, 50)) == centre_left and hexed((75, 50)) == centre_right
    if corner:
        assert hexed((2, 2)) == corner  # background shows around a contained picture
    else:
        assert hexed((2, 2)) in ("#ff0000",)


def test_colour_correction_factors():
    grey = Image.new("RGB", (4, 4), (100, 100, 100))
    assert panel_art.correct_colours(grey, brightness=50).getpixel((0, 0)) == (150, 150, 150)
    assert panel_art.correct_colours(grey).getpixel((0, 0)) == (100, 100, 100)
    red = Image.new("RGB", (4, 4), (200, 50, 50))
    assert panel_art.correct_colours(red, saturation=-100).getpixel((0, 0))[0] == panel_art.correct_colours(red, saturation=-100).getpixel((0, 0))[2]


def test_image_overlay_is_placed_in_mm_and_clipped():
    panel = Image.new("RGB", (400, 200), "#ffffff")  # 100 x 50 mm at 4 px/mm
    logo = Image.new("RGBA", (40, 20), "#0000ff")
    ov = Overlay(kind="image", file_id=7, x_mm=50, y_mm=25, width_mm=20)  # 20 x 10 mm centred
    out = panel_art.draw_overlays(panel, [ov], 4.0, lambda fid: logo if fid == 7 else None)
    assert out.getpixel((200, 100)) == (0, 0, 255) and out.getpixel((200 - 39, 100)) == (0, 0, 255)
    assert out.getpixel((200 - 41, 100)) == (255, 255, 255) and out.getpixel((200, 100 - 21)) == (255, 255, 255)
    # half outside the panel: only the inside part is drawn, nothing fails
    edge = Overlay(kind="image", file_id=7, x_mm=0, y_mm=0, width_mm=20)
    out = panel_art.draw_overlays(panel, [edge], 4.0, lambda fid: logo)
    assert out.getpixel((10, 10)) == (0, 0, 255) and out.getpixel((60, 10)) == (255, 255, 255)
    # missing file: skipped
    assert panel_art.draw_overlays(panel, [ov], 4.0, lambda fid: None).getpixel((200, 100)) == (255, 255, 255)


def test_image_overlay_opacity_and_rotation():
    panel = Image.new("RGB", (400, 200), "#ffffff")
    logo = Image.new("RGBA", (40, 40), "#000000")
    faded = panel_art.draw_overlays(panel, [Overlay(kind="image", file_id=1, x_mm=50, y_mm=25, width_mm=10, opacity=0.5)], 4.0, lambda _f: logo)
    assert 120 <= faded.getpixel((200, 100))[0] <= 136
    turned = panel_art.draw_overlays(panel, [Overlay(kind="image", file_id=1, x_mm=50, y_mm=25, width_mm=10, height_mm=2, rotation=90)], 4.0, lambda _f: logo)
    assert turned.getpixel((200, 100 + 15)) == (0, 0, 0) and turned.getpixel((200 + 15, 100)) == (255, 255, 255)  # a 40 x 8 px bar now stands upright


def test_text_overlay_draws_in_its_colour_and_size():
    panel = Image.new("RGB", (400, 200), "#ffffff")
    ov = Overlay(kind="text", text="POUCH", x_mm=50, y_mm=25, size_mm=10, color="#ff0000", bold=True)
    out = panel_art.draw_overlays(panel, [ov], 4.0, lambda _f: None)
    reds = [(x, y) for x in range(400) for y in range(200) if out.getpixel((x, y))[1] < 100]
    assert reds, "text was drawn"
    xs, ys = [p[0] for p in reds], [p[1] for p in reds]
    assert 100 < min(xs) < 150 and 250 < max(xs) < 300 and 75 < min(ys) < 90 and 110 < max(ys) < 125  # centred at (200, 100), capitals about 7 mm tall
    boxed = panel_art.draw_overlays(panel, [Overlay(kind="text", text="A\nB", x_mm=50, y_mm=25, size_mm=6, color="#ffffff", background="#000000")], 4.0, lambda _f: None)
    assert boxed.getpixel((200, 100)) in ((0, 0, 0), (255, 255, 255))
    assert panel_art.draw_overlays(panel, [Overlay(kind="text", text="   ")], 4.0, lambda _f: None).getpixel((200, 100)) == (255, 255, 255)


def test_fonts_resolve_for_every_family():
    for family in ("sans", "serif", "mono"):
        for bold in (False, True):
            f = panel_art.font(family, bold, 24)
            assert f.getbbox("Ag")[3] > 10


def test_compose_applies_only_when_something_is_set():
    img = Image.new("RGB", (100, 50), (100, 100, 100))
    assert panel_art.compose(img, PanelAdjust(), 100, lambda _f: None) is img
    out = panel_art.compose(img, PanelAdjust(brightness=50, overlays=[Overlay(kind="text", text="x", x_mm=50, y_mm=25, size_mm=5, color="#000000")]), 100, lambda _f: None)
    assert out.getpixel((2, 2)) == (150, 150, 150)


def test_preview_png_is_bounded():
    data = _png(Image.new("RGB", (3000, 1000), "#123456"))
    prev = Image.open(io.BytesIO(panel_art.preview_png(data, side=512)))
    assert max(prev.size) == 512
