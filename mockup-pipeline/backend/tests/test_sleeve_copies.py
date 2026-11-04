"""A sleeve sheet with same-size copies: the printed artwork, not its separation preview.

FGSL4036 (white plate beside it), FGSL4046 / FGSL4109 (gloss & matt above it): the copy was picked by list
order, and the sleeves came out black or empty. FGSL4031 stated its size only in the file name, and the
whole page became the sleeve.
"""

import pymupdf

from app.pdf.layers import Box
from app.services import sleeve as sl

MM = 72 / 25.4


def _sheet(path, preview_first: bool) -> None:
    """176 x 135 mm artwork (many colours) and its 'gloss & matt separation' (two flat tints), stacked."""
    doc = pymupdf.open()
    page = doc.new_page(width=220 * MM, height=320 * MM)
    top, bottom = pymupdf.Rect(20 * MM, 20 * MM, 196 * MM, 155 * MM), pymupdf.Rect(20 * MM, 170 * MM, 196 * MM, 305 * MM)
    preview, art = (top, bottom) if preview_first else (bottom, top)
    page.draw_rect(preview, color=(0, 0, 0), fill=(0.95, 0.6, 0.8), width=0.3)
    page.draw_rect(pymupdf.Rect(preview.x0 + 40 * MM, preview.y0 + 30 * MM, preview.x0 + 120 * MM, preview.y0 + 60 * MM), fill=(0.6, 0.85, 0.9))
    page.draw_rect(art, color=(0, 0, 0), fill=(0.98, 0.9, 0.6), width=0.3)
    for i, c in enumerate([(0.9, 0.2, 0.1), (0.1, 0.5, 0.2), (0.1, 0.2, 0.7), (0.95, 0.6, 0.0), (0.4, 0.1, 0.4), (0.2, 0.2, 0.2)]):
        page.draw_rect(pymupdf.Rect(art.x0 + (10 + 27 * i) * MM, art.y0 + 20 * MM, art.x0 + (32 + 27 * i) * MM, art.y0 + 110 * MM), fill=c)
    doc.save(path)


def test_the_printed_copy_wins_over_its_separation_preview(tmp_path):
    for preview_first in (True, False):
        pdf = tmp_path / f"sheet_{preview_first}.pdf"
        _sheet(pdf, preview_first)
        page = Box(0, 0, 220 * MM, 320 * MM)
        box = sl.artwork_box(pdf, page, 176.0, 135.0)
        top_half = box.y0 > 160 * MM  # (PDF y up: the top of the page has the larger y)
        assert top_half == (not preview_first), preview_first  # always the many-coloured copy


def test_size_from_the_file_name():
    assert sl.size_from_filename("FGSL4031_Classic Valencia Orange_250 ml.SLEEVE_134.9375 X 176 mm_App.pdf") == (134.9375, 176.0)
