"""The ArtPro+ spec table template: labels, value formats, cleanup rules (index section 3.4).

All of this is data. When the ArtPro+ template changes, an admin edits these entries in the
index; no code change is needed for a renamed label, a new option or a new cleanup rule.
"""

from typing import Literal

from pydantic import BaseModel, Field

ValueKind = Literal["text", "number", "integer", "yes_no", "option", "film", "code", "date"]


class FieldRule(BaseModel):
    field: str | None  # SpecTable field; None = a stop label that only ends the previous value
    label: str  # as printed, e.g. "Pouch height:"; matching ignores case, punctuation and spacing
    aliases: list[str] = []  # other printings of the same label (template variants); the longest match wins
    # Starts a block of the table (header, sizes, remarks, notes). Block starts are found in template
    # order, each below the previous one; every other label is searched only inside its own block,
    # in any order (sheets differ in how they arrange the cells of a block).
    section: bool = False
    kind: ValueKind = "text"
    options: list[str] = []  # canonical spellings for kind "option"
    # canonical option -> other printed spellings; a cell that reads as a synonym is stored as the
    # canonical option ("Standy" -> "Stand-up"), so rules only need the canonical spelling
    synonyms: dict[str, list[str]] = {}
    min: float | None = None
    max: float | None = None
    optional: bool = False  # a blank cell is a valid answer (value None)
    multiline: bool = False  # value continues on following rows until the next label
    keep_chars: str = ""  # characters to keep although the global cleanup strips them
    # The printed value repeats the PDF's file name ("stem") or its item code ("code"): if the
    # OCR text equals it ignoring spaces/underscores/case, the file's spelling is used and the
    # read is confirmed by two independent sources.
    confirm_with_filename: Literal["stem", "code"] | None = None

    def all_options(self) -> list[str]:
        out = list(self.options)
        for more in self.synonyms.values():
            out += [m for m in more if m not in out]
        return out

    def canonical(self, option: str) -> str:
        for canonical, more in self.synonyms.items():
            if option == canonical or option in more:
                return canonical
        return option


class SpecTemplate(BaseModel):
    fields: list[FieldRule] = Field(default_factory=lambda: list(DEFAULT_FIELDS))
    # Removed from every value (unless the field keeps them): OCR reads cell borders as | and _.
    strip_chars: str = "|_—¦[]{}"
    # Whole-word OCR fixes applied to label and value text before matching.
    word_fixes: dict[str, str] = {"ltem": "Item", "Iterm": "Item", "Colour:": "Color:", "Heignt:": "height:"}
    # Text removed from values wherever it appears (logos and printed boilerplate inside cells).
    noise_phrases: list[str] = ["GUJARAT PRINT PACK", "PUBLICATIONS PVT. LTD.", "PUBLICATIONS PVT LTD"]
    # Whole OCR words dropped before a value is built (regex, case-insensitive): the printer's logo
    # sits inside the Remarks row and OCR reads fragments of it.
    noise_words: list[str] = [r"GUJARAT\S*", r"PRINT", r"PACK", r"PUBLICATIONS?\S*", r"PVT\.?", r"LTD\.?"]
    # Short fragments (<= junk_max_chars letters/digits) below this confidence are OCR junk.
    junk_max_chars: int = 2
    junk_max_confidence: float = 0.7
    # Grayscale pixels darker than this become black before OCR (red remarks text included).
    binarize_threshold: int = 200
    # Horizontal rules spanning at least this share of the table width split it into OCR bands.
    band_rule_min_span: float = 0.9
    yes_words: list[str] = ["yes", "y"]
    no_words: list[str] = ["no", "n", "nil", "none", "-", "na", "n/a"]
    # Finish keywords searched in Remarks and Value Additions, first match wins.
    finish_keywords: dict[str, str] = {
        "matt with spot gloss": "matt+spot gloss",
        "matt + spot gloss": "matt+spot gloss",
        "spot gloss": "matt+spot gloss",
        "gloss with spot matt": "gloss+spot matt",
        "spot matt": "gloss+spot matt",
        "matt finish": "matt",
        "matte finish": "matt",
        "gloss finish": "gloss",
        "glossy": "gloss",
        "matt": "matt",
        "gloss": "gloss",
    }
    # No finish in Remarks / Value Additions: take it from Layer 1, the outer (printed) film, e.g.
    # "25 mic matt BOPP" -> matt. The same finish_keywords apply.
    finish_from_outer_layer: bool = True
    # Colour dots of the ink row: vector circles on these layers within this diameter range.
    ink_dot_layers: list[str] = ["Dynamic Marks"]
    ink_dot_diameter_mm: tuple[float, float] = (15.0, 40.0)
    ink_label_height_mm: float = 12.0  # band under each dot that holds its name (descenders included)
    # Known ink names; an OCR'd name within 0.8 similarity snaps to the listed spelling.
    known_inks: list[str] = ["Cyan", "Magenta", "Yellow", "Black", "Sp White", "White", "Gloss UV", "Matt UV"]
    # Longest straight stroke of a dimension-label glyph; longer runs are lines and get erased.
    dimension_label_max_stroke_mm: float = 5.0
    tesseract_lang: str = "eng"
    tesseract_psm: int = 4
    # Words/cells below this get an offline re-read (above the 0.85 review threshold on purpose,
    # so borderline reads get a second chance instead of flipping between runs).
    retry_below_confidence: float = 0.9


def _num(field: str, label: str, lo: float, hi: float, optional: bool = False) -> FieldRule:
    return FieldRule(field=field, label=label, kind="number", min=lo, max=hi, optional=optional)


def _yn(field: str, label: str) -> FieldRule:
    return FieldRule(field=field, label=label, kind="yes_no")


# Blocks in printed order (a `section` label starts each). Block starts are matched in this order,
# each below the previous one, and the other labels only inside their block, so boilerplate further
# down ("Eyemarks", "Sealing Width +/- 3 mm", "Gusset Code" in Remarks) cannot be mistaken for a field.
DEFAULT_FIELDS: list[FieldRule] = [
    FieldRule(field="client_name", label="Client Name:", section=True),
    FieldRule(field="item_name", label="Item Name:", keep_chars="_", confirm_with_filename="stem"),
    FieldRule(field="item_no", label="Item No.:", kind="code", confirm_with_filename="code"),
    FieldRule(field="inside_b2b_width_mm", label="In-Side B2B Width:", aliases=["Inside B2B Width:", "In-B2B Width:", "In B2B Width:"],
              kind="number", min=10, max=2000, optional=True),
    FieldRule(field="date_of_approval", label="Date of Approval:", kind="date"),
    _num("b2b_width_mm", "B2B Width:", 10, 2000, optional=True),
    FieldRule(field="colour_count", label="Color:", aliases=["No. of colours", "No. of colors", "Colours:", "Colors:"], kind="integer",
              min=1, max=12),
    _num("teeth", "Teeth:", 1, 1000, optional=True),
    _num("ar_ups", "AR Ups:", 1, 50, optional=True),
    _num("circumference_mm", "Circumference:", 10, 3000, optional=True),
    _num("ac_ups", "AC Ups:", 1, 50, optional=True),
    FieldRule(field="value_additions", label="Value Additions :", optional=True),
    FieldRule(field=None, label="Note that exact colour matching", section=True),
    _num("pouch_height_mm", "Pouch height:", 20, 1500),
    FieldRule(field="layer_1", label="Layer 1", kind="film"),
    _num("pouch_closed_width_mm", "Pouch Closed width:", 20, 1500),
    FieldRule(field="layer_2", label="Layer 2", kind="film", optional=True),
    _num("pouch_open_width_mm", "Pouch Open Width:", 20, 3000),
    FieldRule(field="layer_3", label="Layer 3", kind="film", optional=True),
    FieldRule(field="layer_4", label="Layer 4", kind="film", optional=True),
    FieldRule(field="pouch_or_roll_form", label="Pouch/Roll Form:", kind="option", options=["Pouch Form", "Roll Form"]),
    FieldRule(field="transparent_window", label="Transparent Window:", kind="yes_no"),
    FieldRule(
        field="sealing_type", label="Sealing Type:", kind="option",
        options=[
            "Stand-up", "Standy", "Standy+Zipper", "Stand-up+Zipper", "3 Side Seal", "Three Side Seal", "Center Seal", "Centre Seal",
            "Back Seal", "Pillow", "Side Gusset", "Flat Bottom", "Box Pouch", "8 Side Seal", "Quad Seal",
            "4 Side Seal", "Spout", "Shaped", "NA",  # NA: roll form, sealed on the customer's machine
        ],
        synonyms={"Stand-up": ["Standup", "Stand up"]},  # "Standup Pouch" (FGPO3970) is Stand-up
    ),
    _num("sealing_width_mm", "Sealing Width:", 2, 50, optional=True),
    FieldRule(field="gusset_type", label="Gusset", aliases=["Gusset Type:"], kind="option",
              options=["Bottom", "Bottom Gusset", "Side", "Side Gusset", "None", "No", "Yes", "NA"]),
    _num("gusset_full_width_mm", "Gusset Full Width:", 5, 800, optional=True),
    _yn("zipper", "Zipper?"),
    FieldRule(field="tear_notch", label="Tear Notch", kind="option", options=["V Notch", "Straight Notch", "Laser Score", "Yes", "No", "NA"]),
    _yn("round_corner", "Round Corner"),
    _yn("butterfly_notch", "Butterfly Notch"),
    FieldRule(field="raw_remarks", label="Remarks", multiline=True, optional=True, section=True),
    # Stop labels: printed text that ends the previous value but is not itself a field.
    FieldRule(field=None, label="Please review this document", section=True),
    FieldRule(field=None, label="Tolerances"),
    FieldRule(field=None, label="Other Notes"),
]
