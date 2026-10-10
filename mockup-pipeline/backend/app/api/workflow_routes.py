"""Workflow editor API (spec 4): drafts, validation, publishing, test runs.

A workflow's published versions are index entries (kind `workflow`, restorable history); its draft
is one row in workflow_drafts that only the editor sees. Publishing validates the graph against the
catalog and the field dictionary and writes a new index version; jobs pin the version they ran.
"""

import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import activity, auth
from app.api.job_routes import _event, register_file
from app.db import get_session
from app.index import store
from app.index.graph import NODE_HELP, NODE_LABELS, NODE_STEPS, WorkflowGraph, auto_layout, linear_graph, validate_graph
from app.index.schemas import KEY_PATTERN, field_keys
from app.models import Job, User, WorkflowDraft, utcnow
from app.specs.schema import SpecTable
from app.workflow import queue
from app.workflow.runner import STEPS

router = APIRouter(prefix="/api/workflows")

CONDITION_FIELDS = (
    [f"spec.{n}" for n in SpecTable.model_fields] + ["spec.layers_text"]
    + ["measured.overall_width_mm", "measured.overall_height_mm", "measured.width_segments_mm", "measured.height_segments_mm",
       "measured.zipper_line_drawn", "measured.bleed_left_mm", "measured.bleed_top_mm"]
    + ["job.mode", "job.roll_form", "job.repeats", "job.layout", "job.sheet_panels", "job.text_source", "job.layout_problem",
       "job.pouch_type", "job.client", "job.item_code", "job.filename"]
    + ["panels", "linked_codes.back", "linked_codes.gusset", "keyline.zipper_offset_from_top_mm", "keyline.gusset_depth_mm"]
)


def _key(key: str) -> str:
    import re

    if not re.fullmatch(KEY_PATTERN, key):
        raise HTTPException(422, "key must be lowercase letters, digits, '_' or '-' (max 120)")
    return key


def _graph(data: dict[str, Any]) -> WorkflowGraph:
    try:
        return WorkflowGraph.model_validate(data)
    except ValidationError as exc:
        problems = [f"{'.'.join(str(p) for p in e['loc']) or '(root)'}: {e['msg']}" for e in exc.errors()]
        raise HTTPException(422, {"problems": problems}) from exc


def _problems(session: Session, key: str, graph: WorkflowGraph) -> list[str]:
    index = store.load_all(session)
    return validate_graph(graph, set(index["pouch_type"]), field_keys(index["field"]), set(index["workflow"]), self_key=key)


class DraftOut(BaseModel):
    graph: dict
    updated_by: str
    updated_at: datetime


class PublishedOut(BaseModel):
    version: int
    graph: dict
    author: str
    reason: str
    created_at: datetime


class WorkflowOut(BaseModel):
    key: str
    name: str
    published: PublishedOut | None
    draft: DraftOut | None
    problems: list[str]  # of the draft, else of the published graph
    archived: bool = False


@router.get("/meta")
def meta(session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> dict:
    """What the editor's palette and settings panels offer."""
    index = store.load_all(session)
    fields = index["field"]
    return {
        "node_types": [{"type": t, "label": NODE_LABELS[t], "help": NODE_HELP[t], "steps": NODE_STEPS[t]} for t in NODE_LABELS],
        "steps": STEPS,
        "pouch_types": {k: v.name for k, v in index["pouch_type"].items() if v.active},  # type: ignore[attr-defined]
        "fields": [{"key": k, "name": f.name, "kind": f.kind, "required": f.required, "order": f.order}  # type: ignore[attr-defined]
                   for k, f in sorted(fields.items(), key=lambda kf: (kf[1].order, kf[0])) if not f.stop]  # type: ignore[attr-defined]
                  or [{"key": k, "name": k, "kind": "text", "required": False, "order": i} for i, k in enumerate(SpecTable.model_fields)],
        "condition_fields": CONDITION_FIELDS,
        "workflows": {k: v.name for k, v in index["workflow"].items()},  # type: ignore[attr-defined]
    }


@router.get("")
def list_workflows(session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> list[WorkflowOut]:
    published = {e.key: (e, v) for e, v in store.list_entries(session, "workflow", include_archived=True)}
    drafts = {d.key: d for d in session.scalars(select(WorkflowDraft))}
    out = []
    for key in sorted({*published, *drafts}):
        out.append(_workflow_out(session, key, published.get(key), drafts.get(key), with_problems=False))
    return out


def _workflow_out(session: Session, key: str, pub, draft: WorkflowDraft | None, with_problems: bool = True) -> WorkflowOut:
    published = None
    name = key
    if pub is not None:
        entry, version = pub
        published = PublishedOut(version=version.version, graph=version.data, author=version.author_email, reason=version.reason, created_at=version.created_at)
        name = version.data.get("name") or key
    draft_out = DraftOut(graph=draft.graph, updated_by=draft.updated_by, updated_at=draft.updated_at) if draft else None
    if draft is not None:
        name = draft.graph.get("name") or name
    problems: list[str] = []
    if with_problems:
        source = draft.graph if draft else (published.graph if published else None)
        if source is not None:
            try:
                problems = _problems(session, key, WorkflowGraph.model_validate(source))
            except ValidationError as exc:
                problems = [e["msg"] for e in exc.errors()]
    return WorkflowOut(key=key, name=name, published=published, draft=draft_out, problems=problems,
                       archived=bool(pub and pub[0].archived))


@router.get("/{key}")
def get_workflow(key: str, session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> WorkflowOut:
    entry = store.get_entry(session, "workflow", _key(key))
    pub = (entry, store.get_version(session, "workflow", key)) if entry else None
    draft = session.get(WorkflowDraft, key)
    if pub is None and draft is None:
        if key == "default":
            # Nothing published yet: the built-in order is what jobs run; offer it as the starting draft.
            graph = linear_graph("Default workflow")
            return WorkflowOut(key=key, name=graph.name, published=None, draft=None, problems=[], archived=False)
        raise HTTPException(404, f"workflow {key} not found")
    return _workflow_out(session, key, pub, draft)


class GraphIn(BaseModel):
    graph: dict[str, Any]


@router.put("/{key}/draft")
def save_draft(key: str, body: GraphIn, session: Session = Depends(get_session), user: User = Depends(auth.require("edit_keyline"))) -> WorkflowOut:
    graph = _graph(body.graph)  # shape must be right; graph rules may still be broken in a draft
    draft = session.get(WorkflowDraft, _key(key))
    if draft is None:
        draft = WorkflowDraft(key=key, graph={}, updated_by=user.email)
        session.add(draft)
    draft.graph, draft.updated_by, draft.updated_at = graph.model_dump(mode="json"), user.email, utcnow()
    session.commit()
    return get_workflow(key, session, user)


@router.delete("/{key}/draft")
def discard_draft(key: str, session: Session = Depends(get_session), user: User = Depends(auth.require("edit_keyline"))) -> WorkflowOut:
    draft = session.get(WorkflowDraft, _key(key))
    if draft is not None:
        session.delete(draft)
        session.commit()
    return get_workflow(key, session, user)


@router.post("/{key}/validate")
def validate_draft(key: str, body: GraphIn, session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> dict:
    graph = _graph(body.graph)
    return {"problems": _problems(session, _key(key), graph)}


@router.post("/{key}/layout")
def layout(key: str, body: GraphIn, _: User = Depends(auth.current_user)) -> dict:
    return {"graph": auto_layout(_graph(body.graph)).model_dump(mode="json")}


class PublishIn(BaseModel):
    reason: str
    graph: dict[str, Any] | None = None  # default: the saved draft


@router.post("/{key}/publish")
def publish(key: str, body: PublishIn, request: Request, session: Session = Depends(get_session), user: User = Depends(auth.require("edit_keyline"))) -> WorkflowOut:
    _key(key)
    old = store.get_version(session, "workflow", key)
    before = dict(old.data) if old else {}
    draft = session.get(WorkflowDraft, key)
    data = body.graph if body.graph is not None else (draft.graph if draft else None)
    if data is None:
        raise HTTPException(422, {"problems": ["nothing to publish: save a draft first"]})
    graph = _graph(data)
    problems = _problems(session, key, graph)
    if problems:
        raise HTTPException(422, {"problems": problems})
    try:
        store.save(session, "workflow", key, graph.model_dump(mode="json"), store.Author.of(user), body.reason)
    except store.IndexError_ as exc:
        session.rollback()
        raise HTTPException(422, {"problems": exc.problems}) from exc
    if draft is not None:
        session.delete(draft)
    session.commit()
    now = store.get_version(session, "workflow", key)
    activity.record("workflow published", user, request, kind="workflow", key=key, version=now.version if now else None, reason=body.reason,
                    changes=store.field_changes(before, graph.model_dump(mode="json")))
    return get_workflow(key, session, user)


@router.post("/{key}/test")
async def test_run(key: str, file: UploadFile = File(...), graph: str = Form(...), session: Session = Depends(get_session),
                   user: User = Depends(auth.current_user)) -> dict:
    """Run a PDF through a (draft) graph as a test job: the path lights up on the canvas; the job is
    kept apart from the jobs list."""
    try:
        data = json.loads(graph)
    except json.JSONDecodeError as exc:
        raise HTTPException(422, {"problems": [f"graph is not JSON: {exc}"]}) from exc
    g = _graph(data)
    problems = _problems(session, _key(key), g)
    if problems:
        raise HTTPException(422, {"problems": problems})
    pdf = await file.read()
    f = register_file(session, file.filename or "test.pdf", pdf, None, user)
    job = Job(file_id=f.id, item_code=f.item_code, status="QUEUED", current_step=STEPS[0], kind="test", workflow_key=key,
              inputs={"workflow_graph": g.model_dump(mode="json"), "workflow_key": key}, created_by_id=user.id)
    session.add(job)
    session.flush()
    _event(session, job, f"Test run of workflow '{g.name}' ({key}) with {f.filename}", user)
    session.commit()
    queue.enqueue(job.id)
    return {"job_id": job.id}
