"""Words from the PDF's own text layer, positioned like OCR words.

Illustrator-made approval sheets keep the spec table as live text; reading it is exact where OCR
can only be confident. Words come back as tesseract.Word in the pixels of a render of `region` at
`dpi` (confidence 1.0), so the same label dictionary and review previews work unchanged. Where a
sheet has outlined text instead, the caller falls back to OCR.
"""

import unicodedata
from pathlib import Path

import pymupdf

from app.ocr.tesseract import Word
from app.pdf.layers import Box


def words(pdf: Path, region: Box, dpi: int) -> list[Word]:
    doc = pymupdf.open(pdf)
    page = doc[0]
    inv = ~page.transformation_matrix
    s = dpi / 72
    out: list[Word] = []
    for x0, y0, x1, y1, text, *_ in page.get_text("words"):
        text = unicodedata.normalize("NFKC", text)  # typographic ligatures: "Butterﬂy" -> "Butterfly"
        r = pymupdf.Rect(x0, y0, x1, y1) * inv  # PDF user space (y up)
        cx, cy = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
        if not (region.x0 <= cx <= region.x1 and region.y0 <= cy <= region.y1) or not text.strip():
            continue
        # Font boxes include ascender and descender room; keep the glyph core so adjacent table rows
        # do not overlap (row grouping works on vertical overlap).
        h = r.y1 - r.y0
        top, bottom = r.y1 - 0.2 * h, r.y0 + 0.2 * h
        out.append(Word(text.strip(), 1.0, round((r.x0 - region.x0) * s), round((region.y1 - top) * s),
                        max(1, round((r.x1 - r.x0) * s)), max(1, round((top - bottom) * s))))
    doc.close()
    return out
