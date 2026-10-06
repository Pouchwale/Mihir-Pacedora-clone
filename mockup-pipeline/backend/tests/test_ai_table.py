"""The spec table read by an AI model (Settings.text_reader): request, parsing, format rules, fallback."""

import httpx
import pytest
from PIL import Image

from app.config import Settings
from app.ocr import ai_table, groq
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

    monkeypatch.setattr(groq.httpx, "post", fake_post)
    reads = ai_table.read(Image.new("RGB", (5000, 3000), "white"), TPL, "groq", Settings(groq_api_key="gsk_x", groq_model="m"))
    assert reads["pouch_height_mm"].value == 130
    assert sent["url"].startswith("https://api.groq.com/") and sent["headers"]["Authorization"] == "Bearer gsk_x" and sent["body"]["model"] == "m"
    image_part = sent["body"]["messages"][0]["content"][1]["image_url"]["url"]
    assert image_part.startswith("data:image/png;base64,")
    import base64
    import io
    sent_image = Image.open(io.BytesIO(base64.b64decode(image_part.split(",", 1)[1])))
    assert max(sent_image.size) == ai_table.MAX_PX  # shrunk before sending


def test_other_providers_are_not_offered():
    """Groq is the only AI service: any other reader name is refused before anything is sent."""
    for reader in ("openrouter", "claude", "grok"):
        with pytest.raises(ai_table.Unavailable, match="unknown text reader"):
            ai_table.read(Image.new("L", (10, 10)), TPL, reader, Settings(groq_api_key="gsk_x"))


def test_short_rate_limit_is_waited_out_once(monkeypatch):
    replies = iter([httpx.Response(429, json={"error": {"message": "Rate limit reached ... Please try again in 0.01s."}}),
                    httpx.Response(200, json={"choices": [{"message": {"content": '{"pouch_height_mm": "130"}'}}]})])
    monkeypatch.setattr(groq.httpx, "post", lambda url, headers, json, timeout: next(replies))
    reads = ai_table.read(Image.new("L", (10, 10)), TPL, "groq", Settings(groq_api_key="gsk_x"))
    assert reads["pouch_height_mm"].value == 130


@pytest.mark.parametrize("status,body", [(429, {"error": "rate limited"}), (200, {"choices": [{"message": {"content": "sorry, I cannot"}}]})])
def test_failures_are_unavailable(monkeypatch, status, body):
    monkeypatch.setattr(groq.httpx, "post", lambda url, headers, json, timeout: httpx.Response(status, json=body))
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


def _reply(status=200, headers=None, content='{"pouch_height_mm": "130"}'):
    return httpx.Response(status, headers=headers or {}, json={"choices": [{"message": {"content": content}}]} if status == 200 else {"error": "x"})


def test_same_image_is_answered_from_the_cache(monkeypatch):
    calls = []
    monkeypatch.setattr(groq.httpx, "post", lambda url, headers, json, timeout: calls.append(1) or _reply())
    settings = Settings(groq_api_key="gsk_x")
    for _ in range(3):
        assert ai_table.read(Image.new("L", (10, 10)), TPL, "groq", settings)["pouch_height_mm"].value == 130
    assert len(calls) == 1  # a rerun of the same PDF costs no Groq call


def test_calls_are_paced(monkeypatch):
    waits = []
    monkeypatch.setattr(groq, "_sleep", waits.append)
    monkeypatch.setattr(groq.httpx, "post", lambda url, headers, json, timeout: _reply())
    settings = Settings(groq_api_key="gsk_x", groq_rpm=20)
    for shade in (0, 1):  # two different images: two calls
        ai_table.read(Image.new("L", (10, 10), shade), TPL, "groq", settings)
    assert waits and 2.5 < waits[-1] <= 3.0  # 20 a minute = 3 s apart


def test_low_minute_tokens_wait_for_the_reset(monkeypatch):
    waits = []
    monkeypatch.setattr(groq, "_sleep", waits.append)
    replies = iter([_reply(headers={"x-ratelimit-remaining-tokens": "500", "x-ratelimit-reset-tokens": "7.5s"}), _reply()])
    monkeypatch.setattr(groq.httpx, "post", lambda url, headers, json, timeout: next(replies))
    settings = Settings(groq_api_key="gsk_x", groq_rpm=1000)
    for shade in (0, 1):
        ai_table.read(Image.new("L", (10, 10), shade), TPL, "groq", settings)
    assert waits and 7 < waits[-1] <= 7.6


def test_daily_quota_stops_calls_until_it_resets(monkeypatch):
    calls = []
    monkeypatch.setattr(groq.httpx, "post", lambda url, headers, json, timeout: calls.append(1) or _reply(429, {"retry-after": "3600"}))
    settings = Settings(groq_api_key="gsk_x", groq_max_wait_s=60)
    with pytest.raises(ai_table.Unavailable, match="rate limit"):
        ai_table.read(Image.new("L", (10, 10)), TPL, "groq", settings)
    with pytest.raises(ai_table.Unavailable, match="daily quota"):
        ai_table.read(Image.new("L", (10, 10), 5), TPL, "groq", settings)
    assert len(calls) == 1  # the second read did not even try


def test_groq_durations():
    assert groq._seconds("1m12.5s") == 72.5 and groq._seconds("250ms") == 0.25 and groq._seconds("3") == 3.0 and groq._seconds("") is None


def test_day_budget_stops_calls_before_groq_does(tmp_path, monkeypatch):
    """A 429 naming the day's token limit is remembered; once a call would pass it, none is made."""
    settings = Settings(groq_api_key="k", work_dir=tmp_path, text_reader="groq")
    msg = "Rate limit reached ... on tokens per day (TPD): Limit 10000, Used 9800, Requested 900. Please try again in 30m0s."
    calls = []

    def post(url, **kw):
        calls.append(1)
        return httpx.Response(429, text=msg, request=httpx.Request("POST", url))

    monkeypatch.setattr(groq.httpx, "post", post)
    with pytest.raises(groq.Unavailable):
        groq.chat(settings, "q", "aGVsbG8=")
    groq._State.blocked_until = 0.0  # a new process: only the usage file knows
    with pytest.raises(groq.Unavailable, match="day budget"):
        groq.chat(settings, "q2", "aGVsbG8=")
    assert len(calls) == 1
