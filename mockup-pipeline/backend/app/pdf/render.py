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


def _mupdf_render(pdf: Path, dpi: int) -> Image.Image:
    """An artwork render by MuPDF with colour management on (CMYK through the PDF's OutputIntent):
    exactly round(size * dpi) pixels like pdftoppm's exact_size, ~4x faster on heavy sheets (FGPO3970
    11.6 s -> 2.9 s), within dE 1.4-2.1 of poppler (median; edges and overprints differ a little more)."""
    import pymupdf

    pymupdf.TOOLS.set_icc(True)
    doc = pymupdf.open(pdf)
    aa = pymupdf.TOOLS.show_aa_level()
    try:
        page = doc[0]
        box = page.rect  # (the CropBox, in page space: MuPDF renders exactly that)
        w, h = max(1, round(box.width / 72 * dpi)), max(1, round(box.height / 72 * dpi))
        # Supersampled without anti-aliasing: shapes laid edge to edge are each anti-aliased on their own
        # otherwise, and the paper shows through where they meet (a pale hairline seam down FGSL4089's
        # stripes). Rendered sharp at up to 3x and scaled down, they meet whole and the edges are smooth.
        ss = max(1, min(3, int((60e6 / (w * h)) ** 0.5)))
        if ss > 1:
            pymupdf.TOOLS.set_graphics_min_line_width(1.0)  # (a hairline stays a line, not dropped pixels)
            pymupdf.TOOLS.set_aa_level(0)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(ss * w / box.width, ss * h / box.height), colorspace=pymupdf.csRGB, alpha=False)
        image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples_mv, "raw", "RGB", pix.stride)
    finally:
        pymupdf.TOOLS.set_aa_level(aa["graphics"])
        pymupdf.TOOLS.set_graphics_min_line_width(aa["graphics_min_line_width"])
        doc.close()
    return image if image.size == (w, h) else image.resize((w, h), Image.LANCZOS)


def pdftoppm_png(pdf: Path, out_png: Path, dpi: int, cmyk_icc: bytes | None, exact_size: bool = False) -> Image.Image:
    """Render page 1 of `pdf` (its CropBox) to an sRGB PNG at `dpi` and return it.

    `cmyk_icc` is the source CMYK profile (the PDF's OutputIntent). Without one poppler falls back
    to its uncalibrated CMYK conversion, which is visibly wrong, so callers should pass it.

    `exact_size`: the image is exactly round(size * dpi) pixels (an artwork render: MuPDF unless
    Settings.artwork_renderer is "poppler", see _mupdf_render). At -r alone pdftoppm rounds the
    page size up and leaves the partial last row and column as paper white, a white hairline on a
    panel whose finished edge is the page edge (panels cut from a sheet have no bleed there).
    Artwork renders use it; OCR renders keep the plain -r raster their thresholds were tuned on.

    pdftoppm writes raw PPM (pixel-identical to its PNG, without the PNG encode: FGPO7150's 300 dpi
    sheet 7.3 s -> 3.1 s); `out_png` is not written, callers use the returned image.
    """
    if exact_size and get_settings().artwork_renderer == "mupdf":
        return _mupdf_render(pdf, dpi)
    size: list[str] = []
    if exact_size:
        box = PdfReader(pdf).pages[0].cropbox
        size = ["-scale-to-x", str(max(1, round(float(box.width) / 72 * dpi))), "-scale-to-y", str(max(1, round(float(box.height) / 72 * dpi)))]
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        cmd = [get_settings().pdftoppm(), "-singlefile", "-cropbox", "-r", str(dpi), *size, "-aa", "yes", "-aaVector", "yes"]
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
        image = Image.open(stem.with_suffix(".ppm"))
        image.load()
    return image if image.mode == "RGB" else image.convert("RGB")
