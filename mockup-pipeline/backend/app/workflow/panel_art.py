"""Panel artwork the operator changes on the job page after the mockup exists (the Pacdora-style
editing): an uploaded image or PDF page fitted to a panel, colour correction, and overlays (logos,
text) drawn on top. Pure image functions; the texture step supplies the images and sizes and stores
the results, so the renders, the GLB and the viewer all show the same baked texture.

Positions are in millimetres from the finished panel's top-left corner (as the keyline preview shows
it); the pixel scale comes from the panel image itself (px / panel width mm).
"""

import io
import math
from functools import lru_cache
from pathlib import Path
from typing import Callable

import pymupdf
from PIL import Image, ImageDraw, ImageEnhance, ImageFont, ImageOps

from app.workflow.adjust import Overlay, PanelAdjust

IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
MAX_SIDE = 6000  # px on the long side of a panel drawn from an upload (300 dpi covers a 500 mm panel)
PREVIEW_SIDE = 2048  # px of the job page's preview of an upload

# Font files by family, tried in order (Pillow looks in the system's font folders by name); Pillow's
# bundled sans serif is the last resort, so text always renders.
FONT_FILES = {
    ("sans", False): ["arial.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf", "FreeSans.ttf", "NotoSans-Regular.ttf"],
    ("sans", True): ["arialbd.ttf", "DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf", "FreeSansBold.ttf", "NotoSans-Bold.ttf"],
    ("serif", False): ["times.ttf", "DejaVuSerif.ttf", "LiberationSerif-Regular.ttf", "FreeSerif.ttf", "NotoSerif-Regular.ttf"],
    ("serif", True): ["timesbd.ttf", "DejaVuSerif-Bold.ttf", "LiberationSerif-Bold.ttf", "FreeSerifBold.ttf", "NotoSerif-Bold.ttf"],
    ("mono", False): ["cour.ttf", "DejaVuSansMono.ttf", "LiberationMono-Regular.ttf", "FreeMono.ttf", "NotoSansMono-Regular.ttf"],
    ("mono", True): ["courbd.ttf", "DejaVuSansMono-Bold.ttf", "LiberationMono-Bold.ttf", "FreeMonoBold.ttf", "NotoSansMono-Bold.ttf"],
}


def kind_of(filename: str, data: bytes | None = None) -> str | None:
    """'image' (PNG / JPEG / WebP), 'pdf' or None: by content when `data` is given, else by name."""
    if data is not None:
        if data.startswith(b"%PDF-"):
            return "pdf"
        if data.startswith(b"\x89PNG") or data.startswith(b"\xff\xd8") or (data[:4] == b"RIFF" and data[8:12] == b"WEBP"):
            return "image"
        return None
    ext = Path(filename).suffix.lower()
    return "pdf" if ext == ".pdf" else "image" if ext in IMAGE_TYPES else None


def media_type(filename: str) -> str:
    return IMAGE_TYPES.get(Path(filename).suffix.lower(), "application/pdf" if filename.lower().endswith(".pdf") else "application/octet-stream")


def open_upload(data: bytes, dpi: float = 300, max_side: int = MAX_SIDE) -> Image.Image:
    """An uploaded image as RGBA (camera orientation applied), or page 1 of a PDF (its CropBox)
    rendered at `dpi`, lower when the long side would pass `max_side` px."""
    if data.startswith(b"%PDF-"):
        doc = pymupdf.open(stream=data, filetype="pdf")
        try:
            page = doc[0]
            long_pt = max(page.rect.width, page.rect.height) or 1
            zoom = min(dpi, max_side * 72 / long_pt) / 72
            pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csRGB, alpha=False)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        finally:
            doc.close()
        return img.convert("RGBA")
    img = Image.open(io.BytesIO(data))
    img.load()
    img = ImageOps.exif_transpose(img) or img
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.LANCZOS)
    return img.convert("RGBA")


def pixel_size(size_mm: tuple[float, float], dpi: float, max_side: int = MAX_SIDE) -> tuple[int, int]:
    """Pixels of a panel drawn at `dpi` (scaled down together when the long side passes `max_side`)."""
    w, h = size_mm
    k = dpi / 25.4
    if max(w, h) * k > max_side:
        k = max_side / max(w, h)
    return max(1, round(w * k)), max(1, round(h * k))


def fit_image(src: Image.Image, size: tuple[int, int], fit: str = "cover", background: str | None = None) -> Image.Image:
    """`src` on a `size` px panel, centred: cover fills the panel and crops the overflow, contain
    shows all of it over `background` (white when None), stretch distorts it to the panel. RGB."""
    w, h = size
    canvas = Image.new("RGB", (w, h), background or "#ffffff")
    src = src.convert("RGBA")
    if fit == "stretch":
        scaled = src.resize((w, h), Image.LANCZOS)
    else:
        k = (max if fit == "cover" else min)(w / src.width, h / src.height)
        scaled = src.resize((max(1, round(src.width * k)), max(1, round(src.height * k))), Image.LANCZOS)
    canvas.paste(scaled, ((w - scaled.width) // 2, (h - scaled.height) // 2), scaled)
    return canvas


def blank(colour: str, size_mm: tuple[float, float], dpi: float) -> Image.Image:
    """A plain panel at real size (so overlays can be drawn on it)."""
    return Image.new("RGB", pixel_size(size_mm, dpi), colour)


def correct_colours(img: Image.Image, brightness: float = 0, contrast: float = 0, saturation: float = 0) -> Image.Image:
    """Each -100..100: 0 leaves the print as it is, +100 doubles the effect, -100 removes it (the
    same factors as the job page's CSS preview: brightness() / contrast() / saturate())."""
    out = img.convert("RGB")
    for value, enhancer in ((brightness, ImageEnhance.Brightness), (contrast, ImageEnhance.Contrast), (saturation, ImageEnhance.Color)):
        if value:
            out = enhancer(out).enhance(max(0.0, 1 + value / 100))
    return out


@lru_cache(maxsize=None)
def font_file(family: str, bold: bool) -> str | None:
    """The first font file of the family Pillow can open (None: use its bundled font)."""
    for name in FONT_FILES.get((family, bold), []) + ([] if not bold else FONT_FILES.get((family, False), [])):
        try:
            ImageFont.truetype(name, 12)
            return name
        except OSError:
            continue
    return None


def font(family: str, bold: bool, px: float) -> ImageFont.FreeTypeFont:
    size = max(1, int(round(px)))
    name = font_file(family, bold)
    if name:
        return ImageFont.truetype(name, size)
    return ImageFont.load_default(size=size)  # type: ignore[return-value]


def _text_layer(ov: Overlay, ppm: float) -> Image.Image | None:
    text = ov.text.strip("\n")
    if not text.strip():
        return None
    f = font(ov.font, ov.bold, ov.size_mm * ppm)
    spacing = round(0.2 * ov.size_mm * ppm)
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    x0, y0, x1, y1 = probe.multiline_textbbox((0, 0), text, font=f, align=ov.align, spacing=spacing)
    pad = round(0.2 * ov.size_mm * ppm) if ov.background else 0
    w, h = max(1, math.ceil(x1 - x0) + 2 * pad), max(1, math.ceil(y1 - y0) + 2 * pad)
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    if ov.background:
        draw.rectangle((0, 0, w - 1, h - 1), fill=ov.background)
    draw.multiline_text((pad - x0, pad - y0), text, font=f, fill=ov.color, align=ov.align, spacing=spacing)
    return layer


def _image_layer(ov: Overlay, ppm: float, load_image: Callable[[int], Image.Image | None]) -> Image.Image | None:
    if ov.file_id is None:
        return None
    src = load_image(ov.file_id)
    if src is None:
        return None
    src = src.convert("RGBA")
    w = max(1, round(ov.width_mm * ppm))
    h = max(1, round(ov.height_mm * ppm)) if ov.height_mm else max(1, round(w * src.height / src.width))
    return src.resize((w, h), Image.LANCZOS)


def draw_overlays(img: Image.Image, overlays: list[Overlay], ppm: float, load_image: Callable[[int], Image.Image | None]) -> Image.Image:
    """`overlays` drawn on a copy of `img` (RGB), each centred at (x_mm, y_mm), turned and faded as set.
    Anything outside the panel is cut off, as it would be at the dieline."""
    out = img.convert("RGB")
    for ov in overlays:
        layer = _text_layer(ov, ppm) if ov.kind == "text" else _image_layer(ov, ppm, load_image)
        if layer is None:
            continue
        if ov.rotation % 360:
            layer = layer.rotate(ov.rotation, expand=True, resample=Image.BICUBIC)
        if ov.opacity < 1:
            layer.putalpha(layer.getchannel("A").point(lambda v: int(v * ov.opacity)))
        cx, cy = round(ov.x_mm * ppm), round(ov.y_mm * ppm)
        out.paste(layer, (cx - layer.width // 2, cy - layer.height // 2), layer)
    return out


def compose(img: Image.Image, adj: PanelAdjust, width_mm: float, load_image: Callable[[int], Image.Image | None]) -> Image.Image:
    """The panel image with the adjustment's colour correction and overlays (unchanged when it has none)."""
    if not adj.bakes():
        return img
    out = correct_colours(img, adj.brightness, adj.contrast, adj.saturation)
    if adj.overlays:
        out = draw_overlays(out, adj.overlays, out.width / width_mm, load_image)
    return out


def preview_png(data: bytes, side: int = PREVIEW_SIDE) -> bytes:
    """A PNG no larger than `side` px of an upload (image or PDF page) for the job page's live preview."""
    img = open_upload(data, dpi=150, max_side=side)
    if max(img.size) > side:
        img.thumbnail((side, side), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=1)
    return buf.getvalue()
