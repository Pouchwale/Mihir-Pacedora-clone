"""Parse OCR words of the spec table with the label dictionary from the template.

For each known label, the value is the text to its right on the same row, up to the next known
label. Labels are matched in template (row-major) order and never above the previous match, each
once, so boilerplate lower on the sheet ("Eyemarks", "Sealing Width +/- 3 mm", "Gusset Code" in
Remarks) is ordinary text.
"""

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher

import numpy as np
from PIL import Image

from app.ocr import tesseract
from app.ocr.template import FieldRule, SpecTemplate
from app.ocr.tesseract import Word


@dataclass
class FieldRead:
    """One field as read from the table, before it becomes a typed SpecTable entry."""

    field: str
    raw: str | None  # cleaned text of the cell
    value: object  # parsed value or None
    confidence: float
    format_ok: bool
    bbox: tuple[int, int, int, int] | None  # value cell in image pixels, for fallback and the review UI
    reason: str = ""
    source: str = "ocr"  # "ocr", "ocr_cell" (second pass) or the fallback provider name
    code_confidence: dict[str, float] = field(default_factory=dict)  # item codes found in the text


@dataclass
class _Row:
    words: list[Word] = field(default_factory=list)

    @property
    def top(self) -> int:
        return min(w.top for w in self.words)

    @property
    def bottom(self) -> int:
        return max(w.bottom for w in self.words)


@dataclass
class _LabelHit:
    rule: FieldRule
    row: int
    first: int  # index of first word in row
    last: int  # index of last word in row (inclusive)


def erase_rules(image: Image.Image, min_fraction: float = 0.85) -> Image.Image:
    """Whiten table borders: pixel columns/rows that are dark along almost their whole length.

    Borders next to a value make Tesseract read '|' or miss a lone digit entirely.
    """
    arr = np.asarray(image.convert("L")).copy()
    dark = arr < 128
    if arr.shape[0] > 4:
        arr[:, dark.mean(axis=0) >= min_fraction] = 255
    if arr.shape[1] > 4:
        arr[dark.mean(axis=1) >= min_fraction, :] = 255
    return Image.fromarray(arr)


def _largest_glyph(dark: np.ndarray) -> tuple[int, int, int, int] | None:
    """Bounding box of the biggest compact dark component: the digit in a cell, not the rules
    (long thin runs) or a stray punctuation mark next to it."""
    from collections import deque

    dark = dark.copy()
    dark[dark.sum(axis=1) >= 0.5 * dark.shape[1], :] = False  # table rules
    dark[:, dark.sum(axis=0) >= 0.5 * dark.shape[0]] = False
    seen = np.zeros(dark.shape, dtype=bool)
    best, best_n = None, 0
    H, W = dark.shape
    for y0, x0 in zip(*np.nonzero(dark)):
        if seen[y0, x0]:
            continue
        queue, n = deque([(int(y0), int(x0))]), 0
        seen[y0, x0] = True
        bx0 = bx1 = int(x0)
        by0 = by1 = int(y0)
        while queue:
            y, x = queue.popleft()
            n += 1
            bx0, bx1, by0, by1 = min(bx0, x), max(bx1, x), min(by0, y), max(by1, y)
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < H and 0 <= nx < W and dark[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    queue.append((ny, nx))
        if n > best_n and (by1 - by0) >= 8:
            best, best_n = (bx0, by0, bx1, by1), n
    return best


def has_ink(image: Image.Image, min_pixels: int = 60) -> bool:
    """True if the image holds glyph-like marks; 1-2 px lines (border stubs) do not count."""
    dark = np.asarray(image.convert("L")) < 128
    dark[dark.sum(axis=1) < 3, :] = False  # rows crossed only by a thin vertical line
    dark[:, dark.sum(axis=0) < 3] = False  # columns crossed only by a thin horizontal line
    return int(dark.sum()) >= min_pixels


def refine_words(image: Image.Image, words: list[Word], tpl: SpecTemplate, min_confidence: float) -> list[Word]:
    """Re-read each low-confidence word on its own, enlarged 3x, as a single word.

    A word crop has no neighbours or borders to confuse the layout analysis, which fixes
    most weak reads (e.g. a bold 'FGPO7216' read as 'FGP0O7216' at 0.0).
    """
    out = []
    for w in words:
        if w.conf >= min_confidence or _is_noise(w, tpl):
            out.append(w)
            continue
        pad = max(4, w.height // 2)
        box = (max(0, w.left - pad), max(0, w.top - pad), min(image.width, w.right + pad), min(image.height, w.bottom + pad))
        crop = erase_rules(image.crop(box))
        crop = crop.resize((crop.width * 3, crop.height * 3), Image.LANCZOS)
        again = tesseract.words(crop, psm=8, lang=tpl.tesseract_lang)
        if len(again) == 1 and again[0].conf > w.conf:
            out.append(Word(again[0].text, again[0].conf, w.left, w.top, w.width, w.height))
        else:
            out.append(w)
    return out


def _tokens(text: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", text.lower()) if t]


def _similar(a: str, b: str) -> bool:
    if len(a) <= 2 or len(b) <= 2 or a.isdigit() or b.isdigit():
        return a == b
    return SequenceMatcher(None, a, b).ratio() >= 0.85


def group_rows(words: list[Word]) -> list[_Row]:
    """Cluster words into rows by vertical overlap (values sit a few px lower than labels)."""
    rows: list[_Row] = []
    for w in sorted(words, key=lambda w: w.cy):
        for row in reversed(rows[-3:]):
            overlap = min(row.bottom, w.bottom) - max(row.top, w.top)
            if overlap >= 0.5 * min(w.height, row.bottom - row.top):
                row.words.append(w)
                break
        else:
            rows.append(_Row([w]))
    for row in rows:
        row.words.sort(key=lambda w: w.left)
    return rows


def _fix_word(text: str, tpl: SpecTemplate) -> str:
    for wrong, right in tpl.word_fixes.items():
        if text.lower() == wrong.lower():
            return right
    return text


def _is_noise(w: Word, tpl: SpecTemplate, logo: bool = True) -> bool:
    """`logo`: also drop the printer's logo words (they sit in the Remarks row); a client name such
    as "Vadilal Industries Ltd." must keep its "Ltd."."""
    if logo and any(re.fullmatch(p, w.text, re.IGNORECASE) for p in tpl.noise_words):
        return True
    alnum = sum(c.isalnum() for c in w.text)
    if alnum == 0:
        return True  # borders and punctuation read as words: | _ — :
    return alnum <= tpl.junk_max_chars and w.conf < tpl.junk_max_confidence


def _find_labels(rows: list[_Row], tpl: SpecTemplate) -> list[_LabelHit]:
    row_tokens: list[list[tuple[str, int]]] = []
    edges: list[list[tuple[bool, bool]]] = []  # per token: (first token of its word, last token of its word)
    for row in rows:
        toks: list[tuple[str, int]] = []
        ends: list[tuple[bool, bool]] = []
        for wi, w in enumerate(row.words):
            parts = _tokens(_fix_word(w.text, tpl))
            toks += [(t, wi) for t in parts]
            ends += [(k == 0, k == len(parts) - 1) for k in range(len(parts))]
        row_tokens.append(toks)
        edges.append(ends)
    consumed: list[set[int]] = [set() for _ in rows]  # token indices already part of a label

    def find(rule: FieldRule, lo: int, hi: int):
        """First unconsumed printing of the label in rows lo..hi-1 (reading order); longest variant first.
        A label covers whole words: the "Zipper" inside the value "Standy+Zipper" is not the label "Zipper?"."""
        variants = sorted((t for t in (_tokens(v) for v in [rule.label, *rule.aliases]) if t), key=len, reverse=True)
        for ri in range(lo, min(hi, len(rows))):
            toks = row_tokens[ri]
            for i in range(len(toks)):
                for lt in variants:
                    span = set(range(i, i + len(lt)))
                    if i + len(lt) > len(toks) or span & consumed[ri]:
                        continue
                    if not (edges[ri][i][0] and edges[ri][i + len(lt) - 1][1]):
                        continue
                    if all(_similar(toks[i + k][0], lt[k]) for k in range(len(lt))):
                        return ri, i, span, len(lt)
        return None

    def take(rule: FieldRule, found) -> _LabelHit:
        ri, i, span, n = found
        consumed[ri] |= span
        toks = row_tokens[ri]
        last = toks[i + n - 1][1]
        # A label's trailing ":" or "?" may be OCR'd as a separate word; it belongs to the label.
        words_in_row = rows[ri].words
        while last + 1 < len(words_in_row) and not any(c.isalnum() for c in words_in_row[last + 1].text):
            last += 1
        return _LabelHit(rule, ri, toks[i][1], last)

    hits: list[_LabelHit] = []
    if not any(rule.section for rule in tpl.fields):
        # A template without blocks (saved before blocks existed): every label in template order,
        # never above the previous match.
        lo = 0
        for rule in tpl.fields:
            if found := find(rule, lo, len(rows)):
                hits.append(take(rule, found))
                lo = found[0]
        return hits
    starts: dict[int, int] = {}  # template index of a block start -> its row
    lo = 0
    for k, rule in enumerate(tpl.fields):
        if rule.section and (found := find(rule, lo, len(rows))):
            hits.append(take(rule, found))
            starts[k] = lo = found[0]
    for k, rule in enumerate(tpl.fields):
        if rule.section:
            continue
        before = [row for j, row in starts.items() if j < k]
        after = [row for j, row in starts.items() if j > k]
        found = find(rule, max(before, default=0), min(after, default=len(rows)))
        if found:
            hits.append(take(rule, found))
    return hits


def _clean(text: str, rule: FieldRule, tpl: SpecTemplate) -> str:
    for phrase in tpl.noise_phrases:
        text = re.sub(re.escape(phrase), " ", text, flags=re.IGNORECASE)
    strip = "".join(c for c in tpl.strip_chars if c not in rule.keep_chars)
    if strip:
        text = re.sub(f"[{re.escape(strip)}]", " ", text)
    return re.sub(r"\s+", " ", text).strip(" :;,.")


def _digits(text: str) -> str:
    """OCR letter/digit confusions inside numeric tokens."""
    return re.sub(r"(?<=\d)[Oo]|[Oo](?=\d)", "0", re.sub(r"(?<=\d)[lI]|[lI](?=\d)", "1", text))


def normalize_codes(text: str) -> str:
    """'FGP07216' / 'FGPO7216' -> 'FGPO7216': the 4th letter of the prefix is always the letter O."""
    return re.sub(r"\bFGP[O0](?=[\dOo])", "FGPO", text, flags=re.IGNORECASE)


def parse_value(rule: FieldRule, text: str, tpl: SpecTemplate) -> tuple[object, bool]:
    """(value, format_ok) for a cleaned, non-empty cell text."""
    kind = rule.kind
    if kind in ("number", "integer"):
        if _tokens(text) in (["na"], ["n", "a"], ["nil"]):
            return None, rule.optional  # "NA" is a valid blank for an optional number
        m = re.search(r"\d+(?:[.,]\d+)?(?:\s*\+\s*\d+(?:[.,]\d+)?)*", _digits(text))
        if not m:
            return None, False
        # "60+60 mm (120 One Side)": a full width given as its two halves is their sum
        value = sum(float(part.replace(",", ".")) for part in m.group().split("+"))
        if kind == "integer":
            ok = value.is_integer()
            value = int(value)
        else:
            ok = True
        if rule.min is not None and value < rule.min or rule.max is not None and value > rule.max:
            ok = False
        return value, ok
    if kind == "yes_no":
        first = _tokens(text)[:1]
        if first and first[0] in tpl.yes_words:
            return True, True
        if first and first[0] in tpl.no_words:
            return False, True
        return None, False
    if kind == "option":
        bare = re.sub(r"[()]", "", text).strip()
        toks = _tokens(bare)
        best, score = None, 0.0
        for opt in rule.all_options():
            ot = _tokens(opt)
            s = SequenceMatcher(None, " ".join(toks), " ".join(ot)).ratio()
            # "Bottom Gusset" is the option "Bottom" with a word added; "Standy+Zipper" starts with "Standy"
            if ot and all(t in toks for t in ot) or (len(ot) == 1 and toks and toks[0].startswith(ot[0]) and len(ot[0]) >= 4):
                s = max(s, 0.9 - 0.01 * (len(toks) - len(ot)))
            if s > score:
                best, score = opt, s
        return (rule.canonical(best), True) if score >= 0.8 and best is not None else (bare, False)
    if kind == "film":
        if re.fullmatch(r"(0|0\s*mic\w*)?\s*(none|no|na|n/a|nil|-)?", text.strip(), re.IGNORECASE) and text.strip():
            return None, rule.optional  # "0 None": this layer is not used
        # "18 mic MATT BOPP", "25 Matt BOPP" (no unit), "12µ METPET", "70 micron LDPE"
        m = re.match(r"(\d+(?:[.,]\d+)?)\s*(?:mic\w*\.?|micron\w*|µ|um|u)?\s+(.+)", _digits(text), re.IGNORECASE)
        if not m:
            return text, False
        return {"micron": float(m.group(1).replace(",", ".")), "material": m.group(2).strip()}, True
    if kind == "code":
        m = re.fullmatch(r"FGPO(\d+)", normalize_codes(text).upper())
        return (m.group(0), True) if m else (text, False)
    if kind == "date":
        m = re.search(r"\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}", _digits(text))
        return (m.group(), True) if m else (text, False)
    return text, bool(text)


def _make_read(rule: FieldRule, value_words: list[Word], text: str, bbox, tpl: SpecTemplate, source: str) -> FieldRead:
    if rule.multiline:
        cleaned = " | ".join(p for p in (_clean(normalize_codes(p), rule, tpl) for p in text.split(" | ")) if p)
    else:
        cleaned = _clean(text, rule, tpl)
    if not cleaned:
        conf = 0.9 if rule.optional else 0.0
        return FieldRead(rule.field, None, None, conf, rule.optional, bbox, "" if rule.optional else "blank", source)
    value, ok = parse_value(rule, cleaned, tpl)
    # Item codes inside free text (Remarks) are scored separately: their check is the file
    # registry lookup in link_panels, which is stronger evidence than OCR confidence.
    codes = {}
    text_words = []
    for w in value_words:
        code = normalize_codes(w.text.strip(".,;:")).upper()
        if rule.kind == "text" and re.fullmatch(r"FGPO\d+", code):
            codes[code] = min(codes.get(code, 1.0), w.conf)
        else:
            text_words.append(w)
    word_conf = min((w.conf for w in text_words), default=0.0 if not codes else 1.0)
    conf = word_conf if ok else min(word_conf, 0.3)
    return FieldRead(rule.field, cleaned, value, round(conf, 3), ok, bbox, "" if ok else f"not a valid {rule.kind}", source, codes)


def read_fields(words: list[Word], tpl: SpecTemplate, image_width: int) -> dict[str, FieldRead]:
    rows = group_rows(words)
    hits = _find_labels(rows, tpl)
    by_row: dict[int, list[_LabelHit]] = {}
    for h in hits:
        by_row.setdefault(h.row, []).append(h)
    for hs in by_row.values():
        hs.sort(key=lambda h: h.first)
    labelled_rows = sorted(by_row)

    reads: dict[str, FieldRead] = {}
    for h in hits:
        rule = h.rule
        if rule.field is None:
            continue
        row = rows[h.row]
        label_right = row.words[h.last].right
        nxt = next((o for o in by_row[h.row] if o.first > h.last), None)
        cell_right = row.words[nxt.first].left if nxt else image_width
        if rule.multiline:
            # Everything right of the label between the neighbouring labelled rows.
            above = max((r for r in labelled_rows if r < h.row), default=None)
            below = min((r for r in labelled_rows if r > h.row), default=None)
            top = rows[above].bottom if above is not None else 0
            bottom = rows[below].top if below is not None else 10**9
            # Drop noise before grouping: a tall logo fragment would merge the cell's lines into one.
            candidates = [w for r in rows for w in r.words if w.left > label_right and top < w.cy < bottom and not _is_noise(w, tpl)]
            lines = [r.words for r in group_rows(candidates)]
            value_words = [w for line in lines for w in line]
            text = " | ".join(" ".join(x.text for x in line) for line in lines)
            # The cell is the kept words' extent (a logo or boilerplate beside them stays outside).
            bbox = (
                (min(w.left for w in value_words), min(w.top for w in value_words), max(w.right for w in value_words), max(w.bottom for w in value_words))
                if value_words else (label_right, row.top, cell_right, row.bottom)
            )
        else:
            end = nxt.first if nxt else len(row.words)
            value_words = [w for w in row.words[h.last + 1 : end] if not _is_noise(w, tpl, logo=False)]
            text = " ".join(w.text for w in value_words)
            bbox = (label_right, row.top, cell_right, row.bottom)
        reads[rule.field] = _make_read(rule, value_words, text, bbox, tpl, "ocr")

    for rule in tpl.fields:
        if rule.field and rule.field not in reads:
            # A template variant may not print an optional row at all: that is a blank, not a failure.
            reads[rule.field] = FieldRead(rule.field, None, None, 0.9 if rule.optional else 0.0, rule.optional, None,
                                          f"label {rule.label!r} not found")
    return reads


TESSERACT_MAX_PX = 30000  # Tesseract's hard limit is 32767 on either side


def second_pass(image: Image.Image, reads: dict[str, FieldRead], tpl: SpecTemplate, min_confidence: float) -> None:
    """Re-read weak or blank cells on their own, enlarged 2x, as one line (multi-line cells as a block).

    Replaces a read only when the new one is valid and more confident. Offline, like pass one.
    """
    rules = {r.field: r for r in tpl.fields if r.field}
    for name, read in reads.items():
        if read.bbox is None or (read.value is not None and read.confidence >= min_confidence):
            continue
        if read.value is None and read.format_ok and read.raw and read.confidence >= min_confidence:
            continue  # a printed "NA" / "0 None": read well, and it means blank
        rule = rules[name]
        x0, y0, x1, y1 = read.bbox
        pad = max(6, (y1 - y0) // 3)
        box = (max(0, x0 - 2), max(0, y0 - pad), min(image.width, x1 + 2), min(image.height, y1 + pad))
        crop = erase_rules(image.crop(box))
        if read.value is None and not has_ink(crop):
            continue  # genuinely blank cell: keep the blank read
        best = None
        # Tesseract's confidence on 1-2 character cells swings with scale; try a few. Tesseract
        # refuses images wider or taller than 32767 px (a Remarks row across a wide sheet at 3x).
        for scale in (1, 2, 3):
            if max(crop.width, crop.height) * scale > TESSERACT_MAX_PX:
                continue
            scaled = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS) if scale > 1 else crop
            for psm in ((6,) if rule.multiline else (7, 6)):
                words = [w for w in tesseract.words(scaled, psm=psm, lang=tpl.tesseract_lang) if not _is_noise(w, tpl, logo=rule.multiline)]
                lines = [r.words for r in group_rows(words)]
                value_words = [w for line in lines for w in line]
                text = (" | " if rule.multiline else " ").join(" ".join(w.text for w in line) for line in lines)
                new = _make_read(rule, value_words, text, read.bbox, tpl, "ocr_cell")
                if new.value is not None and new.format_ok and (best is None or new.confidence > best.confidence):
                    best = new
        if best is None and rule.kind in ("number", "integer") and read.value is None:
            # A lone digit ("1") in a wide cell is often read as a bar or a letter: crop tight to the
            # ink, enlarge, single-line / single-character modes; a lone bar-like glyph is a 1.
            glyph = _largest_glyph(np.asarray(crop.convert("L")) < 128)
            if glyph is not None:
                pad = 6
                gx0, gy0, gx1, gy1 = glyph
                tight = crop.crop((max(0, gx0 - pad), max(0, gy0 - pad), min(crop.width, gx1 + pad + 1), min(crop.height, gy1 + pad + 1)))
                for scale in (3, 4):
                    scaled = tight.resize((tight.width * scale, tight.height * scale), Image.LANCZOS)
                    for psm in (7, 8, 10):
                        words = tesseract.words(scaled, psm=psm, lang=tpl.tesseract_lang)
                        text = " ".join(w.text for w in words)
                        if re.fullmatch(r"[|lI!\]\[1]+", text.replace(" ", "")) and len(text.replace(" ", "")) == 1:
                            words = [Word("1", min(w.conf, 0.9), w.left, w.top, w.width, w.height) for w in words]
                            text = "1"
                        new = _make_read(rule, words, text, read.bbox, tpl, "ocr_digits")
                        if new.value is not None and new.format_ok and (best is None or new.confidence > best.confidence):
                            best = new
        if rule.multiline and read.source == "pdf_text" and read.value is None and (best is None or best.confidence < 0.5):
            # The PDF has live text and none in this cell: its ink is the printer's logo, which sits in
            # the Remarks row (FGPO3009: read as "UUVARAL ERIN ..." at confidence 0), not a remark.
            continue
        if best is not None and (read.value is None or best.confidence > read.confidence):
            reads[name] = best
        elif read.value is None:
            # Ink in the cell but nothing readable: never report it as blank.
            reads[name] = FieldRead(name, None, None, 0.0, False, read.bbox, "cell has content OCR cannot read", read.source)
