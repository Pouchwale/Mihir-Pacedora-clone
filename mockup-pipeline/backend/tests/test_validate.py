from app.pdf.profile import PdfProfile
from app.specs.schema import SpecSheet
from app.specs.validate import ValidationRules, validate

PROFILE = PdfProfile()


def _sheet(extraction) -> SpecSheet:
    return SpecSheet(
        spec_table=extraction.spec_table,
        measured_keyline=extraction.measured_keyline,
        linked_codes=PROFILE.parse_linked_codes(extraction.spec_table.raw_remarks.value),
    )


def _run(sheet, **kw):
    args = dict(filename_code="FGPO7215", trim_width_mm=244.475, trim_height_mm=320.0,
                item_code_pattern=PROFILE.item_code_pattern, rules=ValidationRules())
    args.update(kw)
    return validate(sheet, **args)


def codes(report):
    return {i.code for i in report.issues if i.severity == "review"}


def test_expected_sample_passes(expected_extraction):
    report = _run(_sheet(expected_extraction))
    assert codes(report) == set()
    assert report.bleed_source == "measured"
    assert report.bleed_used == {"left": 2.2375, "right": 2.2375, "top": 4, "bottom": 4}


def test_low_confidence(expected_extraction):
    expected_extraction.spec_table.sealing_width_mm.confidence = 0.6
    report = _run(_sheet(expected_extraction))
    assert [(i.code, i.field) for i in report.issues if i.severity == "review"] == [("low_confidence", "sealing_width_mm")]


def test_item_no_must_match_filename(expected_extraction):
    assert "item_no_mismatch" in codes(_run(_sheet(expected_extraction), filename_code="FGPO7216"))


def test_gusset_wider_than_pouch(expected_extraction):
    expected_extraction.spec_table.gusset_full_width_mm.value = 260
    assert "gusset_too_wide" in codes(_run(_sheet(expected_extraction)))


def test_trimbox_mismatch(expected_extraction):
    assert {"trim_width", "keyline_vs_trimbox"} <= codes(_run(_sheet(expected_extraction), trim_width_mm=250.0))


def test_keyline_disagrees_with_spec(expected_extraction):
    expected_extraction.measured_keyline.height_segments_mm.value = [10, 12, 13, 257, 10]
    assert "keyline_vs_spec" in codes(_run(_sheet(expected_extraction)))


def test_missing_bleed_uses_default_with_warning(expected_extraction):
    expected_extraction.measured_keyline.bleed_left_mm.value = None
    report = _run(_sheet(expected_extraction))
    assert report.bleed_source == "default"
    # Default 4 mm per side does not fit this TrimBox horizontally (244.475 != 248), so review.
    assert "trim_width" in codes(report)


def test_required_field_missing(expected_extraction):
    expected_extraction.spec_table.sealing_type.value = None
    assert "missing" in codes(_run(_sheet(expected_extraction)))


def test_remarks_code_not_parsed(expected_extraction):
    expected_extraction.spec_table.raw_remarks.value = "Code for back is FGPO7216"
    assert "linked_codes_unparsed" in codes(_run(_sheet(expected_extraction)))


def test_zipper_without_drawn_line(expected_extraction):
    expected_extraction.measured_keyline.zipper_line_drawn.value = False
    assert "zipper_not_drawn" in codes(_run(_sheet(expected_extraction)))


def test_corrections_blank_list_and_bad_value(sample_sheet):
    """A blank list field from the review form is an empty list; a value that cannot fit its field
    goes back to the operator as a review item (the job never fails on it)."""
    import pytest

    from app.errors import NeedsReview
    from app.workflow.steps.validate import apply_corrections

    out, applied = apply_corrections(sample_sheet, {"spec_table.layers": None, "spec_table.inks": None, "spec_table.pouch_height_mm": 300})
    assert out.spec_table.layers.value == [] and out.spec_table.inks.value == [] and out.spec_table.pouch_height_mm.value == 300
    assert set(applied) == {"spec_table.layers", "spec_table.inks", "spec_table.pouch_height_mm"}
    with pytest.raises(NeedsReview) as exc:
        apply_corrections(sample_sheet, {"spec_table.pouch_height_mm": "tall"})
    assert exc.value.details["form"] == "specs" and exc.value.details["issues"][0]["field"] == "pouch_height_mm"
