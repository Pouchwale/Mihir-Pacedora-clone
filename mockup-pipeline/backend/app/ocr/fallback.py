"""Optional vision fallback for single low-confidence cells (off by default).

Settings.vision_fallback selects "none" (default: nothing leaves the server), "claude", "grok"
(xAI) or "groq" (Groq Cloud). Only the one cell image is sent, never the page. The answer goes
through the same format rules as OCR, so a fallback can fill a cell but cannot bypass validation.
"""

import base64
import io
import json
import logging

import anthropic
import httpx
from PIL import Image
from pydantic import BaseModel

from app.config import Settings
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


def _ask_claude(image: Image.Image, label: str, settings: Settings) -> CellAnswer:
    client = anthropic.Anthropic()
    response = client.messages.parse(
        model=settings.anthropic_model,
        max_tokens=2000,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": _png_b64(image)}},
            {"type": "text", "text": PROMPT.format(label=label)},
        ]}],
        output_format=CellAnswer,
    )
    if response.stop_reason == "refusal" or response.parsed_output is None:
        return CellAnswer(value=None, confidence=0.0)
    return response.parsed_output


def _chat_completions(url: str, key: str, model: str, image: Image.Image, label: str) -> CellAnswer:
    """One image + prompt to an OpenAI-compatible chat endpoint (xAI, Groq), JSON answer."""
    response = httpx.post(
        url,
        headers={"Authorization": f"Bearer {key}"},
        json={
            "model": model,
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{_png_b64(image)}"}},
                {"type": "text", "text": PROMPT.format(label=label)},
            ]}],
            "response_format": {"type": "json_object"},
            "temperature": 0,
        },
        timeout=60,
    )
    response.raise_for_status()
    content = response.json()["choices"][0]["message"]["content"]
    return CellAnswer.model_validate(json.loads(content))


def _ask_grok(image: Image.Image, label: str, settings: Settings) -> CellAnswer:
    if not settings.xai_api_key:
        raise RuntimeError("vision_fallback=grok but XAI_API_KEY is not set")
    return _chat_completions("https://api.x.ai/v1/chat/completions", settings.xai_api_key, settings.grok_model, image, label)


def _ask_groq(image: Image.Image, label: str, settings: Settings) -> CellAnswer:
    return _chat_completions("https://api.groq.com/openai/v1/chat/completions", settings.groq_api_key, settings.groq_model, image, label)


def _ask_openrouter(image: Image.Image, label: str, settings: Settings) -> CellAnswer:
    return _chat_completions("https://openrouter.ai/api/v1/chat/completions", settings.openrouter_api_key, settings.openrouter_model, image, label)


PROVIDERS = {"claude": _ask_claude, "grok": _ask_grok, "groq": _ask_groq, "openrouter": _ask_openrouter}


def apply(image: Image.Image, reads: dict[str, FieldRead], tpl: SpecTemplate, min_confidence: float, settings: Settings) -> list[str]:
    """Ask the configured provider about each weak cell. Returns the fields it changed."""
    provider = settings.vision_fallback.lower()
    if provider == "none":
        return []
    keys = {"groq": settings.groq_api_key, "openrouter": settings.openrouter_api_key}
    if provider in keys and not keys[provider]:
        # No key yet: behave as "none" (weak cells go to review) instead of failing every job.
        log.warning("vision_fallback=%s but its API key is empty; the fallback is skipped", provider)
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
        except (httpx.HTTPError, ValueError) as exc:  # network, quota, bad JSON: the cell stays weak and goes to review
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
