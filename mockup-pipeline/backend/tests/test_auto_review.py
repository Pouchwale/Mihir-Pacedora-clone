"""The automatic operator: every review stop gets the answer a careful operator would give."""

from types import SimpleNamespace

from app.workflow import auto_review


def _job(filename="FGPO7002-front.pdf", inputs=None, review=None):
    return SimpleNamespace(id=1, file=SimpleNamespace(filename=filename), inputs=inputs or {}, review=review or {}, control=None,
                           status="NEEDS_REVIEW", updated_at=None, keyline_template=None)


def _ctx(job, types=("three_side_seal", "stand_up_bottom_gusset", "spout_pouch", "center_seal_pillow")):
    from app.pdf.profile import PdfProfile

    index = SimpleNamespace(pdf_profile=lambda: PdfProfile(), all=lambda kind: {t: None for t in types}, get=lambda *a: None)
    return SimpleNamespace(index=index, job=job, step="validate", output=lambda *a: (_ for _ in ()).throw(KeyError("not run")))


def test_spec_review_confirms_weak_reads_and_accepts_checks():
    review = {"code": "spec_review", "node": "validate", "details": {"form": "specs", "sheet": {
        "spec_table": {"zipper": {"value": True, "confidence": 0.4}, "item_no": {"value": "FGPO0454", "confidence": 0.9}},
        "measured_keyline": {"bleed_top_mm": {"value": None, "confidence": 0.0}}},
        "issues": [
            {"code": "low_confidence", "field": "zipper", "severity": "review"},
            {"code": "item_no_mismatch", "field": "item_no", "severity": "review"},
            {"code": "low_confidence", "field": "measured_keyline.bleed_top_mm", "severity": "review"},
            {"code": "trim_width", "field": "pouch_closed_width_mm", "severity": "review"},
            {"code": "bleed_default", "field": "measured_keyline.bleed", "severity": "warning"},
        ]}}
    job = _job(review=review)
    body = auto_review.answer(job, review, _ctx(job))
    assert body["action"] == "specs"
    assert body["corrections"]["spec_table.zipper"] is None  # confirmed as read
    assert body["corrections"]["spec_table.item_no"] == "FGPO7002"  # the file name's code
    assert body["corrections"]["measured_keyline.bleed_top_mm"] is None
    assert "trim_width@pouch_closed_width_mm" in body["acknowledge"] and "bleed_default@measured_keyline.bleed" not in body["acknowledge"]


def test_missing_panels_get_substitutes():
    review = {"code": "missing_panels", "details": {"form": "panels", "default_color": "#123456",
                                                    "missing": [{"role": "back"}, {"role": "gusset"}]}}
    body = auto_review.answer(_job(), review, None)
    assert body["panel_choices"] == {"back": {"substitute": "front", "auto": True}, "gusset": {"substitute": "plain", "color": "#123456", "auto": True}}


def test_texture_and_workflow_reviews():
    tex = {"code": "technical_marks", "details": {"form": "texture", "issues": [{"code": "technical_marks", "field": "artwork.front"}]}}
    assert auto_review.answer(_job(), tex, None)["acknowledge"] == ["technical_marks@artwork.front"]
    wf = {"code": "workflow_review", "node": "n1", "details": {"form": "workflow_review", "choices": [{"edge": "e1"}, {"edge": "e2"}]}}
    assert auto_review.answer(_job(), wf, None)["edge"] == "e1"


def test_submit_merges_inputs_and_resumes_like_the_form():
    job = _job(inputs={"spec_corrections": {"spec_table.a": 1}}, review={"details": {"resume_step": "extract_specs"}})
    step = auto_review.submit(None, job, {"action": "specs", "corrections": {"spec_table.b": None}, "acknowledge": ["x@y"]}, "auto",
                              ["extract_specs", "validate"])
    assert step == "extract_specs" and job.status == "QUEUED"
    assert job.inputs["spec_corrections"] == {"spec_table.a": 1, "spec_table.b": None} and job.inputs["acknowledged"] == ["x@y"]


def test_the_same_question_twice_waits_for_a_person():
    added = []
    session = SimpleNamespace(add=added.append)
    review = {"code": "missing_panels", "node": "panels", "details": {"form": "panels", "missing": [{"role": "back"}]}}
    job = _job(review=review)
    ctx = _ctx(job)
    assert auto_review.try_answer(session, job, ctx, ["link_panels"]) == "link_panels"
    job.status, job.review = "NEEDS_REVIEW", review
    assert auto_review.try_answer(session, job, ctx, ["link_panels"]) is False  # the answer did not help
    assert "Waiting for a person" in added[-1].message


def test_missing_gusset_type_is_read_from_the_drawing():
    """FGPO5452: gusset, back, gusset, front on one sheet, gusset type empty -> "Side" (an empty answer looped)."""
    from app.geometry.sheet_layout import SheetLayout, SheetPanel

    def ctx_with(panels):
        job = _job(review=review)
        ctx = _ctx(job)
        ctx.output = lambda *a: SimpleNamespace(layout=SheetLayout(kind="multi", panels=panels))
        return job, ctx

    review = {"code": "fetch_fields", "details": {"form": "specs", "sheet": {"spec_table": {"gusset_type": {"value": None, "confidence": 0.0}}},
              "issues": [{"code": "missing", "field": "gusset_type", "severity": "review"}]}}
    side = [SheetPanel(kind="gusset", x_mm=0, y_mm=0, width_mm=80, height_mm=387.35), SheetPanel(kind="face", x_mm=80, y_mm=0, width_mm=142, height_mm=387.35, role="back"),
            SheetPanel(kind="gusset", x_mm=222, y_mm=0, width_mm=80, height_mm=387.35), SheetPanel(kind="face", x_mm=302, y_mm=0, width_mm=142, height_mm=387.35, role="front")]
    bottom = [SheetPanel(kind="face", x_mm=0, y_mm=0, width_mm=161.9, height_mm=283, role="front"), SheetPanel(kind="gusset", x_mm=0, y_mm=290, width_mm=161.9, height_mm=96)]
    for panels, want in ((side, "Side"), (bottom, "Bottom"), ([SheetPanel(kind="face", x_mm=0, y_mm=0, width_mm=100, height_mm=150, role="front")], "None")):
        job, ctx = ctx_with(panels)
        assert auto_review.answer(job, review, ctx)["corrections"]["spec_table.gusset_type"] == want


def test_rerun_from_link_panels_forgets_automatic_panel_answers():
    from app.api.job_routes import drop_auto_answers

    body = auto_review._panels_answer({"missing": [{"role": "back"}, {"role": "gusset"}], "default_color": "#123456"})
    inputs = {"panel_choices": {**body["panel_choices"], "side_left": {"file_id": 7}}, "auto_reviews": ["x"]}
    assert drop_auto_answers(inputs, "link_panels") == {"panel_choices": {"side_left": {"file_id": 7}}}  # the operator's choice stays
    assert drop_auto_answers(inputs, "texture") == inputs  # a later step keeps them
    assert drop_auto_answers(inputs, None) == inputs  # (a rerun from a workflow node)
