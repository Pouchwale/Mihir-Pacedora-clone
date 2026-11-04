"""Option cells with OCR border noise: FGPO7570's "V Notch" read as "�Notch LJ" became "no notch"."""

from app.ocr.table import parse_value
from app.ocr.template import SpecTemplate

TPL = SpecTemplate()
TEAR = next(r for r in TPL.fields if r.field == "tear_notch").model_copy(
    update={"synonyms": {"V Notch": ["V-Notch", "Vnotch"], "Straight Notch": ["Straight"], "Laser Score": ["Laser"]}})


def test_noisy_cell_takes_the_one_option_whose_words_it_holds():
    assert parse_value(TEAR, "�Notch LJ", TPL) == ("V Notch", False)  # taken, but still sent to review
    assert parse_value(TEAR, "Straight Notch LJ", TPL)[0] == "Straight Notch"
    assert parse_value(TEAR, "Laser LJ", TPL)[0] == "Laser Score"


def test_clean_cells_and_real_garbage_are_unchanged():
    assert parse_value(TEAR, "V Notch", TPL) == ("V Notch", True)
    assert parse_value(TEAR, "NA", TPL) == ("NA", True)
    assert parse_value(TEAR, "garbage", TPL) == ("garbage", False)


def test_ocr_garbled_item_codes_are_repaired():
    from app.ocr.table import normalize_codes

    # FGPO7215's Remarks at 150 dpi: the back's code lost its G, so the back was never linked
    assert normalize_codes("Back Code F@PO7216 | Gusset Code FGPO7233") == "Back Code FGPO7216 | Gusset Code FGPO7233"
    assert normalize_codes("FGP07216 F6PO7216 FCPO7216") == "FGPO7216 FGPO7216 FGPO7216"
    assert normalize_codes("FCPO notes, F@PO12") == "FCPO notes, F@PO12"  # (not a code: too few digits)
