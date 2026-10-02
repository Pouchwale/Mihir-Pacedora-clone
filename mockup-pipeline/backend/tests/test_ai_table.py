"""The spec table read by an AI model (Settings.text_reader): request, parsing, format rules, fallback."""

import httpx
import pytest
from PIL import Image

from app.config import Settings
from app.ocr import ai_table
from app.ocr.template import SpecTemplate

TPL = SpecTemplate()


def test_prompt_names_every_field_with_its_label():
    text = ai_table.prompt(TPL)
    for rule in TPL.fields:
        if rule.field:
            assert f'"{rule.field}"' in text and rule.label in text


def test_answers_go_through_the_format_rules():
    reads = ai_table.reads_from({
        "pouch_height_mm": {"value": "210 mm", "confidence": 0.99},
        "sealing_type": {"value": "Standy+Zipper", "confidence": 0.98},
        "zipper": {"value": "banana", "confidence": 0.99},
        "item_no": "FGP07535",  # a bare value, OCR-style O/0 slip
        "client_name": {"value": None, "confidence": 1.0},
    }, TPL, "groq")
    assert reads["pouch_height_mm"].value == 210 and reads["pouch_height_mm"].confidence == ai_table.AI_CONFIDENCE  # not the model's 0.99
    assert reads["pouch_height_mm"].source == "groq" and reads["pouch_height_mm"].bbox is None
    assert reads["sealing_type"].format_ok and reads["sealing_type"].value  # an option the template knows
    assert reads["zipper"].value is None and not reads["zipper"].format_ok  # "banana" is no yes/no: to review
    assert reads["item_no"].value == "FGPO7535"
    assert reads["client_name"].value is None and reads["client_name"].confidence == 0.0  # blank required field: to review
    assert set(reads) == {r.field for r in TPL.fields if r.field}  # every field present, answered or not


def test_groq_request(monkeypatch):
    sent = {}

    def fake_post(url, headers, json, timeout):
        sent.update(url=url, headers=headers, body=json)
        return httpx.Response(200, json={"choices": [{"message": {"content": '```json\n{"pouch_height_mm": {"value": "130", "confidence": 0.9}}\n```'}}]})

    monkeypatch.setattr(ai_table.httpx, "post", fake_post)
    reads = ai_table.read(Image.new("RGB", (5000, 3000), "white"), TPL, "groq", Settings(groq_api_key="gsk_x", groq_model="m"))
    assert reads["pouch_height_mm"].value == 130
    assert sent["url"].startswith("https://api.groq.com/") and sent["headers"]["Authorization"] == "Bearer gsk_x" and sent["body"]["model"] == "m"
    image_part = sent["body"]["messages"][0]["content"][1]["image_url"]["url"]
    assert image_part.startswith("data:image/png;base64,")
    import base64
    import io
    sent_image = Image.open(io.BytesIO(base64.b64decode(image_part.split(",", 1)[1])))
    assert max(sent_image.size) == ai_table.MAX_PX  # shrunk before sending


def test_openrouter_request(monkeypatch):
    sent = {}

    def fake_post(url, headers, json, timeout):
        sent.update(url=url, headers=headers, body=json)
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"pouch_height_mm": "130"}'}}]})

    monkeypatch.setattr(ai_table.httpx, "post", fake_post)
    reads = ai_table.read(Image.new("L", (10, 10)), TPL, "openrouter", Settings(openrouter_api_key="sk-or-x", openrouter_model="m"))
    assert reads["pouch_height_mm"].value == 130 and reads["pouch_height_mm"].source == "openrouter"
    assert sent["url"] == "https://openrouter.ai/api/v1/chat/completions" and sent["headers"]["Authorization"] == "Bearer sk-or-x" and sent["body"]["model"] == "m"
    with pytest.raises(ai_table.Unavailable, match="OPENROUTER_API_KEY"):
        ai_table.read(Image.new("L", (10, 10)), TPL, "openrouter", Settings(openrouter_api_key=""))


def test_short_rate_limit_is_waited_out_once(monkeypatch):
    replies = iter([httpx.Response(429, json={"error": {"message": "Rate limit reached ... Please try again in 0.01s."}}),
                    httpx.Response(200, json={"choices": [{"message": {"content": '{"pouch_height_mm": "130"}'}}]})])
    monkeypatch.setattr(ai_table.httpx, "post", lambda url, headers, json, timeout: next(replies))
    reads = ai_table.read(Image.new("L", (10, 10)), TPL, "groq", Settings(groq_api_key="gsk_x"))
    assert reads["pouch_height_mm"].value == 130


@pytest.mark.parametrize("status,body", [(429, {"error": "rate limited"}), (200, {"choices": [{"message": {"content": "sorry, I cannot"}}]})])
def test_failures_are_unavailable(monkeypatch, status, body):
    monkeypatch.setattr(ai_table.httpx, "post", lambda url, headers, json, timeout: httpx.Response(status, json=body))
    with pytest.raises(ai_table.Unavailable):
        ai_table.read(Image.new("L", (10, 10)), TPL, "groq", Settings(groq_api_key="gsk_x"))
    with pytest.raises(ai_table.Unavailable, match="GROQ_API_KEY"):
        ai_table.read(Image.new("L", (10, 10)), TPL, "groq", Settings(groq_api_key=""))


def test_read_table_falls_back_to_tesseract(monkeypatch):
    """TEXT_READER=groq on an outlined table: the model's reads when it answers, Tesseract when it cannot."""
    from app.pdf.profile import PdfProfile
    from app.steps import extract_specs

    monkeypatch.setattr(extract_specs.pdf_text, "words", lambda *a, **k: [])  # no live text
    monkeypatch.setattr(extract_specs, "ocr_table", lambda *a, **k: ([], Image.new("L", (100, 100), 255)))
    renders = extract_specs.Renders(spec=Image.new("RGB", (100, 100), "white"), spec_box=None, dims=None, dims_box=None)
    settings = Settings(text_reader="groq", groq_api_key="gsk_x")
    sheet = type("S", (), {"mode": "separation"})()

    monkeypatch.setattr(ai_table, "_ask", lambda *a: {"pouch_height_mm": {"value": "130", "confidence": 0.9}})
    reads, _, _, source = extract_specs.read_table(None, renders, PdfProfile(), sheet, 0.85, settings)
    assert source == "groq" and reads["pouch_height_mm"].value == 130

    def down(*a):
        raise ai_table.Unavailable("HTTP 503")

    monkeypatch.setattr(ai_table, "_ask", down)
    reads, _, _, source = extract_specs.read_table(None, renders, PdfProfile(), sheet, 0.85, settings)
    assert source == "ocr"
