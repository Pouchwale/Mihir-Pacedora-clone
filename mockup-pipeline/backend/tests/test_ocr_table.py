"""Label-dictionary parsing on synthetic OCR words (no Tesseract needed)."""

import pytest

from app.ocr.table import FieldRead, normalize_codes, parse_value, read_fields
from app.ocr.template import FieldRule, SpecTemplate
from app.ocr.tesseract import Word

TPL = SpecTemplate()


def row(y: int, *items: tuple[str, float], x: int = 10) -> list[Word]:
    """Words laid out left to right on one line from `x`; each item is (text, confidence)."""
    out = []
    for text, conf in items:
        w = 20 * len(text)
        out.append(Word(text, conf, x, y, w, 30))
        x += w + 15
    return out


def fields(words) -> dict[str, FieldRead]:
    return read_fields(words, TPL, image_width=3000)


def test_two_column_row_splits_at_next_label():
    r = fields(row(100, ("Pouch", .96), ("height:", .96), ("312", .95), ("mm", .95), ("Layer", .96), ("1", .96), ("18", .95), ("mic", .95), ("MATT", .95), ("BOPP", .95)))
    assert r["pouch_height_mm"].value == 312 and r["pouch_height_mm"].confidence == 0.95
    assert r["layer_1"].value == {"micron": 18, "material": "MATT BOPP"}


def test_longest_label_first_and_ocr_fixes():
    words = row(100, ("ltem", .9), ("No.:", .9), ("FGP07215", .91), ("In-Side", .9), ("B2B", .9), ("Width:", .9), ("320.00", .96))
    words += row(150, ("Date", .96), ("of", .96), ("Approval:", .96), ("21/08/2026", .96), ("B2B", .9), ("Width:", .9), ("330", .96), ("Color:", .97), ("5", .9))
    r = fields(words)
    assert r["item_no"].value == "FGPO7215"  # "ltem" fixed, O/0 normalised
    assert r["inside_b2b_width_mm"].value == 320 and r["b2b_width_mm"].value == 330
    assert r["colour_count"].value == 5


def test_label_matched_once_in_order_so_boilerplate_is_text():
    words = row(100, ("Gusset", .96), ("Bottom", .96), ("Gusset", .96), ("Full", .96), ("Width:", .96), ("120", .96), ("mm", .96))
    words += row(300, ("Remarks", .96), ("Back", .96), ("Code", .93), (":", .9), ("FGPO7216", .9))
    words += row(340, ("Gusset", .96), ("Code", .93), (":", .9), ("FGPO7233", .9), x=175)  # value column
    words += row(500, ("Please", .96), ("review", .96), ("this", .96), ("document", .96))
    words += row(700, ("Eyemarks", .96), ("are", .96), ("required", .96))
    r = fields(words)
    assert r["gusset_type"].value == "Bottom" and r["gusset_full_width_mm"].value == 120
    assert r["raw_remarks"].value == "Back Code FGPO7216 | Gusset Code FGPO7233"
    assert r["raw_remarks"].code_confidence == {"FGPO7216": 0.9, "FGPO7233": 0.9}


def _strawberry_header():
    """FGPO7535's header block: the same cells as FGPO7215, arranged differently."""
    words = row(100, ("Client", 1), ("Name:", 1), ("Krunchify", 1))
    words += row(150, ("Item", 1), ("No.:", 1), ("FGPO7535", 1), ("No.", 1), ("of", 1), ("colours", 1), ("6", 1))
    words += row(200, ("Date", 1), ("of", 1), ("Approval:", 1), ("19-09-2026", 1), ("B2B", 1), ("Width:", 1), ("524", 1),
                 ("Inside", 1), ("B2B", 1), ("Width:", 1), ("514", 1))
    words += row(250, ("Note", 1), ("that", 1), ("exact", 1), ("colour", 1), ("matching", 1))
    words += row(300, ("Gusset", 1), ("Type:", 1), ("Bottom", 1), ("Gusset", 1), ("Full", 1), ("Width:", 1), ("80", 1), ("mm", 1))
    return words


def test_blocks_and_aliases_read_a_rearranged_table():
    r = fields(_strawberry_header())
    assert r["colour_count"].value == 6  # "No. of colours", printed before "Date of Approval"
    assert (r["b2b_width_mm"].value, r["inside_b2b_width_mm"].value) == (524, 514)
    assert r["date_of_approval"].value == "19-09-2026"
    assert r["gusset_type"].value == "Bottom" and r["gusset_full_width_mm"].value == 80  # "Gusset Type:" wins over "Gusset"


def test_label_token_inside_a_value_word_is_not_a_label():
    """FGPO7404: 'Sealing Type: Standy+Zipper' - the 'Zipper' inside the value is not the 'Zipper?' label."""
    words = row(100, ("Sealing", 1), ("Type:", 1), ("Standy+Zipper", .89), ("Sealing", 1), ("Width:", 1), ("10", 1))
    words += row(150, ("Gusset", 1), ("Bottom", 1), ("Gusset", 1), ("Gusset", 1), ("Full", 1), ("Width:", 1), ("110", 1))
    words += row(200, ("Zipper?", 1), ("Yes", 1), ("Tear", 1), ("Notch", 1), ("V", 1), ("Notch", 1))
    words += row(250, ("Layer", 1), ("1", 1), ("25", 1), ("Matt", 1), ("BOPP", 1))
    r = fields(words)
    assert r["sealing_type"].value == "Standy+Zipper" and r["sealing_width_mm"].value == 10
    assert r["gusset_type"].value == "Bottom Gusset" and r["gusset_full_width_mm"].value == 110
    assert r["zipper"].value is True and r["tear_notch"].value == "V Notch"
    assert r["layer_1"].value == {"micron": 25, "material": "Matt BOPP"}  # no "mic" printed


def test_template_without_blocks_keeps_the_old_order_rule():
    old = SpecTemplate(fields=[f.model_copy(update={"section": False, "aliases": []}) for f in TPL.fields])
    r = read_fields(_strawberry_header(), old, image_width=3000)
    assert r["colour_count"].value is None  # "Color:" is not printed; never searched above the last match


def test_noise_words_dropped_before_scoring():
    words = row(100, ("Remarks", .96), ("Matt", .96), ("Finish", .96), ("GUJARAT", .95), ("PI", .4), ("“a", .0))
    words += row(400, ("Please", .96), ("review", .96), ("this", .96), ("document", .96))
    r = fields(words)
    assert r["raw_remarks"].value == "Matt Finish" and r["raw_remarks"].confidence == 0.96


def test_missing_label_is_zero_confidence():
    r = fields(row(100, ("Client", .96), ("Name:", .96), ("Crystal", .96), ("Enterprises", .96)))
    assert r["client_name"].value == "Crystal Enterprises"
    assert r["sealing_type"].confidence == 0 and "not found" in r["sealing_type"].reason


def test_blank_optional_vs_required():
    r = fields(row(100, ("Value", .96), ("Additions", .96), (":", .9)) + row(200, ("Sealing", .96), ("Type:", .96)))
    assert r["value_additions"].value is None and r["value_additions"].confidence == 0.9
    assert r["sealing_type"].value is None and r["sealing_type"].confidence == 0.0


@pytest.mark.parametrize("rule, text, expected", [
    (FieldRule(field="x", label="x", kind="number", min=20, max=1500), "312 mm", (312, True)),
    (FieldRule(field="x", label="x", kind="number", min=20, max=1500), "3l2 mm", (312, True)),
    (FieldRule(field="x", label="x", kind="number", min=20, max=1500), "5 mm", (5, False)),
    (FieldRule(field="x", label="x", kind="number", min=5, max=800), "60+60 mm (120 One Side)", (120, True)),
    (FieldRule(field="x", label="x", kind="yes_no"), "Yes", (True, True)),
    (FieldRule(field="x", label="x", kind="yes_no"), "maybe", (None, False)),
    (FieldRule(field="x", label="x", kind="option", options=["V Notch", "No"]), "(V Notch)", ("V Notch", True)),
    (FieldRule(field="x", label="x", kind="option", options=["Stand-up"]), "Stand up", ("Stand-up", True)),
    (FieldRule(field="x", label="x", kind="option", options=["Stand-up"]), "Pillow", ("Pillow", False)),
    (FieldRule(field="x", label="x", kind="film"), "12 mic Met Pet", ({"micron": 12, "material": "Met Pet"}, True)),
    (FieldRule(field="x", label="x", kind="code"), "FGP07216", ("FGPO7216", True)),
    (FieldRule(field="x", label="x", kind="code"), "FGP0O7216", ("FGP0O7216", False)),
    (FieldRule(field="x", label="x", kind="date"), "21/08/2026", ("21/08/2026", True)),
])
def test_parse_value(rule, text, expected):
    assert parse_value(rule, text, TPL) == expected


def test_normalize_codes():
    assert normalize_codes("Back Code : FGP07216 | fgpo7233") == "Back Code : FGPO7216 | FGPO7233"
