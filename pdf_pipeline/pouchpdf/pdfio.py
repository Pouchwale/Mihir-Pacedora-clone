"""Low-level PDF access shared by the stages (PyMuPDF only)."""
from __future__ import annotations

from dataclasses import dataclass

import pymupdf

PT_TO_MM = 25.4 / 72.0


@dataclass
class PageGeometry:
    page_w_mm: float
    page_h_mm: float
    trim_w_mm: float
    trim_h_mm: float
    #: TrimBox in the page's drawing coordinates (points, origin top-left of the CropBox)
    trim_clip: pymupdf.Rect


def open_page(path: str):
    doc = pymupdf.open(path)
    if doc.page_count < 1:
        raise ValueError(f"{path}: PDF has no pages")
    return doc, doc[0]


def page_geometry(page) -> PageGeometry:
    """The TrimBox is stored in PDF user space; rendering clips are relative to the CropBox."""
    trim, crop = page.trimbox, page.cropbox
    clip = pymupdf.Rect(trim.x0 - crop.x0, trim.y0 - crop.y0, trim.x1 - crop.x0, trim.y1 - crop.y0)
    clip = clip & page.rect
    return PageGeometry(
        page_w_mm=page.rect.width * PT_TO_MM,
        page_h_mm=page.rect.height * PT_TO_MM,
        trim_w_mm=trim.width * PT_TO_MM,
        trim_h_mm=trim.height * PT_TO_MM,
        trim_clip=clip,
    )


def has_real_trimbox(page) -> bool:
    """False when the TrimBox is just the page (no artwork box was set by prepress)."""
    trim, crop = page.trimbox, page.cropbox
    return trim.width < crop.width * 0.9 or trim.height < crop.height * 0.9


def layer_names(doc) -> list[str]:
    return [cfg["text"] for cfg in doc.layer_ui_configs()]


def spot_inks(page) -> list[str]:
    m = pymupdf.mupdf
    seps = m.fz_page_separations(page.this)
    return [m.fz_separation_name(seps, i) for i in range(m.fz_count_separations(seps))]
