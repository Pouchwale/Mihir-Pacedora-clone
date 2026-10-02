"""The spec table read by an AI vision model in one call (Settings.text_reader = groq / claude / grok).

Used instead of Tesseract when the table has no live text (outlined glyphs). The whole table image
goes to the model with the template's labels; the model returns the printed value per field. Each
value then goes through the same cleanup and format rules as an OCR read (app.ocr.table), so a
value that does not fit its field (a letter in a height, an unknown sealing type) is rejected and
reaches review; a valid value scores AI_CONFIDENCE. Dimensions are cross-checked later against
the dieline's exact vector geometry, which catches a misread size.

Anything that goes wrong (no key, network, quota, a reply that is not JSON) raises
`Unavailable`; the caller then reads the table with Tesseract as before.
"""

import base64
import io
import json
import re
import time

import httpx
from PIL import Image

from app.config import Settings
from app.ocr.table import FieldRead, _make_read
from app.ocr.template import FieldRule, SpecTemplate
from app.ocr.tesseract import Word

READERS = ("groq", "claude", "grok", "openrouter")
MAX_PX = 2048  # long side of the image sent (the table's text stays about 15 px high)
MAX_BYTES = 3_500_000  # Groq accepts base64 images up to 4 MB
CONFIDENCE_CAP = 0.95
# A model's own confidence is not calibrated (it says 1.0 for nearly everything), so a value that
# passes its format rule gets this fixed score: above the review threshold, below a live-text read.
# Wrong sizes are caught by the dieline cross-check, wrong item codes by the file name.
AI_CONFIDENCE = 0.93
MAX_OUTPUT_TOKENS = 700  # ~35 short fields; also what a rate limit counts against
RATE_LIMIT_WAIT_MAX_S = 20.0


class Unavailable(RuntimeError):
    """The AI reader could not produce a reading; fall back to OCR."""


def _describe(rule: FieldRule) -> str:
    labels = " / ".join(f'"{label}"' for label in (rule.label, *rule.aliases))
    kind = {
        "number": "a number (keep the unit if printed)", "integer": "a whole number", "yes_no": "yes or no",
        "date": "a date", "code": "an item code like FGPO1234", "film": "a film / layer description",
        "option": "one of: " + ", ".join(rule.all_options()) if rule.options else "text",
    }.get(rule.kind, "text")
    return f'- "{rule.field}": label {labels}; {kind}' + ("; may span several lines" if rule.multiline else "")


def prompt(tpl: SpecTemplate) -> str:
    fields = "\n".join(_describe(r) for r in tpl.fields if r.field)
    return (
        "This image is the job spec table of a flexible packaging approval sheet. For each field below, "
        "read the value printed next to (or below) its label.\n"
        "Rules: copy numbers, codes and words character for character as printed; never compute, convert "
        "or guess a value; use null when the cell is blank, crossed out or the label is not on the sheet; "
        "join the lines of a multi-line value with \" | \".\n"
        "Return one compact JSON object only, one key per field: {\"<field>\": <text as printed or null>}\n"
        f"Fields:\n{fields}"
    )


def _encode(image: Image.Image) -> tuple[str, str]:
    """(media type, base64) of the image, shrunk to MAX_PX and under MAX_BYTES."""
    im = image.convert("RGB") if image.mode not in ("L", "RGB") else image.copy()
    if max(im.size) > MAX_PX:
        im.thumbnail((MAX_PX, MAX_PX), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    media = "image/png"
    if buf.tell() * 4 / 3 > MAX_BYTES:
        buf = io.BytesIO()
        im.convert("RGB").save(buf, format="JPEG", quality=90)
        media = "image/jpeg"
    return media, base64.b64encode(buf.getvalue()).decode()


def _json_from(text: str) -> dict:
    """The JSON object in a reply (a model may wrap it in a code fence or a sentence)."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            raise Unavailable("the reply holds no JSON object") from None
        try:
            data = json.loads(m.group())
        except json.JSONDecodeError as exc:
            raise Unavailable(f"the reply's JSON does not parse: {exc}") from None
    if not isinstance(data, dict):
        raise Unavailable("the reply is not a JSON object")
    return data


def _openai_style(url: str, key: str, model: str, media: str, b64: str, text: str) -> dict:
    """Groq, xAI and OpenRouter speak the OpenAI chat-completions protocol."""
    body = {
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": f"data:{media};base64,{b64}"}},
        ]}],
        "temperature": 0,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "response_format": {"type": "json_object"},
    }
    headers = {"Authorization": f"Bearer {key}"}
    response = httpx.post(url, headers=headers, json=body, timeout=120)
    if response.status_code == 400 and "response_format" in response.text:
        body.pop("response_format")  # a model without JSON mode: ask plainly, pick the JSON out of the reply
        response = httpx.post(url, headers=headers, json=body, timeout=120)
    if response.status_code == 429:
        # A per-minute limit (free tiers): wait what the provider asks, once, if it is short.
        wait = _retry_after(response)
        if wait is not None and wait <= RATE_LIMIT_WAIT_MAX_S:
            time.sleep(wait + 0.5)
            response = httpx.post(url, headers=headers, json=body, timeout=120)
    if response.status_code >= 400:
        raise Unavailable(f"HTTP {response.status_code}: {response.text[:300]}")
    return _json_from(response.json()["choices"][0]["message"]["content"])


def _retry_after(response: httpx.Response) -> float | None:
    header = response.headers.get("retry-after")
    try:
        if header is not None:
            return float(header)
    except ValueError:
        pass
    m = re.search(r"try again in ([\d.]+)\s*(ms|s)", response.text)
    if m:
        return float(m.group(1)) / (1000 if m.group(2) == "ms" else 1)
    return None


def _ask(reader: str, media: str, b64: str, text: str, settings: Settings) -> dict:
    if reader == "groq":
        if not settings.groq_api_key:
            raise Unavailable("GROQ_API_KEY is not set")
        return _openai_style("https://api.groq.com/openai/v1/chat/completions", settings.groq_api_key, settings.groq_model, media, b64, text)
    if reader == "grok":
        if not settings.xai_api_key:
            raise Unavailable("XAI_API_KEY is not set")
        return _openai_style("https://api.x.ai/v1/chat/completions", settings.xai_api_key, settings.grok_model, media, b64, text)
    if reader == "openrouter":
        if not settings.openrouter_api_key:
            raise Unavailable("OPENROUTER_API_KEY is not set")
        return _openai_style("https://openrouter.ai/api/v1/chat/completions", settings.openrouter_api_key, settings.openrouter_model, media, b64, text)
    if reader == "claude":
        import anthropic

        response = anthropic.Anthropic().messages.create(
            model=settings.anthropic_model,
            max_tokens=4000,
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}},
                {"type": "text", "text": text},
            ]}],
        )
        return _json_from("".join(b.text for b in response.content if b.type == "text"))
    raise Unavailable(f"unknown text reader {reader!r} (use ocr, {', '.join(READERS)})")


def read(image: Image.Image, tpl: SpecTemplate, reader: str, settings: Settings) -> dict[str, FieldRead]:
    """Every template field read by the model from the table image."""
    media, b64 = _encode(image)
    try:
        data = _ask(reader, media, b64, prompt(tpl), settings)
    except Unavailable:
        raise
    except Exception as exc:  # noqa: BLE001 - network, SDK or protocol errors all mean "use OCR instead"
        raise Unavailable(f"{type(exc).__name__}: {exc}") from exc
    return reads_from(data, tpl, reader)


def reads_from(data: dict, tpl: SpecTemplate, source: str) -> dict[str, FieldRead]:
    """FieldReads from the model's {field: {value, confidence}} answer, through the format rules."""
    reads: dict[str, FieldRead] = {}
    for rule in tpl.fields:
        if not rule.field:
            continue
        entry = data.get(rule.field)
        if isinstance(entry, dict):  # {"value": ..., "confidence": ...}: a model may still answer this way
            value, conf = entry.get("value"), entry.get("confidence", AI_CONFIDENCE)
        else:
            value, conf = entry, AI_CONFIDENCE
        try:
            conf = max(0.0, min(float(conf), CONFIDENCE_CAP, AI_CONFIDENCE))
        except (TypeError, ValueError):
            conf = AI_CONFIDENCE
        text = "" if value is None else " ".join(str(value).split()) if not rule.multiline else " | ".join(
            " ".join(part.split()) for part in str(value).split("|") if part.strip())
        words = [Word(w, conf, 0, 0, 1, 1) for w in text.replace(" | ", " ").split()]
        r = _make_read(rule, words, text, None, tpl, source)
        if r.value is not None:
            r.confidence = min(r.confidence, conf)
        reads[rule.field] = r
    return reads
