"""Rasterise a prepared PDF with poppler's pdftoppm, colour-managed CMYK -> sRGB."""

import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageCms
from pypdf import PdfReader

from app.config import get_settings

Image.MAX_IMAGE_PIXELS = 400_000_000  # 1 m pouch at 600 dpi still fits


_SRGB_ICC_BYTES: bytes | None = None

def _srgb_profile_file(directory: Path) -> Path:
    global _SRGB_ICC_BYTES
    if _SRGB_ICC_BYTES is None:
        _SRGB_ICC_BYTES = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    path = directory / "sRGB.icc"
    if not path.exists():
        path.write_bytes(_SRGB_ICC_BYTES)
    return path


def pdftoppm_png(pdf: Path, out_png: Path, dpi: int, cmyk_icc: bytes | None, exact_size: bool = False) -> Image.Image:
    """Render page 1 of `pdf` (its CropBox) to an sRGB PNG at `dpi` and return it.

    `cmyk_icc` is the source CMYK profile (the PDF's OutputIntent). Without one poppler falls back
    to its uncalibrated CMYK conversion, which is visibly wrong, so callers should pass it.

    `exact_size`: the image is exactly round(size * dpi) pixels. At -r alone pdftoppm rounds the
    page size up and leaves the partial last row and column as paper white, a white hairline on a
    panel whose finished edge is the page edge (panels cut from a sheet have no bleed there).
    Artwork renders use it; OCR renders keep the plain -r raster their thresholds were tuned on.
    """
    out_png.parent.mkdir(parents=True, exist_ok=True)
    size: list[str] = []
    if exact_size:
        box = PdfReader(pdf).pages[0].cropbox
        size = ["-scale-to-x", str(max(1, round(float(box.width) / 72 * dpi))), "-scale-to-y", str(max(1, round(float(box.height) / 72 * dpi)))]
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        cmd = [get_settings().pdftoppm(), "-png", "-singlefile", "-cropbox", "-r", str(dpi), *size, "-aa", "yes", "-aaVector", "yes"]
        cmd += ["-displayprofile", str(_srgb_profile_file(tmp_dir))]
        if cmyk_icc:
            cmyk_path = tmp_dir / "source_cmyk.icc"
            cmyk_path.write_bytes(cmyk_icc)
            cmd += ["-defaultcmykprofile", str(cmyk_path)]
        stem = tmp_dir / "page"
        cmd += [str(pdf), str(stem)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if proc.returncode != 0:
            raise RuntimeError(f"pdftoppm failed ({proc.returncode}): {proc.stderr.strip()}")
        image = Image.open(stem.with_suffix(".png"))
        image.load()
    if image.mode != "RGB":
        image = image.convert("RGB")
    image.save(out_png, optimize=False, compress_level=1)
    return image
