"""End-to-end offline extraction on the sample, plus keyline, inks and fallback units."""

from pathlib import Path

import pytest
from PIL import Image

from app.config import Settings
from app.ocr import fallback, keyline
from app.ocr.table import FieldRead
from app.ocr.template import SpecTemplate
from app.pdf.layers import Box, read_facts
from app.pdf.profile import PdfProfile
from app.pdf.vector import dieline, horizontal_rules, ink_dots
from app.specs.schema import GussetType
from app.specs.validate import ValidationRules
from app.steps import extract_specs
from app.storage import LocalStorage
from tests.conftest import COMBINED, NON_ARTPRO, SAMPLE, needs_poppler, needs_tesseract


def test_dieline_geometry_is_exact():
    line = dieline(SAMPLE, ["Dimensions and text"], read_facts(SAMPLE).trim_box)
    assert line.x_mm == pytest.approx([0, 2.2375, 12.2375, 232.2375, 242.2375, 244.475], abs=0.002)
    assert line.y_mm == pytest.approx([0, 4, 14, 26, 39, 306, 316, 320], abs=0.01)  # the notch line is drawn at 25.996
    assert line.zipper_y_mm == pytest.approx([32.0], abs=1.0)  # 28 mm below the finished top


def test_ink_dots_found_as_vector_circles():
    dots = ink_dots(SAMPLE, ["Dynamic Marks"], (15, 40))
    assert len(dots) == 5
    assert dots[0].rgb[2] > 0.9 and dots[4].rgb[0] > 0.7  # cyan first, light grey (Sp White) last


def test_table_rules_split_rows():
    facts = read_facts(SAMPLE)
    region = Box(facts.media_box.x0, facts.media_box.y0, facts.trim_box.x0 - 85, facts.media_box.y1)
    assert len(horizontal_rules(SAMPLE, ["Dynamic Marks", "Footer1"], region, 0.9)) >= 20


def test_keyline_label_snapping():
    labels = keyline.LabelText(numbers=[2.2375, 4.0, 10.0, 12.0, 13.0, 220.0, 244.475, 267.0, 320.0], notch_text=None, labels=[])
    measured, _ = keyline.measure(SAMPLE, ["Dimensions and text"], read_facts(SAMPLE).trim_box, labels, 240, 312)
    assert measured.bleed_left_mm.value == 2.2375 and measured.bleed_left_mm.confidence == 0.99
    assert measured.width_segments_mm.value == [10, 220, 10]
    assert measured.height_segments_mm.value == [10, 12, 13, 267, 10]
    assert measured.zipper_y_mm == pytest.approx([28.0], abs=1.0)


def test_keyline_without_label_confirmation_is_low_confidence():
    labels = keyline.LabelText(numbers=[2.2375, 4.0, 10.0, 220.0], notch_text=None, labels=[])  # 12, 13, 267 missing
    measured, _ = keyline.measure(SAMPLE, ["Dimensions and text"], read_facts(SAMPLE).trim_box, labels, 240, 312)
    assert measured.height_segments_mm.confidence < 0.85
    assert measured.width_segments_mm.confidence == 0.99


def test_keyline_pair_follows_spec_size():
    labels = keyline.LabelText(numbers=[], notch_text=None, labels=[])
    measured, _ = keyline.measure(SAMPLE, ["Dimensions and text"], read_facts(SAMPLE).trim_box, labels, 250, 312)
    assert measured.bleed_left_mm.value is None  # no two lines are 250 mm apart


@pytest.mark.parametrize("bands, centre", [
    ([10, 12, 13, 267, 10], 28.5),  # FGPO7215 (track drawn at 28)
    ([10, 9, 3, 13, 250, 10], 28.5),  # FGPO7404: the 3 mm band is a gap, the 13 mm band the zipper
    ([10, 7, 13, 170, 10], 23.5),  # FGPO7535
    ([20, 13, 221, 10], 26.5),  # FGPO7002: tear line at 20, then the zipper band
    ([10, 220, 10], None),  # no bands above the body
])
def test_zipper_band_centre(bands, centre):
    assert keyline.zipper_band_centre(bands) == centre


def test_fallback_none_sends_nothing():
    reads = {"sealing_type": FieldRead("sealing_type", None, None, 0.0, False, (0, 0, 10, 10))}
    assert fallback.apply(Image.new("L", (20, 20)), reads, SpecTemplate(), 0.85, Settings(vision_fallback="none")) == []


def test_fallback_answer_still_goes_through_format_rules(monkeypatch):
    answers = iter([fallback.CellAnswer(value="Stand up", confidence=0.99), fallback.CellAnswer(value="banana", confidence=0.99)])
    monkeypatch.setitem(fallback.PROVIDERS, "groq", lambda image, label, settings: next(answers))
    reads = {
        "sealing_type": FieldRead("sealing_type", None, None, 0.0, False, (0, 0, 10, 10)),
        "zipper": FieldRead("zipper", None, None, 0.0, False, (0, 0, 10, 10)),
    }
    changed = fallback.apply(Image.new("L", (20, 20)), reads, SpecTemplate(), 0.85, Settings(vision_fallback="groq", groq_api_key="gsk_x"))
    assert changed == ["sealing_type"]
    assert reads["sealing_type"].value == "Stand-up" and reads["sealing_type"].confidence == 0.95
    assert reads["zipper"].value is None  # "banana" is not yes/no


def test_groq_request_and_failures(monkeypatch):
    """Groq: an OpenAI-style request with the image as a data URL; no key = skipped; a failed call
    leaves the cell weak instead of failing the job."""
    import httpx

    from app.ocr import groq

    sent = {}

    def fake_post(url, headers, json, timeout):
        sent.update(url=url, headers=headers, body=json)
        return httpx.Response(200, request=httpx.Request("POST", url), json={"choices": [{"message": {"content": '{"value": "Stand up", "confidence": 0.97}'}}]})

    monkeypatch.setattr(groq.httpx, "post", fake_post)
    weak = lambda: {"sealing_type": FieldRead("sealing_type", None, None, 0.0, False, (0, 0, 10, 10))}  # noqa: E731
    reads = weak()
    assert fallback.apply(Image.new("L", (20, 20)), reads, SpecTemplate(), 0.85, Settings(vision_fallback="groq", groq_api_key="")) == []
    assert not sent  # no key: nothing sent
    changed = fallback.apply(Image.new("L", (20, 20)), reads, SpecTemplate(), 0.85,
                             Settings(vision_fallback="groq", groq_api_key="gsk_test", groq_model="some-vision-model"))
    assert changed == ["sealing_type"] and reads["sealing_type"].value == "Stand-up" and reads["sealing_type"].source == "groq"
    assert sent["url"] == "https://api.groq.com/openai/v1/chat/completions" and sent["headers"]["Authorization"] == "Bearer gsk_test"
    content = sent["body"]["messages"][0]["content"]
    image = next(part for part in content if part["type"] == "image_url")
    assert sent["body"]["model"] == "some-vision-model" and image["image_url"]["url"].startswith("data:image/png;base64,")

    def failing_post(url, headers, json, timeout):
        return httpx.Response(429, request=httpx.Request("POST", url), json={"error": "rate limited"})

    monkeypatch.setattr(groq.httpx, "post", failing_post)
    reads = weak()
    assert fallback.apply(Image.new("L", (20, 20)), reads, SpecTemplate(), 0.85, Settings(vision_fallback="groq", groq_api_key="gsk_test")) == []
    assert reads["sealing_type"].value is None


def test_confirm_with_filename():
    reads = {
        "item_name": FieldRead("item_name", "FGPO7215 Dog Food Front_App", "FGPO7215 Dog Food Front_App", 0.4, True, None),
        "item_no": FieldRead("item_no", "FGPO7215", "FGPO7215", 0.8, True, None),
    }
    extract_specs.confirm_with_filename(reads, PdfProfile(), "FGPO7215_Dog_Food_Front_App (exported).pdf")
    assert reads["item_name"].value == "FGPO7215_Dog_Food_Front_App" and reads["item_name"].confidence == 0.95
    assert reads["item_no"].confidence == 0.95
    reads["item_no"] = FieldRead("item_no", "FGPO7216", "FGPO7216", 0.8, True, None)
    extract_specs.confirm_with_filename(reads, PdfProfile(), "FGPO7215_x.pdf")
    assert reads["item_no"].confidence == 0.8  # different code: not confirmed


@needs_poppler
@needs_tesseract
def test_sample_extraction_offline(tmp_path):
    """The expected result for FGPO7215 from the project spec, read with Tesseract only."""
    out = extract_specs.run(
        extract_specs.ExtractSpecsInput(pdf_path=SAMPLE, filename=SAMPLE.name, key_prefix="job", trim_width_mm=244.475, trim_height_mm=320.0),
        PdfProfile(), ValidationRules(), LocalStorage(tmp_path), settings=Settings(vision_fallback="none"),
    )
    t, m = out.sheet.spec_table, out.sheet.measured_keyline
    assert t.client_name.value == "Crystal Enterprises"
    assert t.item_no.value == "FGPO7215"
    assert (t.pouch_height_mm.value, t.pouch_closed_width_mm.value, t.pouch_open_width_mm.value) == (312, 240, 240)
    assert t.sealing_type.value == "Stand-up"
    assert t.gusset_type.value == GussetType.bottom and t.gusset_full_width_mm.value == 120
    assert t.sealing_width_mm.value == 10
    assert t.zipper.value is True and t.round_corner.value is True
    assert t.butterfly_notch.value is False and t.transparent_window.value is False
    assert t.tear_notch.value == "V Notch"
    assert t.finish.value.value == "matt"
    assert [(l.micron, l.material) for l in t.layers.value] == [(18, "MATT BOPP"), (12, "Met Pet"), (75, "Clear LDPE")]
    assert t.inks.value == ["Cyan", "Magenta", "Yellow", "Black", "Sp White"]
    assert (t.colour_count.value, t.ar_ups.value, t.ac_ups.value, t.b2b_width_mm.value) == (5, 2, 1, 330)
    assert out.sheet.linked_codes == {"back": "FGPO7216", "gusset": "FGPO7233"}
    assert (m.bleed_left_mm.value, m.bleed_right_mm.value, m.bleed_top_mm.value, m.bleed_bottom_mm.value) == (2.2375, 2.2375, 4, 4)
    assert m.width_segments_mm.value == [10, 220, 10]
    assert m.height_segments_mm.value == [10, 12, 13, 267, 10]
    assert not out.report.needs_review, [i for i in out.report.issues if i.severity == "review"]
    assert out.fallback_fields == []
    assert Path(tmp_path, "job", "spec_table.png").exists()
    assert out.mode == "layers" and out.text_source == "ocr" and out.layout.kind == "single"


@needs_poppler
@needs_tesseract
def test_combined_sheet_extraction(tmp_path):
    """FGPO7535 (Illustrator, no layers): front + gusset + back on one web, table as live text."""
    from app.steps import trim_artwork

    storage = LocalStorage(tmp_path)
    trim = trim_artwork.run(trim_artwork.TrimArtworkInput(pdf_path=COMBINED, filename=COMBINED.name, panel="front", key_prefix="job"),
                            PdfProfile(), storage)
    assert trim.mode == "separation" and (trim.trim_width_mm, trim.trim_height_mm) == pytest.approx((120.65, 506), abs=0.01)
    out = extract_specs.run(
        extract_specs.ExtractSpecsInput(pdf_path=COMBINED, filename=COMBINED.name, key_prefix="job", trim_width_mm=trim.trim_width_mm,
                                        trim_height_mm=trim.trim_height_mm, sheet_image_key=trim.bleed_key),
        PdfProfile(), ValidationRules(), storage, settings=Settings(vision_fallback="none"),
    )
    t, m = out.sheet.spec_table, out.sheet.measured_keyline
    assert out.text_source == "pdf_text"
    assert (t.client_name.value, t.item_name.value, t.item_no.value, t.date_of_approval.value) == ("Krunchify", "Strawberry", "FGPO7535", "19-09-2026")
    assert (t.colour_count.value, t.b2b_width_mm.value, t.inside_b2b_width_mm.value, t.teeth.value) == (6, 524, 514, 114)
    assert (t.ar_ups.value, t.ac_ups.value, t.circumference_mm.value) == (3, 1, 361.95)
    assert (t.pouch_height_mm.value, t.pouch_closed_width_mm.value, t.pouch_open_width_mm.value) == (210, 120.65, 420)
    assert [(l.micron, l.material) for l in t.layers.value] == [(25, "matt BOPP"), (6.5, "Foil"), (12, "pet"), (60, "LDPE")]
    assert t.inks.value == ["Cyan", "Magenta", "Yellow", "Black", "P 6053 C", "White"]
    assert (t.sealing_type.value, t.gusset_type.value, t.gusset_full_width_mm.value, t.sealing_width_mm.value) == ("Stand-up", GussetType.bottom, 80, 10)
    assert (t.zipper.value, t.round_corner.value, t.transparent_window.value, t.butterfly_notch.value) == (True, True, False, False)
    assert t.tear_notch.value == "V Notch" and t.finish.value.value == "matt"  # matt from Layer 1 "25 mic matt BOPP"
    assert out.sheet.linked_codes == {} and out.sheet.reference_codes == {"color match as per old": "FGPO3728"}
    # the sheet: front (upright), 3 mm strip, gusset, 3 mm strip, back (upside down)
    assert out.layout.kind == "multi"
    assert [(p.role, p.kind, p.y_mm, p.height_mm, p.rotation) for p in out.layout.panels] == [
        ("front", "face", 0, 210, 0), (None, "gusset", 213, 80, 0), ("back", "face", 296, 210, 180)]
    assert out.layout.front_words["second"] > 5 * out.layout.front_words["first"]  # the back carries the small print
    # the front measured on its own: exact edges, bands confirmed by the printed labels
    assert (m.overall_width_mm.value, m.overall_height_mm.value) == (120.65, 210)
    assert (m.bleed_left_mm.value, m.bleed_right_mm.value, m.bleed_top_mm.value, m.bleed_bottom_mm.value) == (0, 0, 0, 0)
    assert m.width_segments_mm.value == [10, 100.65, 10] and m.height_segments_mm.value == [10, 7, 13, 170, 10]
    assert m.zipper_from_band and m.zipper_y_mm == [23.5]
    assert not out.report.needs_review, [i for i in out.report.issues if i.severity == "review"]


@needs_poppler
def test_text_layer_only_never_runs_ocr(tmp_path):
    """`ocr: off`: a live-text sheet (FGPO7535) reads the same from its text layer alone, table cells
    included; a sheet with outlined text (FGPO7138) reads nothing and goes to the details form."""
    from app.steps import trim_artwork
    from tests.conftest import ROLL

    profile = PdfProfile(ocr="off")
    storage = LocalStorage(tmp_path)
    trim = trim_artwork.run(trim_artwork.TrimArtworkInput(pdf_path=COMBINED, filename=COMBINED.name, panel="front", key_prefix="a"), profile, storage)
    out = extract_specs.run(
        extract_specs.ExtractSpecsInput(pdf_path=COMBINED, filename=COMBINED.name, key_prefix="a", trim_width_mm=trim.trim_width_mm,
                                        trim_height_mm=trim.trim_height_mm, sheet_image_key=trim.bleed_key),
        profile, ValidationRules(), storage, settings=Settings(vision_fallback="none"),
    )
    t = out.sheet.spec_table
    assert out.text_source == "pdf_text" and out.tesseract_version == "not used"
    assert (t.client_name.value, t.item_no.value, t.pouch_height_mm.value, t.pouch_closed_width_mm.value) == ("Krunchify", "FGPO7535", 210, 120.65)
    assert (t.sealing_type.value, t.gusset_type.value, t.gusset_full_width_mm.value, t.inside_b2b_width_mm.value) == ("Stand-up", GussetType.bottom, 80, 514)
    # the dimension labels on this sheet are outlined (no text): with OCR off the dieline geometry stands alone
    assert out.sheet.measured_keyline.height_segments_mm.value == pytest.approx([10, 7, 13, 170, 10], abs=0.01)
    assert not out.report.needs_review, [i for i in out.report.issues if i.severity == "review"]

    trim = trim_artwork.run(trim_artwork.TrimArtworkInput(pdf_path=ROLL, filename=ROLL.name, panel="front", key_prefix="b"), profile, storage)
    out = extract_specs.run(
        extract_specs.ExtractSpecsInput(pdf_path=ROLL, filename=ROLL.name, key_prefix="b", trim_width_mm=trim.trim_width_mm, trim_height_mm=trim.trim_height_mm),
        profile, ValidationRules(), storage, settings=Settings(vision_fallback="none"),
    )
    assert out.text_source == "none" and out.tesseract_version == "not used"
    assert out.sheet.spec_table.pouch_height_mm.value is None and out.sheet.spec_table.client_name.value is None
    assert {i.code for i in out.report.issues if i.severity == "review"} >= {"missing"}


@needs_poppler
@needs_tesseract
def test_pillow_blanks_sheet_extraction(tmp_path):
    """FGPO7396: the artwork copy beside its technical preview; two centre-seal blanks (170 x 108) per copy;
    the spec table strip is the one with the table, not the largest one."""
    from app.steps import trim_artwork
    from tests.conftest import BLANKS

    storage = LocalStorage(tmp_path)
    trim = trim_artwork.run(trim_artwork.TrimArtworkInput(pdf_path=BLANKS, filename=BLANKS.name, panel="front", key_prefix="job"), PdfProfile(), storage)
    assert trim.mode == "separation" and (trim.trim_width_mm, trim.trim_height_mm) == pytest.approx((344.0, 111.12), abs=0.01)
    out = extract_specs.run(
        extract_specs.ExtractSpecsInput(pdf_path=BLANKS, filename=BLANKS.name, key_prefix="job", trim_width_mm=trim.trim_width_mm,
                                        trim_height_mm=trim.trim_height_mm, sheet_image_key=trim.bleed_key),
        PdfProfile(), ValidationRules(), storage, settings=Settings(vision_fallback="none"),
    )
    t, m = out.sheet.spec_table, out.sheet.measured_keyline
    assert (t.client_name.value, t.item_no.value, t.sealing_type.value, t.gusset_type.value) == ("Beejapuri Dairy Pvt. Ltd", "FGPO7396", "Center Seal", GussetType.none)
    assert (t.pouch_height_mm.value, t.pouch_closed_width_mm.value, t.pouch_open_width_mm.value, t.sealing_width_mm.value) == (108, 75, 170, 10)
    assert [(l.micron, l.material) for l in t.layers.value] == [(25, "Matt BOPP"), (12, "MET PET"), (60, "LDPE (Natural General)")]
    assert out.layout.kind == "multi" and out.layout.axis == "horizontal"
    assert [(p.kind, p.x_mm, p.width_mm, p.height_mm) for p in out.layout.panels] == [("blank", 2, 170, 108), ("blank", 172, 170, 108)]
    # the front box: the middle 75 mm of the first blank, seals 10 / 88 / 10 down its height
    assert (m.overall_width_mm.value, m.overall_height_mm.value) == (75, 108)
    assert m.width_segments_mm.value == [75] and m.height_segments_mm.value == [10, 88, 10]
    assert not out.report.needs_review, [i for i in out.report.issues if i.severity == "review"]


@needs_poppler
@needs_tesseract
def test_front_back_web_with_two_copies(tmp_path):
    """FGPO7492: no closed grid has one copy's extent (the copies share their end line); the relaxed
    dieline search finds both and the artwork copy is used. Front and back sit 13 mm apart."""
    from app.steps import trim_artwork
    from tests.conftest import FRONT_BACK

    storage = LocalStorage(tmp_path)
    trim = trim_artwork.run(trim_artwork.TrimArtworkInput(pdf_path=FRONT_BACK, filename=FRONT_BACK.name, panel="front", key_prefix="job"), PdfProfile(), storage)
    assert trim.mode == "separation" and trim.repeats == 2
    assert (trim.trim_width_mm, trim.trim_height_mm) == pytest.approx((156.63, 466.0), abs=0.01)
    out = extract_specs.run(
        extract_specs.ExtractSpecsInput(pdf_path=FRONT_BACK, filename=FRONT_BACK.name, key_prefix="job", trim_width_mm=trim.trim_width_mm,
                                        trim_height_mm=trim.trim_height_mm, sheet_image_key=trim.bleed_key),
        PdfProfile(), ValidationRules(), storage, settings=Settings(vision_fallback="none"),
    )
    t, m = out.sheet.spec_table, out.sheet.measured_keyline
    assert (t.client_name.value, t.item_no.value, t.gusset_type.value, t.gusset_full_width_mm.value) == ("Lake City Dry Fruits Pvt Ltd", "FGPO7492", GussetType.bottom, 80)
    assert (t.pouch_closed_width_mm.value, t.pouch_height_mm.value, t.pouch_open_width_mm.value, t.zipper.value) == (151, 225, 450, True)
    # the sheet draws only one of the two side-seal edge lines: the 151 mm faces are centred in the 156.63 mm web;
    # this web is joined at the top (the zipper and notch bands of the first face sit at the sheet's middle),
    # so the first face is the one drawn upside down
    assert out.layout.kind == "multi" and out.layout.axis == "vertical"
    assert [(p.kind, p.role, p.x_mm, p.width_mm, p.height_mm, p.rotation) for p in out.layout.panels] == [
        ("face", "front", 2.82, 151, 225, 180), ("face", "back", 2.82, 151, 225, 0)]
    assert (m.overall_width_mm.value, m.overall_height_mm.value) == (151, 225)
    segs = m.height_segments_mm.value
    assert segs[0] == 20 and segs[-1] == 10 and max(segs) == segs[-2]  # top seal 20, notch / zipper bands, body, bottom seal 10
    assert not [i for i in out.report.issues if i.severity == "review" and i.code in ("trim_width", "trim_height", "sheet_layout")]


@needs_poppler
@needs_tesseract
def test_illustrator_front_extraction(tmp_path):
    """FGPO6862 (Illustrator, no layers, single front with bleed): live text, value-addition dot."""
    out = extract_specs.run(
        extract_specs.ExtractSpecsInput(pdf_path=NON_ARTPRO, filename=NON_ARTPRO.name, key_prefix="job", trim_width_mm=165.1, trim_height_mm=248),
        PdfProfile(), ValidationRules(), LocalStorage(tmp_path), settings=Settings(vision_fallback="none"),
    )
    t, m = out.sheet.spec_table, out.sheet.measured_keyline
    assert out.mode == "separation" and out.text_source == "pdf_text" and out.layout.kind == "single"
    assert (t.client_name.value, t.item_no.value, t.pouch_height_mm.value, t.pouch_closed_width_mm.value) == ("Shree Balaji Traders", "FGPO6862", 240, 160)
    assert t.inks.value == ["Black", "Yellow", "Magenta", "Cyan", "White"]
    assert t.value_additions.value.startswith("Fully MATT Finish")  # the pink dot right of "Value Additions" is not an ink
    assert out.sheet.linked_codes == {"back": "FGPO6863", "gusset": "FGPO6864"}
    assert (m.bleed_left_mm.value, m.bleed_top_mm.value) == (2.55, 4)
    assert m.width_segments_mm.value == [10, 140, 10] and m.height_segments_mm.value == [10, 12, 13, 195, 10]
    assert m.zipper_line_drawn.value and m.zipper_y_mm == pytest.approx([28.0], abs=1.0)
    assert not out.report.needs_review, [i for i in out.report.issues if i.severity == "review"]
