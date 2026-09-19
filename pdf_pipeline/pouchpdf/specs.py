"""Stage 2: read the spec table (left of the artwork) into validated JSON.

All text in these PDFs is outlines, so the table is rendered and read with local OCR. Values are
found by their position next to a known label, never guessed: anything missing, unreadable, low
confidence or out of range is listed in `issues` and the result is flagged `needs_review`.
"""
from __future__ import annotations

import re
from typing import Callable

import numpy as np
import pymupdf

from .config import EXPECTED_BLEED_MM, MIN_FIELD_CONFIDENCE, SANE_RANGES_MM, SPEC_DPI, TRIMBOX_TOLERANCE_MM
from .ocr import OcrBox, rapidocr_engine
from .pdfio import has_real_trimbox, open_page, page_geometry

# field -> (label text as printed, value type)
LABELS: dict[str, tuple[str, str]] = {
    "client_name": ("Client Name", "text"),
    "item_name": ("Item Name", "text"),
    "item_no": ("Item No", "text"),
    "date_of_approval": ("Date of Approval", "text"),
    "pouch_height_mm": ("Pouch height", "mm"),
    "pouch_closed_width_mm": ("Pouch Closed width", "mm"),
    "pouch_open_width_mm": ("Pouch Open Width", "mm"),
    "pouch_or_roll_form": ("Pouch/Roll Form", "text"),
    "sealing_type": ("Sealing Type", "text"),
    "gusset_type": ("Gusset", "text"),
    "gusset_full_width_mm": ("Gusset Full Width", "mm"),
    "sealing_width_mm": ("Sealing Width", "mm"),
    "zipper": ("Zipper?", "bool"),
    "tear_notch": ("Tear Notch", "text"),
    "round_corner": ("Round Corner", "bool"),
    "butterfly_notch": ("Butterfly Notch", "bool"),
    "transparent_window": ("Transparent Window", "bool"),
}
LAYER_LABEL = re.compile(r"^layer\s*(\d)$", re.IGNORECASE)


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


_LABEL_KEYS = {_norm(label): field for field, (label, _t) in LABELS.items()}


def render_spec_image(path: str, dpi: int = SPEC_DPI) -> np.ndarray:
    """Everything left of the artwork (the dimension labels beside it are left out)."""
    doc, page = open_page(path)
    geo = page_geometry(page)
    right = geo.trim_clip.x0 - 55 if has_real_trimbox(page) else page.rect.width / 2
    clip = pymupdf.Rect(0, 0, max(right, page.rect.width * 0.25), page.rect.height)
    pix = page.get_pixmap(dpi=dpi, clip=clip, colorspace=pymupdf.csRGB, alpha=False)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3).copy()


def _value_right_of(label: OcrBox, boxes: list[OcrBox]) -> OcrBox | None:
    """Nearest box on the same table row to the right of the label that is not itself a label."""
    row = [
        b for b in boxes
        if b is not label and b.x0 >= label.x1 - 4 and abs(b.yc - label.yc) <= max(label.h, b.h) * 0.75
    ]
    row.sort(key=lambda b: b.x0)
    for b in row:
        key = _norm(b.text)
        if key in _LABEL_KEYS or LAYER_LABEL.match(b.text.strip()):
            return None  # the next thing on the row is another label: this cell is empty
        return b
    return None


def _parse_mm(text: str) -> float | None:
    # The WHOLE cell must be a number (optionally followed by "mm"): a misread such as "3l2 mm"
    # must fail instead of being read as "2 mm"
    m = re.fullmatch(r"\s*(\d+(?:[.,]\d+)?)\s*(?:mm)?\.?\s*", text, re.IGNORECASE)
    return float(m.group(1).replace(",", ".")) if m else None


def _parse_bool(text: str) -> bool | None:
    t = _norm(text)
    if t in ("yes", "y"):
        return True
    if t in ("no", "n", "none", "na"):
        return False
    return None


def parse_boxes(boxes: list[OcrBox]) -> dict:
    """Pure function (no PDF, no OCR): OCR boxes -> fields, confidences and issues."""
    fields: dict = {}
    confidence: dict[str, float] = {}
    issues: list[str] = []

    by_key: dict[str, OcrBox] = {}
    for b in boxes:
        key = _norm(b.text.rstrip(":"))
        if key in _LABEL_KEYS and key not in by_key:
            by_key[key] = b

    for field, (label, kind) in LABELS.items():
        lb = by_key.get(_norm(label))
        if lb is None:
            fields[field] = None
            issues.append(f"{field}: label '{label}' not found on the sheet")
            continue
        vb = _value_right_of(lb, boxes)
        if vb is None:
            fields[field] = None
            issues.append(f"{field}: no value next to '{label}'")
            continue
        conf = min(lb.conf, vb.conf)
        confidence[field] = round(conf, 3)
        raw = vb.text.strip()
        value = {"mm": _parse_mm, "bool": _parse_bool}.get(kind, lambda t: t)(raw)
        if value is None:
            issues.append(f"{field}: could not read '{raw}' as {kind}")
        elif conf < MIN_FIELD_CONFIDENCE:
            issues.append(f"{field}: low OCR confidence {conf:.2f} for '{raw}'")
        fields[field] = value

    # Tear notch is printed like "(V Notch)"
    if isinstance(fields.get("tear_notch"), str):
        t = fields["tear_notch"].strip("() ").strip()
        fields["tear_notch"] = None if _norm(t) in ("no", "none", "na", "") else t

    # Layers: "Layer 1" .. "Layer n" with the material to the right
    layers = []
    for b in sorted(boxes, key=lambda b: b.yc):
        m = LAYER_LABEL.match(b.text.strip())
        if m:
            vb = _value_right_of(b, boxes)
            if vb:
                layers.append(vb.text.strip())
                confidence[f"layer_{m.group(1)}"] = round(min(b.conf, vb.conf), 3)
    fields["layers"] = layers

    # Remarks: linked panel codes and the finish
    text = " ".join(b.text for b in boxes)
    back = re.search(r"back\s*code\s*:?\s*(FGPO\s*\d+)", text, re.IGNORECASE)
    gusset = re.search(r"gus+et\s*code\s*:?\s*(FGPO\s*\d+)", text, re.IGNORECASE)
    fields["back_code"] = back.group(1).replace(" ", "").upper() if back else None
    fields["gusset_code"] = gusset.group(1).replace(" ", "").upper() if gusset else None
    finish = re.search(r"\b(matt?e?|gloss\w*)\s*finish", text, re.IGNORECASE)
    if finish:
        fields["finish"] = "matt" if finish.group(1).lower().startswith("mat") else "gloss"
    elif any("matt" in layer.lower() for layer in layers[:1]):
        fields["finish"] = "matt"
        issues.append("finish: not stated in the remarks; taken from Layer 1 (MATT)")
    else:
        fields["finish"] = None
        issues.append("finish: not stated in the remarks")

    return {"fields": fields, "confidence": confidence, "issues": issues}


def validate(fields: dict, trim_w_mm: float, trim_h_mm: float, real_trimbox: bool = True) -> list[str]:
    problems: list[str] = []
    for key, (lo, hi) in SANE_RANGES_MM.items():
        v = fields.get(key)
        if v is None:
            continue
        if not lo <= v <= hi:
            problems.append(f"{key}: {v} mm is outside the sane range {lo}-{hi} mm")
    h, w = fields.get("pouch_height_mm"), fields.get("pouch_closed_width_mm")
    if not real_trimbox:
        problems.append("TrimBox: the PDF has no artwork TrimBox (it equals the page), so the artwork cannot be cropped automatically")
    elif h and w:
        exp_w = w + 2 * EXPECTED_BLEED_MM["horizontal"]
        exp_h = h + 2 * EXPECTED_BLEED_MM["vertical"]
        if abs(trim_w_mm - exp_w) > TRIMBOX_TOLERANCE_MM:
            problems.append(f"TrimBox width {trim_w_mm:.2f} mm does not match pouch width {w} mm + bleed ({exp_w:.2f} mm expected)")
        if abs(trim_h_mm - exp_h) > TRIMBOX_TOLERANCE_MM:
            problems.append(f"TrimBox height {trim_h_mm:.2f} mm does not match pouch height {h} mm + bleed ({exp_h:.2f} mm expected)")
    if fields.get("gusset_type") and _norm(str(fields["gusset_type"])) not in ("no", "none") and not fields.get("gusset_full_width_mm"):
        problems.append("gusset_full_width_mm: a gusset is specified but its width is missing")
    sw, cw = fields.get("sealing_width_mm"), fields.get("pouch_closed_width_mm")
    if sw and cw and sw * 2 >= cw:
        problems.append("sealing_width_mm: two side seals are wider than the pouch")
    return problems


def extract_specs(path: str, ocr: Callable[[np.ndarray], list[OcrBox]] = rapidocr_engine) -> dict:
    doc, page = open_page(path)
    geo = page_geometry(page)
    real_trim = has_real_trimbox(page)
    parsed = parse_boxes(ocr(render_spec_image(path)))
    issues = parsed["issues"] + validate(parsed["fields"], geo.trim_w_mm, geo.trim_h_mm, real_trim)
    return {
        **parsed["fields"],
        "trimbox_mm": [round(geo.trim_w_mm, 3), round(geo.trim_h_mm, 3)],
        "confidence": parsed["confidence"],
        "issues": issues,
        # True = show the values in an editable form instead of building the mockup
        "needs_review": bool(issues),
    }
