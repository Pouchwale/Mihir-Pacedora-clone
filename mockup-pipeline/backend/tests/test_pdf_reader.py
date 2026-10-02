"""Reading the spec table from the PDF's own text: table cells (PyMuPDF), dimension labels from
words, and the `ocr` profile switch that keeps Tesseract out of it."""

import pytest

from app.ocr import pdf_table
from app.ocr.keyline import labels_from_words
from app.ocr.table import FieldRead, read_fields
from app.ocr.template import SpecTemplate
from app.ocr.tesseract import Word
from app.pdf.profile import PdfProfile
from app.specs.validate import ValidationRules
from app.steps import extract_specs
from app.storage import LocalStorage
from tests.conftest import BLANKS, COMBINED, ROLL, needs_poppler, needs_tesseract

TPL = SpecTemplate()

CELLS = [[
    ["Client Name:", "Krunchify", "", ""],
    ["Item No.:", "FGPO7535", "No. of colours", "6"],
    ["Date of Approval:", "19-09-2026", "B2B Width:", "524 Inside B2B Width: 514"],
], [
    ["Pouch height:", "", "210 mm", "Layer 1", "25 mic matt BOPP"],
    ["Layer 4 60 mic LDPE", "", "", "", ""],
    ["Sealing Type:", "", "Standup", "Sealing Width:", "10mm"],
    ["Gusset Type:", "", "Bottom", "Gusset Full Width:", "80 mm"],
    ["Zipper?", "", "Yes", "Tear Notch", "(V Notch)"],
]]


def test_cells_give_label_and_value_pairs():
    found = pdf_table.read_cells(CELLS, TPL)
    assert found["client_name"][1] == "Krunchify" and found["item_no"][1] == "FGPO7535" and found["colour_count"][1] == "6"
    # a value cell that carries the next label: split at that label, both fields served
    assert found["b2b_width_mm"][1] == "524" and found["inside_b2b_width_mm"][1] == "514"
    # label and value in one cell; the longer label wins over its prefix ("Gusset Type:" not "Gusset")
    assert found["layer_4"][1] == "60 mic LDPE" and found["gusset_type"][1] == "Bottom" and found["gusset_full_width_mm"][1] == "80 mm"
    assert found["pouch_height_mm"][1] == "210 mm" and found["sealing_type"][1] == "Standup" and found["tear_notch"][1] == "(V Notch)"


def test_merge_fills_blanks_and_flags_disagreements():
    reads = read_fields([], TPL, 1000)  # nothing read by word positions
    taken = pdf_table.merge(reads, pdf_table.read_cells(CELLS, TPL), TPL)
    assert "pouch_height_mm" in taken and reads["pouch_height_mm"].value == 210 and reads["pouch_height_mm"].confidence == 1.0
    assert reads["pouch_height_mm"].source == "pdf_table" and reads["gusset_full_width_mm"].value == 80
    # a confident word-position read that disagrees with the cell is not overwritten but doubted
    reads["pouch_height_mm"] = FieldRead("pouch_height_mm", "270", 270.0, 0.95, True, None, "", "pdf_text")
    pdf_table.merge(reads, pdf_table.read_cells(CELLS, TPL), TPL)
    assert reads["pouch_height_mm"].value == 270 and reads["pouch_height_mm"].confidence == 0.7 and "table cell" in reads["pouch_height_mm"].reason


def test_dimension_labels_from_words():
    words = [Word("2.2375", 1.0, 10, 5, 30, 10), Word("244.475", 1.0, 500, 2, 40, 10), Word("V", 1.0, 5, 300, 8, 10),
             Word("NOTCH", 1.0, 5, 312, 30, 10), Word("4", 1.0, 5, 500, 10, 10), Word("312", 1.0, 990, 400, 30, 10),
             Word("artwork", 1.0, 400, 400, 60, 12), Word("99", 1.0, 400, 400, 60, 12), Word("10", 1.0, 400, 995, 20, 10)]
    labels = labels_from_words(words, (100, 20, 900, 980))
    assert labels.numbers == [2.2375, 4.0, 10.0, 244.475, 312.0]  # the 99 inside the artwork is not a label
    assert labels.notch_text == "NOTCH"
    assert {(lab.axis, lab.position) for lab in labels.labels} == {("horizontal", "top"), ("vertical", "left"), ("vertical", "right"), ("horizontal", "bottom")}


@needs_poppler
def test_text_layer_only_reads_the_illustrator_sheet_without_ocr(tmp_path):
    """FGPO7535 keeps its text live: with OCR switched off every value still comes from the PDF itself."""
    from app.steps import trim_artwork

    profile = PdfProfile(ocr="off")
    storage = LocalStorage(tmp_path)
    trim = trim_artwork.run(trim_artwork.TrimArtworkInput(pdf_path=COMBINED, filename=COMBINED.name, panel="front", key_prefix="job"), profile, storage)
    out = extract_specs.run(extract_specs.ExtractSpecsInput(pdf_path=COMBINED, filename=COMBINED.name, key_prefix="job", trim_width_mm=trim.trim_width_mm,
                                                            trim_height_mm=trim.trim_height_mm, sheet_image_key=trim.bleed_key), profile, ValidationRules(), storage)
    t = out.sheet.spec_table
    assert out.text_source == "pdf_text" and out.tesseract_version == "not used"
    assert (t.pouch_height_mm.value, t.pouch_closed_width_mm.value, t.pouch_open_width_mm.value, t.gusset_full_width_mm.value) == (210, 120.65, 420, 80)
    assert (t.client_name.value, t.item_no.value, t.sealing_type.value, t.zipper.value) == ("Krunchify", "FGPO7535", "Stand-up", True)
    assert not any(c.source.startswith("ocr") for c in out.cells.values())  # pdf_text, pdf_text+filename, pdf_table, ink_row
    # this sheet's dimension labels are outlined (no text): with OCR off the dieline geometry stands
    # on its own, exact to the micrometre and not held for review
    m = out.sheet.measured_keyline
    assert m.height_segments_mm.value == pytest.approx([10, 7, 13, 170, 10], abs=0.01) and m.height_segments_mm.confidence == 0.9
    assert not out.report.needs_review, [i for i in out.report.issues if i.severity == "review"]


@needs_poppler
def test_outlined_text_with_ocr_off_leaves_the_fields_unread(tmp_path):
    """FGPO7138 has no text layer: with OCR off nothing is guessed; the job would pause for the details."""
    from app.steps import trim_artwork

    profile = PdfProfile(ocr="off")
    storage = LocalStorage(tmp_path)
    trim = trim_artwork.run(trim_artwork.TrimArtworkInput(pdf_path=ROLL, filename=ROLL.name, panel="front", key_prefix="job"), profile, storage)
    out = extract_specs.run(extract_specs.ExtractSpecsInput(pdf_path=ROLL, filename=ROLL.name, key_prefix="job", trim_width_mm=trim.trim_width_mm,
                                                            trim_height_mm=trim.trim_height_mm, sheet_image_key=trim.bleed_key), profile, ValidationRules(), storage)
    t = out.sheet.spec_table
    assert out.text_source == "none" and out.tesseract_version == "not used"
    assert t.pouch_height_mm.value is None and t.client_name.value is None and t.item_no.value is None
    assert {i.code for i in out.report.issues if i.severity == "review"} >= {"missing"}


@needs_poppler
@needs_tesseract
def test_ocr_always_still_reads_the_live_text_sheet(tmp_path):
    from app.steps import trim_artwork

    profile = PdfProfile(ocr="always")
    storage = LocalStorage(tmp_path)
    trim = trim_artwork.run(trim_artwork.TrimArtworkInput(pdf_path=BLANKS, filename=BLANKS.name, panel="front", key_prefix="job"), profile, storage)
    out = extract_specs.run(extract_specs.ExtractSpecsInput(pdf_path=BLANKS, filename=BLANKS.name, key_prefix="job", trim_width_mm=trim.trim_width_mm,
                                                            trim_height_mm=trim.trim_height_mm, sheet_image_key=trim.bleed_key), profile, ValidationRules(), storage)
    assert out.text_source == "ocr" and (out.sheet.spec_table.pouch_height_mm.value, out.sheet.spec_table.pouch_closed_width_mm.value) == (108, 75)


@pytest.mark.parametrize("mode", ["auto", "off", "always"])
def test_profile_accepts_the_ocr_modes(mode):
    assert PdfProfile(ocr=mode).ocr == mode
    with pytest.raises(ValueError):
        PdfProfile(ocr="sometimes")
