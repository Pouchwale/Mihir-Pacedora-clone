"""Automatic operator: answers every review stop so a job runs from PDF to 3D mockup with no person
in between (Settings.auto_review, on by default).

Each answer is what a careful operator would send on the review form, submitted through the same
code as the form (`submit`), so it lands in job.inputs, is logged on the job and the job resumes
from the same step. The rules, by review:

- spec values (specs / details form): a weak read is confirmed as read (the dieline cross-checks
  catch a wrong size; the pouch is built from what the PDF says); a missing pouch size comes from
  the drawing; an item number that disagrees with the file name takes the file name's; any other
  check (keyline vs table, TrimBox, zipper...) is accepted, with its warning kept.
- pouch type: the table's sealing type / gusset / remarks map to the nearest pouch type.
- missing or unusable panel PDFs: the back repeats the front artwork; a gusset / side / bottom /
  top is plain film in the front's colour.
- keyline values out of range: each takes its index default.
- texture checks (masked keyline marks): accepted, the masking stays.
- a workflow REVIEW node: its first branch.

A job stops only when the same question comes back after its automatic answer (the answer did not
fix it) or after MAX_ROUNDS answers; it then waits for a person as before.
"""

from typing import Any

from sqlalchemy.orm import Session

from app.models import Job, JobEvent, utcnow

MAX_ROUNDS = 8  # automatic answers per job: a safety stop against an answer that changes nothing

RESUME_FROM: dict[str, str | None] = {
    "specs": "validate", "pouch_type": "match_pouch_type", "keyline": "resolve_keyline", "panels": "link_panels", "texture": "texture",
    "workflow_review": None,  # nothing to redo: the walk continues past the node
}


def submit(session: Session, job: Job, body: dict[str, Any], by: str, steps: list[str]) -> str | None:
    """Merge a review answer into the job's inputs, queue it and return the step to resume from.
    The single path for answers typed on the review form and for automatic ones."""
    action = body["action"]
    inputs = dict(job.inputs or {})
    if action == "specs":
        inputs["spec_corrections"] = {**inputs.get("spec_corrections", {}), **(body.get("corrections") or {})}
    if action in ("specs", "texture") and body.get("acknowledge"):
        inputs["acknowledged"] = sorted({*inputs.get("acknowledged", []), *body["acknowledge"]})
    if action == "pouch_type":
        inputs["pouch_type"] = body["pouch_type"]
    if action == "keyline":
        inputs["keyline_overrides"] = {**inputs.get("keyline_overrides", {}), **(body.get("keyline_overrides") or {})}
    if action == "panels":
        inputs["panel_choices"] = {**inputs.get("panel_choices", {}), **(body.get("panel_choices") or {})}
    if action == "workflow_review":
        node = body.get("node") or (job.review or {}).get("node")
        inputs["reviews"] = {**inputs.get("reviews", {}), node: {"edge": body.get("edge"), "note": body.get("note", ""), "by": by,
                                                               "at": utcnow().isoformat()}}
    job.inputs = inputs
    job.control = None
    job.status, job.updated_at = "QUEUED", utcnow()
    step = RESUME_FROM[action]
    resume = ((job.review or {}).get("details") or {}).get("resume_step")
    if action == "specs" and resume in steps:
        step = resume
    return step


# ---------------------------------------------------------------- answers
def _spec_answer(job: Job, details: dict, ctx) -> dict:
    """Confirm weak reads, fill what the drawing gives, accept structural checks."""
    sheet = details.get("sheet") or {}
    table, measured = sheet.get("spec_table") or {}, sheet.get("measured_keyline") or {}
    corrections: dict[str, Any] = {}
    acknowledge: list[str] = []
    for issue in details.get("issues") or []:
        if issue.get("severity", "review") != "review":
            continue
        code, field = issue.get("code", ""), issue.get("field", "")
        acknowledge.append(f"{code}@{field}")
        part, name = ("measured_keyline", field.split(".", 1)[1]) if field.startswith("measured_keyline.") else ("spec_table", field)
        values = measured if part == "measured_keyline" else table
        current = (values.get(name) or {}).get("value") if isinstance(values.get(name), dict) else None
        if code == "item_no_mismatch":
            code_from_name = ctx.index.pdf_profile().item_code_from_filename(job.file.filename)
            if code_from_name:
                corrections["spec_table.item_no"] = code_from_name
            continue
        if part == "spec_table" and name in ("pouch_closed_width_mm", "pouch_height_mm", "pouch_open_width_mm") and not current:
            size = _drawn_size(ctx, name)
            if size:
                corrections[f"spec_table.{name}"] = size
                continue
        if name in values:
            corrections[f"{part}.{name}"] = None  # confirmed as read (an empty field stays empty)
    return {"action": "specs", "corrections": corrections, "acknowledge": sorted(set(acknowledge)),
            "note": f"{len(corrections)} value(s) confirmed or filled, {len(set(acknowledge))} check(s) accepted"}


def _drawn_size(ctx, name: str) -> float | None:
    """A pouch size from the drawing when the table has none: the front panel's box (cut at its
    dieline lines) or, on a plain page, the artwork area."""
    from app.steps import extract_specs as extract_impl
    from app.steps import trim_artwork as trim_impl

    try:
        trim = ctx.output("trim_artwork", trim_impl.TrimArtworkOutput)
        extracted = ctx.output("extract_specs", extract_impl.ExtractSpecsOutput)
    except Exception:  # noqa: BLE001 - the step has not run: nothing to measure
        return None
    w, h = extracted.front_trim_mm((trim.trim_width_mm, trim.trim_height_mm))
    m = extracted.sheet.measured_keyline
    seg_w, seg_h = sum(m.width_segments_mm.value or []), sum(m.height_segments_mm.value or [])
    if name == "pouch_closed_width_mm":
        return round(seg_w or w, 3)
    if name == "pouch_height_mm":
        return round(seg_h or h, 3)
    return None


def _pouch_type_answer(details: dict, ctx) -> dict | None:
    from app.workflow.runner import current_sheet

    candidates = list(details.get("candidates") or [])
    types = set(ctx.index.all("pouch_type"))
    try:
        t = current_sheet(ctx).spec_table
        text = " ".join(str(getattr(t, f).value or "") for f in ("sealing_type", "raw_remarks", "pouch_or_roll_form")).lower()
        gusset = str(getattr(t.gusset_type.value, "value", t.gusset_type.value) or "").lower()
    except Exception:  # noqa: BLE001
        text, gusset = "", ""
    if "roll" in text:
        want = "roll_stock"
    elif "spout" in text:
        want = "spout_pouch"
    elif "quad" in text or "4 side" in text or "8 side" in text:
        want = "quad_seal"
    elif "flat bottom" in text or "box" in text:
        want = "flat_bottom_box_pouch"
    elif "center" in text or "centre" in text or "pillow" in text or "back seal" in text:
        want = "center_seal_side_gusset" if gusset == "side" else "center_seal_pillow"
    elif gusset == "bottom" or "stand" in text:
        want = "stand_up_bottom_gusset"
    elif gusset == "side":
        want = "center_seal_side_gusset"
    else:
        want = "three_side_seal"
    pick = want if (want in candidates or not candidates) and want in types else (candidates[0] if candidates else None)
    if pick is None or pick not in types:
        pick = "three_side_seal" if "three_side_seal" in types else next(iter(types), None)
    return {"action": "pouch_type", "pouch_type": pick, "note": f"nearest type to the table's sealing / gusset: {pick}"} if pick else None


def _panels_answer(details: dict) -> dict:
    colour = details.get("default_color") or "#ffffff"
    choices = {}
    for item in details.get("missing") or []:
        role = item.get("role")
        choices[role] = {"substitute": "front"} if role == "back" else {"substitute": "plain", "color": colour}
    return {"action": "panels", "panel_choices": choices,
            "note": ", ".join(f"{r}: {'same artwork as the front' if c['substitute'] == 'front' else 'plain film ' + c['color']}" for r, c in choices.items())}


def _keyline_answer(details: dict, ctx) -> dict:
    overrides = {}
    template = ctx.index.get("keyline_template", ctx.job.keyline_template) if ctx.job.keyline_template else None
    for issue in details.get("issues") or []:
        name = issue.get("field", "").split(".", 1)[-1]
        field = template.fields.get(name) if template is not None else None
        overrides[name] = field.default if field is not None else None
    return {"action": "keyline", "keyline_overrides": {k: v for k, v in overrides.items() if k}, "note": "out-of-range keyline values set to their defaults"}


def answer(job: Job, review: dict, ctx) -> dict | None:
    """The automatic answer to a review stop, or None when there is no sensible one."""
    details = review.get("details") or {}
    form, code = details.get("form"), review.get("code")
    if form in ("specs", "details") or code in ("spec_review", "fetch_fields", "pouch_details", "missing_size"):
        return _spec_answer(job, details, ctx)
    if form == "pouch_type" or code in ("pouch_type", "unknown_pouch_type"):
        return _pouch_type_answer(details, ctx)
    if form == "panels":
        return _panels_answer(details)
    if form == "keyline" or code == "keyline":
        return _keyline_answer(details, ctx)
    if form == "texture" or code == "technical_marks":
        acks = [f"{i.get('code')}@{i.get('field')}" for i in details.get("issues") or []]
        return {"action": "texture", "acknowledge": acks, "note": "masked keyline-coloured marks accepted"}
    if form == "workflow_review" or code == "workflow_review":
        choices = details.get("choices") or []
        return {"action": "workflow_review", "node": details.get("node") or review.get("node"),
                "edge": choices[0]["edge"] if choices else None, "note": "first branch taken"}
    return None


def try_answer(session: Session, job: Job, ctx, steps: list[str]) -> str | bool:
    """Answer the job's current review automatically. Returns the step to resume from (None-able as
    "" for "continue the walk"), or False when the job must wait for a person."""
    review = job.review or {}
    body = answer(job, review, ctx)
    history = list((job.inputs or {}).get("auto_reviews") or [])
    key = f"{review.get('node')}:{review.get('code')}:{sorted((body or {}).items(), key=str)!r}"[:400]
    if body is None or len(history) >= MAX_ROUNDS or key in history:
        reason = "no automatic answer" if body is None else "the same question came back after its automatic answer" if key in history else "too many automatic answers"
        session.add(JobEvent(job_id=job.id, level="warning", step=ctx.step, message=f"Waiting for a person: {reason}"))
        return False
    step = submit(session, job, body, "auto", steps)
    job.inputs = {**(job.inputs or {}), "auto_reviews": [*history, key]}
    session.add(JobEvent(job_id=job.id, level="warning", step=ctx.step,
                         message=f"Resolved automatically ({review.get('code')}): {body.get('note') or body['action']}", data=body))
    return step or ""
