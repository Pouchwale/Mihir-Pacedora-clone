"""Typed spec sheet read from an approval PDF (spec 2.2).

`SpecSheet` is what the rest of the system uses: spec table + measured keyline + linked panel
codes. Every value carries a confidence (OCR word confidence and format checks); `None` means
"not present / unreadable", never a guess.
"""

from enum import Enum

from pydantic import BaseModel, Field


class Str(BaseModel):
    value: str | None
    confidence: float


class Num(BaseModel):
    value: float | None
    confidence: float


class Bool(BaseModel):
    value: bool | None
    confidence: float


class StrList(BaseModel):
    value: list[str]
    confidence: float


class NumList(BaseModel):
    value: list[float]
    confidence: float


class FilmLayer(BaseModel):
    micron: float | None
    material: str


class FilmLayers(BaseModel):
    value: list[FilmLayer]
    confidence: float


class GussetType(str, Enum):
    bottom = "Bottom"
    side = "Side"
    none = "None"
    yes = "Yes"  # gusset present, position not stated


class GussetTypeField(BaseModel):
    value: GussetType | None
    confidence: float


class Finish(str, Enum):
    matt = "matt"
    gloss = "gloss"
    matt_spot_gloss = "matt+spot gloss"
    gloss_spot_matt = "gloss+spot matt"


class FinishField(BaseModel):
    value: Finish | None
    confidence: float


class SpecTable(BaseModel):
    client_name: Str
    item_name: Str
    item_no: Str
    date_of_approval: Str = Field(description="As printed, e.g. 21/08/2026")
    teeth: Num
    circumference_mm: Num
    inside_b2b_width_mm: Num
    b2b_width_mm: Num
    colour_count: Num = Field(description="The 'Color:' number in the table")
    ar_ups: Num
    ac_ups: Num
    inks: StrList = Field(description="Ink names printed under the colour dots, left to right")
    value_additions: Str
    pouch_height_mm: Num
    pouch_closed_width_mm: Num
    pouch_open_width_mm: Num
    layers: FilmLayers = Field(description="Laminate layers in order Layer 1, 2, 3...")
    pouch_or_roll_form: Str
    sealing_type: Str
    gusset_type: GussetTypeField
    gusset_full_width_mm: Num
    zipper: Bool
    round_corner: Bool
    transparent_window: Bool
    sealing_width_mm: Num
    tear_notch: Str = Field(description="Text as printed, e.g. 'V Notch', 'Yes', 'No'")
    butterfly_notch: Bool
    finish: FinishField = Field(description="From Remarks or Value Additions; null if not stated")
    raw_remarks: Str = Field(description="Remarks text verbatim, line breaks as ' | '")
    # Shrink sleeves: the flat tube's width ("LAY-FLAT 86.5 mm" / "CLOSE WIDTH 148.5 mm"), half the
    # container's circumference (app.services.sleeve). Not in the pouch table.
    sleeve_layflat_mm: Num = Num(value=None, confidence=0.0)


class DimensionLabel(BaseModel):
    text: str = Field(description="Label as printed, e.g. '12', 'V NOTCH 3mm', '2.2375 Trim'")
    value_mm: float | None
    axis: str = Field(description="'horizontal' or 'vertical'")
    position: str = Field(description="Where it sits, e.g. 'right side, 3rd from top'")


class MeasuredKeyline(BaseModel):
    """Numbers printed on the dimension lines around the artwork."""

    overall_width_mm: Num = Field(description="Full width including bleed, e.g. 244.475")
    overall_height_mm: Num = Field(description="Full height including bleed, e.g. 320")
    bleed_left_mm: Num
    bleed_right_mm: Num
    bleed_top_mm: Num
    bleed_bottom_mm: Num
    width_segments_mm: NumList = Field(description="Finished width split left to right, excluding bleed, e.g. [10, 220, 10]")
    height_segments_mm: NumList = Field(description="Finished height split top to bottom, excluding bleed")
    zipper_line_drawn: Bool = Field(description="True if a zipper track is drawn on the dieline")
    zipper_y_mm: list[float] = Field(default_factory=list, description="Zipper track centre, mm from the finished top edge")
    zipper_from_band: bool = Field(False, description="No track drawn: zipper_y_mm is the middle of the dieline's zipper band")
    spout_position: str | None = Field(None, description="Corner the dieline's diagonal cuts off for the spout: top_left_corner / top_right_corner")
    valve_panel: str | None = Field(None, description="Panel a 'valve' label over the dieline marks (coffee degassing valve): front / back")
    valve_x_mm: float | None = Field(None, description="Valve centre from that panel's left edge, as printed")
    valve_y_mm: float | None = Field(None, description="Valve centre below the finished top edge (the dimension under the label)")
    labels: list[DimensionLabel] = Field(default_factory=list, description="Every dimension label number OCR read")


class Extraction(BaseModel):
    spec_table: SpecTable
    measured_keyline: MeasuredKeyline


class CellRead(BaseModel):
    """How one spec-table field was read, for the review form (highlight the cell, show raw OCR)."""

    raw: str | None
    confidence: float
    format_ok: bool
    bbox_px: tuple[int, int, int, int] | None  # in the stored spec_table.png
    source: str  # "ocr", "ocr_cell", "pdf_text", "pdf_table", "claude", "grok", "groq"
    reason: str = ""


class SpecSheet(BaseModel):
    spec_table: SpecTable
    measured_keyline: MeasuredKeyline
    linked_codes: dict[str, str]  # panel role -> item code, parsed from raw_remarks via the PDF profile
    # OCR confidence per linked code. link_panels confirms a code by finding its PDF in the file
    # registry; a code that is not found goes to NEEDS_REVIEW there (spec 2.3).
    linked_code_confidence: dict[str, float] = Field(default_factory=dict)
    # Codes of other jobs named in the remarks ("Color match as per old code : FGPO3728"): not panels.
    reference_codes: dict[str, str] = Field(default_factory=dict)
