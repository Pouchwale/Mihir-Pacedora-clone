"""Optional vision fallback for single low-confidence cells (off by default).

Settings.vision_fallback selects "none" (default: nothing leaves the server) or "groq" (Groq Cloud,
through app.ocr.groq: cached and rate limited). Only the one cell image is sent, never the page. The answer goes
through the same format rules as OCR, so a fallback can fill a cell but cannot bypass validation.
"""

import base64
import io
import json
import logging

from PIL import Image
from pydantic import BaseModel

from app.config import Settings
from app.ocr import groq
from app.ocr.table import FieldRead, parse_value
from app.ocr.template import SpecTemplate

log = logging.getLogger(__name__)

PROMPT = (
    "This image is one cell of a packaging job spec table; the field is '{label}'. "
    "Return JSON only: {{\"value\": <the text exactly as printed, or null if the cell is blank "
    "or unreadable>, \"confidence\": <0-1 probability that value is exactly what is printed>}}."
)


class CellAnswer(BaseModel):
    value: str | None
    confidence: float


def _png_b64(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _ask_groq(image: Image.Image, label: str, settings: Settings) -> CellAnswer:
    content = groq.chat(settings, PROMPT.format(label=label), _png_b64(image), "image/png", 200)
    return CellAnswer.model_validate(json.loads(content))


PROVIDERS = {"groq": _ask_groq}


def apply(image: Image.Image, reads: dict[str, FieldRead], tpl: SpecTemplate, min_confidence: float, settings: Settings) -> list[str]:
    """Ask the configured provider about each weak cell. Returns the fields it changed."""
    provider = settings.vision_fallback.lower().strip()
    if provider == "none":
        return []
    if provider not in PROVIDERS:
        log.warning("vision_fallback=%s is not offered (only groq); the fallback is skipped", provider)
        return []
    if not settings.groq_api_key:
        # No key yet: behave as "none" (weak cells go to review) instead of failing every job.
        log.warning("vision_fallback=groq but GROQ_API_KEY is empty; the fallback is skipped")
        return []
    ask = PROVIDERS[provider]
    rules = {r.field: r for r in tpl.fields if r.field}
    changed = []
    for name, read in reads.items():
        if read.bbox is None or read.confidence >= min_confidence:
            continue
        x0, y0, x1, y1 = read.bbox
        pad = max(8, (y1 - y0) // 2)
        cell = image.crop((max(0, x0 - pad), max(0, y0 - pad), min(image.width, x1 + pad), min(image.height, y1 + pad)))
        try:
            answer = ask(cell, rules[name].label, settings)
        except (groq.Unavailable, ValueError) as exc:  # network, quota, bad JSON: the cell stays weak and goes to review
            log.warning("vision fallback %s failed on %s: %s", provider, name, exc)
            continue
        if answer.value is None:
            continue
        value, ok = parse_value(rules[name], answer.value, tpl)
        conf = min(answer.confidence, 0.95) if ok else min(answer.confidence, 0.3)
        if ok and conf > read.confidence:
            reads[name] = FieldRead(name, answer.value, value, round(conf, 3), ok, read.bbox, "", provider)
            changed.append(name)
    return changed
