"""Safety check of finished artwork for technical (keyline) marks (spec 2.1 e).

A designer can put a dimension line or note on the Artwork layer by mistake. Two checks:
- separation: marks painted with the technical ink itself (exact; found by rendering the artwork
  with and without that ink);
- colour: pixels within a small CIE76 distance of the keyline colour (catches marks redrawn in
  process colours).
Flagged pixels are masked (filled from their surroundings) and a highlighted preview is made.
"""

import io
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms, ImageFilter
from pypdf import PdfReader

from app.pdf.layers import Box, output_intent_profile, write_layer_copy
from app.pdf.profile import TechnicalColourCheck
from app.pdf.render import pdftoppm_png

_SRGB = ImageCms.createProfile("sRGB")
_LAB = ImageCms.createProfile("LAB")
_TO_LAB = ImageCms.buildTransform(_SRGB, _LAB, "RGB", "LAB")
_FROM_LAB = ImageCms.buildTransform(_LAB, _SRGB, "LAB", "RGB")


def technical_rgb(pdf: Path, technical_inks: list[str], check: TechnicalColourCheck) -> tuple[int, int, int]:
    """sRGB of the keyline colour: configured hex, or the technical ink's alternate colour at full tint
    (CMYK through the OutputIntent; RGB and Lab alternates directly)."""
    if check.colour != "auto":
        return _hex(check.colour)
    alt = _technical_alternate(pdf, technical_inks)
    if alt is None:
        return _hex(check.fallback_colour)
    space, values = alt
    if space == "rgb" and len(values) == 3:
        return tuple(round(min(1.0, max(0.0, v)) * 255) for v in values)  # type: ignore[return-value]
    if space == "lab" and len(values) == 3:
        L, a, b = values
        pixel = Image.new("LAB", (1, 1), (round(L * 255 / 100), round(a) + 128, round(b) + 128))
        return ImageCms.applyTransform(pixel, _FROM_LAB).getpixel((0, 0))
    icc = output_intent_profile(pdf)
    if space != "cmyk" or icc is None or len(values) != 4:
        return _hex(check.fallback_colour)
    pixel = Image.new("CMYK", (1, 1), tuple(round(v * 255) for v in values))
    rgb = ImageCms.profileToProfile(pixel, ImageCms.ImageCmsProfile(io.BytesIO(icc)), _SRGB, outputMode="RGB")
    return rgb.getpixel((0, 0))


def _alternate_space(alt) -> str | None:
    alt = alt.get_object() if hasattr(alt, "get_object") else alt
    name = str(alt[0]) if isinstance(alt, list) else str(alt)
    if name in ("/DeviceCMYK",):
        return "cmyk"
    if name in ("/DeviceRGB", "/CalRGB"):
        return "rgb"
    if name == "/Lab":
        return "lab"
    if name == "/ICCBased":
        n = int(alt[1].get_object().get("/N", 0))
        return {3: "rgb", 4: "cmyk"}.get(n)
    return None


def _technical_alternate(pdf: Path, inks: list[str]) -> tuple[str, list[float]] | None:
    res = PdfReader(pdf).pages[0].get("/Resources")
    spaces = res.get_object().get("/ColorSpace") if res else None
    for cs in (spaces or {}).values():
        cs = cs.get_object()
        if not isinstance(cs, list) or str(cs[0]) not in ("/Separation", "/DeviceN"):
            continue
        names = [str(cs[1])[1:]] if str(cs[0]) == "/Separation" else [str(n)[1:] for n in cs[1].get_object()]
        fn = cs[3].get_object()
        space = _alternate_space(cs[2])
        if names and all(n in inks for n in names) and fn.get("/FunctionType") == 2 and space:
            return space, [float(v) for v in fn.get("/C1", [])]
    return None


def _hex(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def colour_mask(image: Image.Image, rgb: tuple[int, int, int], max_delta_e: float) -> np.ndarray:
    lab = np.asarray(ImageCms.applyTransform(image.convert("RGB"), _TO_LAB)).astype(np.float32)
    ref = np.asarray(ImageCms.applyTransform(Image.new("RGB", (1, 1), rgb), _TO_LAB)).astype(np.float32)[0, 0]
    # Pillow's 8-bit LAB: L 0-255 -> 0-100, a/b offset by 128.
    scale = np.array([100 / 255, 1, 1], dtype=np.float32)
    diff = (lab - ref) * scale
    return np.sqrt((diff**2).sum(axis=2)) <= max_delta_e


def separation_mask(pdf: Path, layers: list[str], crop: Box, technical_inks: set[str], dpi: int) -> Image.Image | None:
    """Full-bleed mask ("L", 255 = mark) of what the technical ink paints on `layers`, or None.

    Rendered at a low dpi: it only has to locate marks; the caller scales it to the texture.
    """
    icc = output_intent_profile(pdf)
    with tempfile.TemporaryDirectory() as tmp:
        t = Path(tmp)
        write_layer_copy(pdf, t / "with.pdf", layers, crop)
        changed = write_layer_copy(pdf, t / "without.pdf", layers, crop, suppress=technical_inks)
        if not changed:
            return None  # the technical ink is not used on these layers at all
        a = np.asarray(pdftoppm_png(t / "with.pdf", t / "a.png", dpi, icc)).astype(np.int16)
        b = np.asarray(pdftoppm_png(t / "without.pdf", t / "b.png", dpi, icc)).astype(np.int16)
    return Image.fromarray((np.abs(a - b).max(axis=2) > 8).astype(np.uint8) * 255)


def _box_sum(mask: np.ndarray, k: int) -> np.ndarray:
    """Count of set pixels in the k x k window around each pixel (k odd), by an integral image."""
    r = k // 2
    c = np.pad(mask.astype(np.int32), ((r + 1, r), (r + 1, r))).cumsum(0).cumsum(1)
    return c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]


def erode(mask: np.ndarray, k: int) -> np.ndarray:
    """Pixels whose whole k x k neighbourhood is set (PIL's rank filters take seconds on a 300 dpi sheet)."""
    return _box_sum(mask, k) == k * k


def dilate(mask: np.ndarray, k: int) -> np.ndarray:
    return _box_sum(mask, k) > 0


def thin_parts(mask: np.ndarray, k: int) -> np.ndarray:
    """`mask` without its parts at least k pixels thick: hairlines and small glyphs stay."""
    return mask & ~dilate(erode(mask, k), k + 2)


def mask_out(image: Image.Image, mask: np.ndarray, radius: int = 6) -> Image.Image:
    """Fill masked pixels from their unmasked neighbourhood (normalised blur). A mark too wide for
    the blur to reach its middle (a zipper track's dashes, FGPO3970) is filled from further out; what
    even that cannot reach is left as it is. Only the marks' bounding box (plus the blur's reach) is
    worked on: annotation callouts are a corner of a 10 Mpx sheet."""
    ys, xs = np.nonzero(mask)
    if not len(ys):
        return image
    reach = 3 * radius * 9 + 3  # (3 sigma of the widest blur)
    y0, y1 = max(0, ys.min() - reach), min(mask.shape[0], ys.max() + reach + 1)
    x0, x1 = max(0, xs.min() - reach), min(mask.shape[1], xs.max() + reach + 1)
    if (y1 - y0) * (x1 - x0) < 0.8 * mask.size:
        out = image.convert("RGB").copy()
        out.paste(_mask_out(image.crop((x0, y0, x1, y1)), mask[y0:y1, x0:x1], radius), (x0, y0))
        return out
    return _mask_out(image, mask, radius)


def _mask_out(image: Image.Image, mask: np.ndarray, radius: int) -> Image.Image:
    grow = Image.fromarray(dilate(mask, 5).astype(np.uint8) * 255)
    keep = 255 - np.asarray(grow).astype(np.float32)
    rgb = np.asarray(image.convert("RGB")).astype(np.float32)
    out, todo = rgb.copy(), np.asarray(grow) > 0
    for r in (radius, radius * 3, radius * 9):
        if not todo.any():
            break
        w = np.asarray(Image.fromarray(keep.astype(np.uint8)).filter(ImageFilter.GaussianBlur(r))).astype(np.float32)
        blurred = [
            np.asarray(Image.fromarray((rgb[..., c] * keep / 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r))).astype(np.float32)
            for c in range(3)
        ]
        fill = np.stack([b * 255 / np.maximum(w, 1) for b in blurred], axis=2)
        ok = todo & (w >= 32)  # enough unmasked neighbours for a true colour (8-bit blur)
        out[ok] = np.clip(fill, 0, 255)[ok]
        todo = todo & ~ok
    return Image.fromarray(out.astype(np.uint8))


def highlight(image: Image.Image, mask: np.ndarray) -> Image.Image:
    """Preview for the review page: flagged pixels in magenta over a dimmed texture."""
    base = np.asarray(image.convert("RGB")).astype(np.float32) * 0.45 + 140
    grow = np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(9))) > 0
    base[grow] = (255, 0, 200)
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))
