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


_PAGE_WORDS: dict[tuple, list[tuple[pymupdf.Rect, str]]] = {}


def _page_words(pdf: Path) -> list[tuple[pymupdf.Rect, str]]:
    """Page 1's words in PDF user space, read once per file (a job asks for them a dozen times, for
    different regions, and a big sheet takes ~0.6 s each)."""
    st = pdf.stat()
    key = (str(pdf), st.st_mtime_ns, st.st_size)
    if key not in _PAGE_WORDS:
        doc = pymupdf.open(pdf)
        try:
            page = doc[0]
            inv = ~page.transformation_matrix
            # (typographic ligatures: "Butterﬂy" -> "Butterfly")
            found = [(pymupdf.Rect(x0, y0, x1, y1) * inv, unicodedata.normalize("NFKC", text))
                     for x0, y0, x1, y1, text, *_ in page.get_text("words")]
        finally:
            doc.close()
        while len(_PAGE_WORDS) >= 8:
            _PAGE_WORDS.pop(next(iter(_PAGE_WORDS)))
        _PAGE_WORDS[key] = found
    return _PAGE_WORDS[key]


def words(pdf: Path, region: Box, dpi: int) -> list[Word]:
    s = dpi / 72
    out: list[Word] = []
    for r, text in _page_words(pdf):  # r: PDF user space (y up)
        cx, cy = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
        if not (region.x0 <= cx <= region.x1 and region.y0 <= cy <= region.y1) or not text.strip():
            continue
        # Font boxes include ascender and descender room; keep the glyph core so adjacent table rows
        # do not overlap (row grouping works on vertical overlap).
        h = r.y1 - r.y0
        top, bottom = r.y1 - 0.2 * h, r.y0 + 0.2 * h
        out.append(Word(text.strip(), 1.0, round((r.x0 - region.x0) * s), round((region.y1 - top) * s),
                        max(1, round((r.x1 - r.x0) * s)), max(1, round((top - bottom) * s))))
    return out
