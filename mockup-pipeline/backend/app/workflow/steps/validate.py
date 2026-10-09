"""validate: apply operator corrections, run the validation rules, pause for review on any problem.

Operator input (job.inputs):
  spec_corrections: {"spec_table.<field>": value, "measured_keyline.<field>": value}
      every submitted field becomes confidence 1.0 (verified by a person)
  acknowledged: ["<code>@<field>", ...] structural issues the operator accepted (with a reason)
"""

from typing import Any

from pydantic import BaseModel, ValidationError

from app.errors import NeedsReview
from app.specs.schema import SpecSheet
from app.specs.validate import Issue, ValidationReport, validate
from app.steps import extract_specs as extract_impl
from app.steps import trim_artwork as trim_impl
from app.workflow.context import StepContext


class Output(BaseModel):
    sheet: SpecSheet
    report: ValidationReport
    corrected_fields: list[str]
    acknowledged: list[str]


def apply_corrections(sheet: SpecSheet, corrections: dict[str, Any]) -> tuple[SpecSheet, list[str]]:
    """The operator's values over the extracted sheet. A blank list field (layers, inks, segments) is
    an empty list; a blank scalar confirms the field as read (the extracted value stays, verified: a
    details form left half empty neither erases what was read nor asks about it again); a value that
    does not fit its field goes back to the operator as a review item instead of failing the job."""
    data = sheet.model_dump(mode="json")
    applied = []
    for path, value in corrections.items():
        part, _, name = path.partition(".")
        if part not in ("spec_table", "measured_keyline") or name not in data[part]:
            continue
        field = data[part][name]
        if isinstance(field, dict) and "value" in field:
            if value is None:
                value = [] if isinstance(field["value"], list) else field["value"]
            field["value"], field["confidence"] = value, 1.0
            applied.append(path)
    try:
        out = SpecSheet.model_validate(data)
    except ValidationError as exc:
        bad = sorted({".".join(str(p) for p in e["loc"][:2]) for e in exc.errors()})
        raise NeedsReview("spec_review", "Corrected value(s) do not fit their field: " + ", ".join(bad), {
            "form": "specs",
            "issues": [{"code": "bad_correction", "field": ".".join(str(p) for p in e["loc"][1:2]), "severity": "review",
                        "message": f"{e['msg']} (you entered {e.get('input')!r})"} for e in exc.errors()],
            "sheet": sheet.model_dump(mode="json"),
            "cells": {},
        }) from exc
    return out, applied


def run(ctx: StepContext) -> Output:
    extracted = ctx.output("extract_specs", extract_impl.ExtractSpecsOutput)
    trim = ctx.output("trim_artwork", trim_impl.TrimArtworkOutput)
    profile, rules = ctx.index.pdf_profile(), ctx.index.validation_rules()
    sheet, applied = apply_corrections(extracted.sheet, ctx.inputs.get("spec_corrections") or {})
    if "spec_table.raw_remarks" in applied:  # re-derive linked panels from the corrected remarks
        remarks = sheet.spec_table.raw_remarks.value or ""
        linked = profile.parse_linked_codes(remarks)
        sheet = sheet.model_copy(update={"linked_codes": linked, "linked_code_confidence": {r: 1.0 for r in linked},
                                         "reference_codes": profile.parse_reference_codes(remarks)})
    tw, th = extracted.front_trim_mm((trim.trim_width_mm, trim.trim_height_mm))
    report = validate(sheet, filename_code=profile.item_code_from_filename(ctx.job.file.filename),
                      trim_width_mm=tw, trim_height_mm=th,
                      item_code_pattern=profile.item_code_pattern, rules=rules, layout_problem=extracted.layout_problem,
                      page_mode=extracted.mode == "page" and not extracted.sleeve, roll_form=extracted.roll_form or extracted.sleeve,
                      # (a shrink sleeve has no pouch table: the pouch fields and standard sizes do not apply)
                      required_fields=None if extracted.sleeve else ctx.index.required_fields(), field_confidence=ctx.index.field_confidence(),
                      standard_sizes=None if extracted.sleeve else ctx.index.all("standard_size"))  # type: ignore[arg-type]
    acknowledged = list(ctx.inputs.get("acknowledged") or [])
    if extracted.sleeve:
        # a shrink sleeve is its size and its item: the pouch table's fields and the dieline segments do not apply
        report = ValidationReport(issues=[i for i in report.issues if i.field.split(".")[-1] in SLEEVE_FIELDS],
                                  bleed_used=report.bleed_used, bleed_source=report.bleed_source)
    issues = [
        Issue(**{**i.model_dump(), "severity": "warning", "message": i.message + " (accepted by operator)"})
        if f"{i.code}@{i.field}" in acknowledged else i
        for i in report.issues
    ]
    report = ValidationReport(issues=issues, bleed_used=report.bleed_used, bleed_source=report.bleed_source)
    if applied:
        ctx.log(f"Operator verified {len(applied)} field(s)", "audit", {"fields": applied})
    if report.needs_review:
        review = [i for i in issues if i.severity == "review"]
        raise spec_review(extracted, sheet, issues, f"{len(review)} spec value(s) need checking: " + ", ".join(sorted({i.field for i in review}))[:300])
    return Output(sheet=sheet, report=report, corrected_fields=applied, acknowledged=acknowledged)


SLEEVE_FIELDS = {"pouch_height_mm", "pouch_open_width_mm", "pouch_closed_width_mm", "item_no"}


def spec_review(extracted: extract_impl.ExtractSpecsOutput, sheet: SpecSheet, issues: list[Issue], message: str, code: str = "spec_review") -> NeedsReview:
    """The review that asks the operator for spec values: the specs form, or the details form for a
    plain artwork page (no table to correct, everything is typed in)."""
    page = extracted.mode == "page"
    return NeedsReview(
        "pouch_details" if page else code,
        "Plain artwork PDF (no dieline or spec table): enter the pouch details" if page else message,
        {
            "form": "details" if page else "specs",
            "issues": [i.model_dump() for i in issues],
            "sheet": sheet.model_dump(mode="json"),
            "cells": {k: v.model_dump() for k, v in extracted.cells.items()},
            "spec_image_key": extracted.spec_image_key,
            "dimension_image_key": extracted.dimension_image_key,
            # The sheet is split into panels (and a plain page's bleed computed) while the table
            # is read: sizes given by the operator must re-run that step, not just this one.
            **({"resume_step": "extract_specs"} if extracted.layout_problem or page else {}),
        },
    )
