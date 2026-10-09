"""Validation of an extracted spec sheet (spec 2.2). Reports issues; never changes a value."""

import re
from typing import Literal, Protocol

from pydantic import BaseModel

from app.specs.schema import Bool, FilmLayers, FinishField, GussetType, GussetTypeField, Num, NumList, SpecSheet, Str, StrList

ConfidenceField = Str | Num | Bool | StrList | NumList | FilmLayers | GussetTypeField | FinishField


class StandardSizeLike(Protocol):
    name: str
    width_mm: float
    height_mm: float
    tolerance_mm: float

    def distance(self, width: float | None, height: float | None) -> float | None: ...


class ValidationRules(BaseModel):
    """Index-editable thresholds (defaults per the spec)."""

    min_confidence: float = 0.85
    min_size_mm: float = 20
    max_size_mm: float = 1500
    trim_tolerance_mm: float = 2.0  # TrimBox vs pouch size + bleed
    keyline_tolerance_mm: float = 1.0  # dimension lines vs TrimBox
    # Size rules (spec 3, "Size rules"): how far two sources of the same measure may differ.
    dimension_tolerance_mm: float = 2.0  # dieline segments vs spec table sizes
    seal_tolerance_mm: float = 3.0  # dieline seal segments vs the table's sealing width
    zipper_tolerance_mm: float = 3.0  # zipper band vs a drawn zipper track
    open_width_check: bool = True  # open width must not be smaller than the closed width
    flag_nonstandard_sizes: bool = True  # warn when no standard size (index kind standard_size) matches
    default_bleed_mm: float = 4.0
    # Used when the field dictionary (index kind field) has no `required` flags of its own.
    required_fields: list[str] = [
        "client_name", "item_no", "pouch_height_mm", "pouch_closed_width_mm",
        "pouch_or_roll_form", "sealing_type", "gusset_type",
    ]


class Issue(BaseModel):
    code: str
    field: str
    message: str
    severity: Literal["review", "warning"] = "review"


class ValidationReport(BaseModel):
    issues: list[Issue]
    bleed_used: dict[str, float]
    bleed_source: Literal["measured", "default"]

    @property
    def needs_review(self) -> bool:
        return any(i.severity == "review" for i in self.issues)


def validate(
    sheet: SpecSheet,
    *,
    filename_code: str | None,
    trim_width_mm: float,
    trim_height_mm: float,
    item_code_pattern: str,
    rules: ValidationRules,
    layout_problem: str | None = None,
    page_mode: bool = False,
    roll_form: bool = False,
    required_fields: list[str] | None = None,
    field_confidence: dict[str, float] | None = None,
    standard_sizes: dict[str, "StandardSizeLike"] | None = None,
) -> ValidationReport:
    """`page_mode`: plain artwork without a dieline (nothing to measure against, the bleed comes from
    the page size). `roll_form`: the artwork area is one print repeat (repeat x web), not a pouch.
    `required_fields` / `field_confidence`: the field dictionary's flags (default: the rules').
    `standard_sizes`: index kind standard_size (nearest one is reported)."""
    t, m = sheet.spec_table, sheet.measured_keyline
    issues: list[Issue] = []
    thresholds = field_confidence or {}
    required = rules.required_fields if required_fields is None else required_fields

    def add(code: str, field: str, message: str, severity: Literal["review", "warning"] = "review") -> None:
        issues.append(Issue(code=code, field=field, message=message, severity=severity))

    soft: Literal["review", "warning"] = "warning" if page_mode else "review"  # drawing-based checks cannot be met without a drawing
    if layout_problem:
        # A multi-panel sheet is split with the table's height / width / gusset: check those values.
        add("sheet_layout", "pouch_height_mm", layout_problem)

    # Confidence on every field of both halves.
    for prefix, model in (("", t), ("measured_keyline.", m)):
        for name, value in model:
            threshold = thresholds.get(name, rules.min_confidence) if not prefix else rules.min_confidence
            if isinstance(value, ConfidenceField) and value.confidence < threshold:
                # Without a drawing the keyline halves are blank by nature (the bleed comes from the page),
                # and a plain page has no table cell to doubt: a blank read there is not a weak read.
                # A roll repeat's inner lines are not a pouch keyline. None of these blocks the job.
                blank = value.value in (None, "", [], 0.0)
                if name == "gusset_full_width_mm" and blank and t.gusset_type.value in (None, GussetType.none):
                    continue  # no gusset: a blank ("-") gusset width is the right answer, not a weak read
                if name == "sleeve_layflat_mm" and blank:
                    continue  # only shrink sleeves have a lay-flat width; a pouch table has none
                add("low_confidence", prefix + name, f"Confidence {value.confidence:.2f} < {threshold}",
                    "warning" if (prefix and roll_form) or (page_mode and blank) else "review")

    for name in required:
        field = getattr(t, name, None)
        if field is not None and getattr(field, "value", None) in (None, ""):
            add("missing", name, "Required value not found on the spec table")

    for name in ("pouch_height_mm", "pouch_closed_width_mm", "pouch_open_width_mm"):
        v = getattr(t, name).value
        if v is not None and not rules.min_size_mm <= v <= rules.max_size_mm:
            add("out_of_range", name, f"{v} mm is outside {rules.min_size_mm}-{rules.max_size_mm} mm")

    gusset, width = t.gusset_full_width_mm.value, t.pouch_closed_width_mm.value
    has_gusset = t.gusset_type.value not in (None, GussetType.none)
    if has_gusset and gusset is None:
        add("missing", "gusset_full_width_mm", f"Gusset type is {t.gusset_type.value.value} but no gusset width")
    if gusset is not None and width is not None and gusset >= width:
        add("gusset_too_wide", "gusset_full_width_mm", f"Gusset {gusset} mm is not smaller than width {width} mm")

    open_w = t.pouch_open_width_mm.value
    if rules.open_width_check and not roll_form and open_w is not None and width is not None and open_w < width - rules.dimension_tolerance_mm:
        add("open_lt_closed", "pouch_open_width_mm", f"Open width {open_w} mm is smaller than the closed width {width} mm")
    if (rules.open_width_check and not roll_form and open_w is not None and width is not None and gusset is not None
            and t.gusset_type.value == GussetType.side and abs(open_w - (width + gusset)) > rules.dimension_tolerance_mm
            and abs(open_w - width) > rules.dimension_tolerance_mm):
        add("open_vs_gusset", "pouch_open_width_mm", f"Open width {open_w} mm is neither the closed width {width} mm nor closed + side gusset "
            f"{width + gusset} mm", "warning")

    height = t.pouch_height_mm.value
    if standard_sizes and rules.flag_nonstandard_sizes and not roll_form and width is not None and height is not None:
        nearest = min(standard_sizes.items(), key=lambda kv: kv[1].distance(width, height) or 0)
        d = nearest[1].distance(width, height) or 0
        if d > nearest[1].tolerance_mm:
            add("nonstandard_size", "pouch_closed_width_mm", f"{width} x {height} mm matches no standard size; nearest is {nearest[1].name} "
                f"({nearest[1].width_mm} x {nearest[1].height_mm} mm)", "warning")

    if filename_code is None:
        # (a plain artwork page is a designer's file, not an approval sheet: its name follows no convention)
        add("filename_code", "item_no", "File name does not start with an item code", soft)
    elif t.item_no.value and t.item_no.value.strip().upper() != filename_code:
        add("item_no_mismatch", "item_no", f"Spec table says {t.item_no.value}, file name says {filename_code}")

    # Bleed: measured labels when all four are readable, else the index default.
    measured = [m.bleed_left_mm.value, m.bleed_right_mm.value, m.bleed_top_mm.value, m.bleed_bottom_mm.value]
    if all(v is not None for v in measured):
        bleed = dict(zip(("left", "right", "top", "bottom"), measured))
        source: Literal["measured", "default"] = "measured"
    else:
        bleed = dict.fromkeys(("left", "right", "top", "bottom"), rules.default_bleed_mm)
        source = "default"
        add("bleed_default", "measured_keyline.bleed", f"Bleed labels not readable; using default {rules.default_bleed_mm} mm", "warning")

    tol = rules.keyline_tolerance_mm
    if roll_form:
        # The artwork area is one print repeat: repeat = circumference / around-ups along one axis,
        # the printed web (in-side B2B width) along the other.
        circ, ups, web = t.circumference_mm.value, t.ar_ups.value, t.inside_b2b_width_mm.value
        repeat = circ / ups if circ and ups else None
        sizes = sorted((trim_width_mm, trim_height_mm))
        if repeat is not None and all(abs(s - repeat) > rules.trim_tolerance_mm for s in sizes):
            add("roll_repeat", "circumference_mm", f"Neither side of the dieline ({trim_width_mm:.2f} x {trim_height_mm:.2f} mm) is the print repeat "
                f"{repeat:.2f} mm (circumference {circ} / {ups:g} ups)", "warning")
        if web is not None and all(abs(s - web) > rules.trim_tolerance_mm for s in sizes):
            add("roll_web", "inside_b2b_width_mm", f"Neither side of the dieline ({trim_width_mm:.2f} x {trim_height_mm:.2f} mm) is the web width {web} mm", "warning")
    else:
        # TrimBox = finished front panel + bleed.
        if width is not None:
            expected = width + bleed["left"] + bleed["right"]
            if abs(trim_width_mm - expected) > rules.trim_tolerance_mm:
                add("trim_width", "pouch_closed_width_mm", f"TrimBox width {trim_width_mm:.3f} mm != {width} + bleed = {expected:.3f} mm")
        if height is not None:
            expected = height + bleed["top"] + bleed["bottom"]
            if abs(trim_height_mm - expected) > rules.trim_tolerance_mm:
                add("trim_height", "pouch_height_mm", f"TrimBox height {trim_height_mm:.3f} mm != {height} + bleed = {expected:.3f} mm")

        # Dimension lines vs TrimBox and vs spec table.
        for label, value, trim in (("overall_width_mm", m.overall_width_mm.value, trim_width_mm), ("overall_height_mm", m.overall_height_mm.value, trim_height_mm)):
            if value is not None and abs(value - trim) > tol:
                add("keyline_vs_trimbox", f"measured_keyline.{label}", f"Dimension label {value} mm != TrimBox {trim:.3f} mm")
        for label, segments, spec_value, spec_name in (
            ("width_segments_mm", m.width_segments_mm.value, width, "pouch_closed_width_mm"),
            ("height_segments_mm", m.height_segments_mm.value, height, "pouch_height_mm"),
        ):
            if not segments:
                add("missing", f"measured_keyline.{label}", "No dimension segments read", soft)
            elif spec_value is not None and abs(sum(segments) - spec_value) > rules.dimension_tolerance_mm:
                add("keyline_vs_spec", f"measured_keyline.{label}", f"Segments {segments} sum to {sum(segments)} mm, spec table says {spec_value} mm")

    seal = t.sealing_width_mm.value
    segs = m.width_segments_mm.value
    seal_tol = rules.seal_tolerance_mm
    if not roll_form and seal is not None and len(segs) >= 3 and (abs(segs[0] - seal) > seal_tol or abs(segs[-1] - seal) > seal_tol):
        add("side_seal_vs_spec", "sealing_width_mm", f"Side segments {segs[0]}/{segs[-1]} mm differ from sealing width {seal} mm", "warning")

    if t.zipper.value is True and m.zipper_line_drawn.value is False:
        if m.zipper_from_band and m.zipper_y_mm:
            add("zipper_from_band", "zipper", f"No zipper track drawn; zipper placed in the middle of the dieline's zipper band, "
                f"{m.zipper_y_mm[0]} mm from the top", "warning")
        else:
            add("zipper_not_drawn", "zipper", "Spec says zipper, but no zipper line on the dimension drawing", soft)

    # Linked panels.
    own = (t.item_no.value or "").strip().upper()
    for role, code in sheet.linked_codes.items():
        if not re.fullmatch(item_code_pattern, code):
            add("linked_code_format", f"linked_codes.{role}", f"{code} does not look like an item code")
        if code == own:
            add("linked_code_self", f"linked_codes.{role}", f"{role} code {code} is this item's own code")
    for role, conf in sheet.linked_code_confidence.items():
        if conf < rules.min_confidence:
            add("linked_code_unconfirmed", f"linked_codes.{role}",
                f"{sheet.linked_codes.get(role)} read at {conf:.2f}; confirmed only when link_panels finds that PDF", "warning")
    remarks = (t.raw_remarks.value or "").lower()
    if "code" in remarks and not sheet.linked_codes and not sheet.reference_codes:
        add("linked_codes_unparsed", "raw_remarks", "Remarks mention a code but no '<Panel> Code : <item>' pair was recognised")
    if t.finish.value is None and re.search(r"\b(matt|matte|gloss|glossy)\b", remarks + " " + (t.value_additions.value or "").lower()):
        add("finish_unparsed", "finish", "Remarks or value additions mention a finish but none was extracted")

    return ValidationReport(issues=issues, bleed_used=bleed, bleed_source=source)
