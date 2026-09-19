"""Stage 3: artwork texture from the TrimBox, without technical marks, bleed trimmed off.

Technical marks (dimension guides, zipper marking, eyemarks, V-notch marks) are removed by
  1. switching off the technical PDF layers (ArtPro+ exports have them): the real artwork under the
     marks is rendered untouched; or, when the file has no layers,
  2. disabling the technical spot ink to find exactly which pixels the marks cover, then filling
     those thin lines from their surroundings.
"""
from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field

import cv2
import numpy as np
import pymupdf

from .config import ARTWORK_DPI, TECHNICAL_INK_HINTS, TECHNICAL_LAYER_HINTS
from .pdfio import has_real_trimbox, open_page, page_geometry, spot_inks

MM_PER_INCH = 25.4


@dataclass
class ArtworkResult:
    method: str                      # "layers" | "spot-ink-mask" | "none"
    layers_off: list[str] = field(default_factory=list)
    inks_masked: list[str] = field(default_factory=list)
    masked_pixel_pct: float = 0.0
    trim_mm: tuple[float, float] = (0, 0)
    texture_mm: tuple[float, float] = (0, 0)
    bleed_mm: tuple[float, float] = (0, 0)   # removed per side (horizontal, vertical)
    dpi: int = ARTWORK_DPI
    full_png: str = ""               # TrimBox incl. bleed
    texture_png: str = ""            # finished pouch size
    average_rgb: tuple[int, int, int] = (0, 0, 0)
    warnings: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return asdict(self)


def _is_technical(name: str, hints) -> bool:
    n = name.lower()
    return any(h in n for h in hints)


def _pixmap_to_rgb(pix) -> np.ndarray:
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)[:, :, :3].copy()


def _render_without_inks(page, clip, dpi, ink_names: list[str]) -> np.ndarray:
    m = pymupdf.mupdf
    seps = m.fz_page_separations(page.this)
    for i in range(m.fz_count_separations(seps)):
        if m.fz_separation_name(seps, i) in ink_names:
            m.fz_set_separation_behavior(seps, i, m.FZ_SEPARATION_DISABLED)
    zoom = dpi / 72
    pix = m.fz_new_pixmap_from_page_with_separations(page.this, m.FzMatrix(zoom, 0, 0, zoom, 0, 0), m.FzColorspace(m.FzColorspace.Fixed_RGB), seps, 0)
    w, h, n = m.fz_pixmap_width(pix), m.fz_pixmap_height(pix), m.fz_pixmap_components(pix)
    full = np.frombuffer(bytes(m.fz_pixmap_samples_memoryview(pix)), dtype=np.uint8).reshape(h, w, n)[:, :, :3]
    x0, y0, x1, y1 = (int(round(v * zoom)) for v in (clip.x0, clip.y0, clip.x1, clip.y1))
    return full[y0:y1, x0:x1].copy()


def extract_artwork(path: str, out_dir: str, pouch_w_mm: float | None, pouch_h_mm: float | None, dpi: int = ARTWORK_DPI) -> ArtworkResult:
    """pouch_w_mm / pouch_h_mm come from the validated specs. When either is unknown the bleed is
    NOT trimmed (never guessed) and a warning says so."""
    os.makedirs(out_dir, exist_ok=True)
    doc, page = open_page(path)
    res = ArtworkResult(method="none", dpi=dpi)
    if not has_real_trimbox(page):
        res.warnings.append("No artwork TrimBox in this PDF: the artwork area has to be chosen by the user")
        return res
    geo = page_geometry(page)
    res.trim_mm = (round(geo.trim_w_mm, 3), round(geo.trim_h_mm, 3))

    # 1. Technical layers off
    configs = doc.layer_ui_configs()
    technical = [c for c in configs if _is_technical(c["text"], TECHNICAL_LAYER_HINTS)]
    if technical and len(technical) < len(configs):
        for cfg in technical:
            doc.set_layer_ui_config(cfg["number"], action=2)  # force OFF
        res.method = "layers"
        res.layers_off = [c["text"] for c in technical]
        page = doc[0]
        rgb = _pixmap_to_rgb(page.get_pixmap(dpi=dpi, clip=geo.trim_clip, colorspace=pymupdf.csRGB, alpha=False))
    else:
        # 2. No usable layers: locate the marks through their spot ink and fill them in
        rgb = _pixmap_to_rgb(page.get_pixmap(dpi=dpi, clip=geo.trim_clip, colorspace=pymupdf.csRGB, alpha=False))
        inks = [n for n in spot_inks(page) if _is_technical(n, TECHNICAL_INK_HINTS)]
        if inks:
            without = _render_without_inks(page, geo.trim_clip, dpi, inks)
            h, w = min(rgb.shape[0], without.shape[0]), min(rgb.shape[1], without.shape[1])
            rgb, without = rgb[:h, :w], without[:h, :w]
            diff = np.abs(rgb.astype(np.int16) - without.astype(np.int16)).max(axis=2)
            mask = (diff > 24).astype(np.uint8) * 255
            mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=1)
            res.masked_pixel_pct = round(float(mask.mean()) / 255 * 100, 3)
            if res.masked_pixel_pct > 6:
                res.warnings.append(f"Technical marks cover {res.masked_pixel_pct}% of the artwork: too much to fill in reliably, marks were left in place")
            else:
                rgb = cv2.cvtColor(cv2.inpaint(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), mask, 4, cv2.INPAINT_TELEA), cv2.COLOR_BGR2RGB)
                res.method = "spot-ink-mask"
                res.inks_masked = inks
        else:
            res.warnings.append("No technical layer or spot ink found: technical marks (if any) are still in the artwork")

    # 3. Trim the bleed so the texture is exactly the finished pouch
    px_per_mm = dpi / MM_PER_INCH
    texture = rgb
    if pouch_w_mm and pouch_h_mm:
        bx, by = (geo.trim_w_mm - pouch_w_mm) / 2, (geo.trim_h_mm - pouch_h_mm) / 2
        if bx < -0.05 or by < -0.05:
            res.warnings.append("Pouch size is larger than the TrimBox: bleed not trimmed")
        else:
            # Centre crop to exactly the finished size (rounding each side separately drifts)
            tw = min(rgb.shape[1], int(round(pouch_w_mm * px_per_mm)))
            th = min(rgb.shape[0], int(round(pouch_h_mm * px_per_mm)))
            cx, cy = (rgb.shape[1] - tw) // 2, (rgb.shape[0] - th) // 2
            texture = rgb[cy: cy + th, cx: cx + tw]
            res.bleed_mm = (round(bx, 4), round(by, 4))
    else:
        res.warnings.append("Pouch size unknown: bleed was not trimmed")
    res.texture_mm = (round(texture.shape[1] / px_per_mm, 2), round(texture.shape[0] / px_per_mm, 2))
    res.average_rgb = tuple(int(v) for v in texture.reshape(-1, 3).mean(axis=0))

    res.full_png = os.path.join(out_dir, "artwork_full_bleed.png")
    res.texture_png = os.path.join(out_dir, "texture.png")
    cv2.imwrite(res.full_png, cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    cv2.imwrite(res.texture_png, cv2.cvtColor(texture, cv2.COLOR_RGB2BGR))
    return res
