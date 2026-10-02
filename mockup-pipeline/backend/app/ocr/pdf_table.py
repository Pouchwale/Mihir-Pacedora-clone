"""The spec table as cells, from the PDF's own text layer and table lines (PyMuPDF `find_tables`).

Where a sheet keeps its text live (Illustrator exports), the table's ruling lines and the words in
each cell are in the file: no rendering, no OCR, no guessing where a value ends. Each field's value
is the cell right of its label cell (or the rest of the label cell when both share one). Confidence
is 1.0: the text is the file's own. Word-position reading (app.ocr.table) stays the general path
and covers labels the table finder misses; this module fills and cross-checks its reads.
"""

import re
from pathlib import Path

import pymupdf

from app.ocr.table import FieldRead, _fix_word, _make_read, _similar, _tokens
from app.ocr.template import FieldRule, SpecTemplate
from app.ocr.tesseract import Word
from app.pdf.layers import Box

_STRATEGIES = ("lines_strict", "lines")


def table_cells(pdf: Path, region: Box) -> list[list[list[str]]]:
    """Every table PyMuPDF finds inside `region` (PDF user space) as rows of cell texts."""
    doc = pymupdf.open(pdf)
    try:
        page = doc[0]
        clip = pymupdf.Rect(region.x0, region.y0, region.x1, region.y1) * page.transformation_matrix
        clip.normalize()
        out: list[list[list[str]]] = []
        seen: set[tuple] = set()
        for strategy in _STRATEGIES:
            try:
                found = page.find_tables(clip=clip, strategy=strategy)
            except Exception:  # noqa: BLE001 - an odd page must not break the read
                continue
            for table in found.tables:
                key = tuple(round(v) for v in table.bbox)
                if key in seen:
                    continue
                seen.add(key)
                rows = []
                for row in table.extract():
                    rows.append([" ".join(str(c).split()) if c else "" for c in row])
                out.append(rows)
        return out
    finally:
        doc.close()


def _label_match(cell: str, rule: FieldRule, tpl: SpecTemplate) -> str | None:
    """The rest of the cell after this rule's label (or alias) when the cell carries it.

    Labels are tried longest first ("Gusset Type:" before "Gusset") and matched as a token sequence
    anywhere in the cell, so "524 Inside B2B Width: 514" yields "514" for the inside width (the 524
    belongs to the label before it). Only the last word of a label may be a near miss (OCR-free text
    still varies: "Color:" / "Colour:")."""
    words = [_fix_word(w, tpl) for w in cell.split()]
    word_tokens = [_tokens(w) for w in words]
    flat = [(t, i) for i, ts in enumerate(word_tokens) for t in ts]  # token -> word index
    toks = [t for t, _ in flat]
    for label in sorted((rule.label, *rule.aliases), key=lambda l: -len(_tokens(l))):
        lt = _tokens(label)
        if not lt or len(toks) < len(lt):
            continue
        for k in range(len(toks) - len(lt) + 1):
            window = toks[k : k + len(lt)]
            if window[:-1] == lt[:-1] and (window[-1] == lt[-1] or _similar(window[-1], lt[-1])):
                last_word = flat[k + len(lt) - 1][1]
                return " ".join(words[last_word + 1:]).strip()
    return None


def read_cells(tables: list[list[list[str]]], tpl: SpecTemplate) -> dict[str, tuple[str, str]]:
    """field -> (label text as printed, value text) for every labelled field found in the cells."""
    rules = [r for r in tpl.fields if r.field]
    found: dict[str, tuple[str, str]] = {}
    for rows in tables:
        for row in rows:
            for i, cell in enumerate(row):
                if not cell:
                    continue
                for rule in rules:
                    if rule.field in found or rule.multiline:
                        continue
                    rest = _label_match(cell, rule, tpl)
                    if rest is None:
                        continue
                    value = rest
                    if not value:
                        value = next((c for c in row[i + 1:] if c), "")
                        # a value cell that itself starts a label ("524 Inside B2B Width: 514") ends at that label
                        value = _cut_at_next_label(value, rules, tpl)
                    found[rule.field] = (cell, value)
                    break
    return found


def _cut_at_next_label(value: str, rules: list[FieldRule], tpl: SpecTemplate) -> str:
    words = value.split()
    for k in range(1, len(words)):
        tail = " ".join(words[k:])
        for rule in rules:
            if _label_match(tail, rule, tpl) is not None:
                return " ".join(words[:k])
    return value


def merge(reads: dict[str, FieldRead], cells: dict[str, tuple[str, str]], tpl: SpecTemplate) -> list[str]:
    """Fill reads the word-position pass left blank or invalid from the cells; cross-check numbers.

    Returns the fields taken from the cells. A numeric disagreement between the two readings lowers
    the read's confidence so it reaches the review form instead of a wrong mockup."""
    rules = {r.field: r for r in tpl.fields if r.field}
    taken: list[str] = []
    for field, (label, value) in cells.items():
        rule = rules.get(field)
        if rule is None:
            continue
        cell_words = [Word(w, 1.0, 0, 0, 1, 1) for w in value.split()]
        cell_read = _make_read(rule, cell_words, value, None, tpl, "pdf_table")
        current = reads.get(field)
        if current is None or current.value is None or not current.format_ok:
            if cell_read.value is not None and cell_read.format_ok:
                reads[field] = FieldRead(field, cell_read.raw, cell_read.value, 1.0, True, current.bbox if current else None, "", "pdf_table")
                taken.append(field)
            continue
        if rule.kind in ("number", "integer") and cell_read.value is not None and cell_read.format_ok:
            try:
                same = abs(float(cell_read.value) - float(current.value)) < 1e-6
            except (TypeError, ValueError):
                same = True
            if not same:
                reads[field] = FieldRead(field, current.raw, current.value, min(current.confidence, 0.7), True, current.bbox,
                                         f"table cell reads {cell_read.raw!r}", current.source, current.code_confidence)
    return taken


def numbers_in(text: str) -> list[float]:
    return [float(m) for m in re.findall(r"\d+(?:\.\d+)?", text)]
