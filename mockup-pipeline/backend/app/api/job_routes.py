"""Uploads, jobs, NEEDS_REVIEW actions, reruns, results (spec 4 and 6)."""

import hashlib
import io
import json
import mimetypes
import re
import zipfile
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from app import auth
from app.config import get_settings
from app.db import get_session
from app.index import store
from app.models import Batch, Job, JobEvent, JobStep, UploadedFile, User, utcnow
from app.render import tokens
from app.storage import get_storage
from app.workflow import auto_review, panel_art, queue, runner
from app.workflow.adjust import Adjustments, adjustments
from app.workflow.engine import STEPS

router = APIRouter(prefix="/api")
FRONT_PATTERN = re.compile(r"front", re.IGNORECASE)


def _profile(session: Session):
    from app.pdf.profile import PdfProfile

    row = store.get_version(session, "pdf_profile", "default")
    return PdfProfile.model_validate(row.data) if row else PdfProfile()


def _event(session: Session, job: Job, message: str, user: User | None, level: str = "audit", data: dict | None = None, step: str | None = None) -> None:
    session.add(JobEvent(job_id=job.id, level=level, step=step, message=f"{message}" + (f" (by {user.email})" if user else ""),
                         data={**(data or {}), **({"user": user.email} if user else {})}))


# ---------------------------------------------------------------- uploads
def _pdfs_from(upload_name: str, data: bytes) -> list[tuple[str, bytes]]:
    if upload_name.lower().endswith(".zip"):
        out = []
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for info in zf.infolist():
                name = info.filename.rsplit("/", 1)[-1]
                if not info.is_dir() and name.lower().endswith(".pdf") and not name.startswith(("._", "__MACOSX")):
                    out.append((name, zf.read(info)))
        return out
    if upload_name.lower().endswith(".pdf") or data[:5] == b"%PDF-":
        return [(upload_name, data)]
    raise HTTPException(422, f"{upload_name}: only PDF or ZIP files")


def register_file(session: Session, name: str, data: bytes, batch: Batch | None, user: User) -> UploadedFile:
    if not data.startswith(b"%PDF-"):
        raise HTTPException(422, f"{name} is not a PDF")
    sha = hashlib.sha256(data).hexdigest()
    code = _profile(session).item_code_from_filename(name)
    key = f"uploads/{sha[:2]}/{sha}.pdf"
    storage = get_storage()
    if not storage.exists(key):
        storage.put_bytes(key, data, "application/pdf")
    f = UploadedFile(batch_id=batch.id if batch else None, filename=name, item_code=code, sha256=sha, size=len(data),
                     storage_key=key, uploaded_by_id=user.id)
    session.add(f)
    session.flush()
    return f


def register_artwork(session: Session, name: str, data: bytes, user: User) -> UploadedFile:
    """A picture (PNG / JPEG / WebP) or PDF the operator places on a panel or uses as a logo from the
    job page. Pictures carry no item code: they never stand in for a linked panel PDF."""
    kind = panel_art.kind_of(name, data)
    if kind == "pdf":
        return register_file(session, name, data, None, user)
    if kind is None:
        raise HTTPException(422, f"{name}: only PNG, JPEG, WebP or PDF files")
    ext = (re.search(r"\.(png|jpe?g|webp)$", name.lower()) or [None, "png"])[1]
    ext = {"jpeg": "jpg"}.get(ext, ext)
    sha = hashlib.sha256(data).hexdigest()
    key = f"uploads/{sha[:2]}/{sha}.{ext}"
    storage = get_storage()
    if not storage.exists(key):
        storage.put_bytes(key, data, panel_art.media_type(f"x.{ext}"))
    f = UploadedFile(batch_id=None, filename=name if name.lower().endswith(f".{ext}") else f"{name}.{ext}", item_code=None, sha256=sha,
                     size=len(data), storage_key=key, uploaded_by_id=user.id)
    session.add(f)
    session.flush()
    return f


class UploadResult(BaseModel):
    batch_id: int
    files: list[dict]
    jobs: list[int]
    resumed: list[int]
    xml_specs: dict[str, dict[str, str]] | None = None  # item code -> spec fields read from an uploaded item master XML


@router.post("/uploads")
async def upload(
    files: list[UploadFile] = File(...),
    name: str = Form(""),
    panels_only: bool = Form(False),
    workflow: str = Form(""),  # published workflow key; empty = default
    session: Session = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> UploadResult:
    from app.services.xml_spec_parser import parse_xml_specs

    limit = get_settings().max_upload_mb * 1024 * 1024
    workflow_key = workflow.strip() or None
    if workflow_key and store.get_version(session, "workflow", workflow_key) is None:
        raise HTTPException(422, f"Workflow {workflow_key!r} is not published")
    batch = Batch(name=name or datetime.now().strftime("Upload %Y-%m-%d %H:%M"), created_by_id=user.id)
    session.add(batch)
    session.flush()

    registered: list[UploadedFile] = []
    xml_items: dict[str, dict[str, str]] = {}

    for up in files:
        data = await up.read()
        filename = up.filename or "upload"
        if len(data) > limit:
            raise HTTPException(413, f"{filename} is larger than {get_settings().max_upload_mb} MB")

        if filename.lower().endswith(".xml"):
            # An SAP item-master export: its items' specs fill those jobs' spec tables (app.services.xml_spec_parser)
            items = parse_xml_specs(data)
            if not items:
                raise HTTPException(422, f"{filename}: no items with specs found (expected an SAP Item Master XML export)")
            xml_items.update(items)
            sha = hashlib.sha256(data).hexdigest()
            key = f"uploads/{sha[:2]}/{sha}.xml"
            storage = get_storage()
            if not storage.exists(key):
                storage.put_bytes(key, data, "application/xml")
            for code in items:  # one row per item, so a later job for that code finds it too
                session.add(UploadedFile(batch_id=batch.id, filename=filename, item_code=code, sha256=sha, size=len(data),
                                         storage_key=key, uploaded_by_id=user.id))
            continue
        for pdf_name, pdf in _pdfs_from(filename, data):
            registered.append(register_file(session, pdf_name, pdf, batch, user))

    if not registered and not xml_items:
        raise HTTPException(422, "No PDF found in the upload")

    roots = [] if panels_only else [f for f in registered if FRONT_PATTERN.search(f.filename)] or registered
    jobs = []
    for f in roots:
        fields = xml_items.get((f.item_code or "").upper())
        job = Job(batch_id=batch.id, file_id=f.id, item_code=f.item_code, status="QUEUED", current_step=STEPS[0],
                  inputs={"xml_fields": fields} if fields else {}, created_by_id=user.id, workflow_key=workflow_key)
        session.add(job)
        session.flush()
        _event(session, job, f"Job created from {f.filename}" + (" with its item master XML specs" if fields else ""), user, data={"sha256": f.sha256})
        jobs.append(job)

    resumed = _resume_waiting(session, {f.item_code for f in registered if f.item_code}, exclude={j.id for j in jobs})
    session.commit()
    for job in jobs:
        queue.enqueue(job.id)
    for job_id in resumed:
        queue.enqueue(job_id, "link_panels")

    return UploadResult(batch_id=batch.id, jobs=[j.id for j in jobs], resumed=resumed,
                        files=[{"id": f.id, "filename": f.filename, "item_code": f.item_code, "sha256": f.sha256} for f in registered],
                        xml_specs=xml_items or None)


def _resume_waiting(session: Session, codes: set[str], exclude: set[int]) -> list[int]:
    """Jobs paused for missing panels whose codes were just uploaded."""
    out = []
    for job in session.scalars(select(Job).where(Job.status == "NEEDS_REVIEW")):
        review = job.review or {}
        missing = {m.get("code") for m in (review.get("details") or {}).get("missing", [])}
        if job.id not in exclude and review.get("code") == "missing_panels" and missing & codes:
            job.status = "QUEUED"
            _event(session, job, "Missing panel uploaded; resuming", None, "info")
            out.append(job.id)
    return out


# ---------------------------------------------------------------- jobs
class JobSummary(BaseModel):
    id: int
    batch_id: int | None
    filename: str
    item_code: str | None
    client_name: str | None
    status: str
    current_step: str
    current_node: str | None = None
    kind: str = "job"
    workflow_key: str | None = None
    workflow_version: int | None = None
    pouch_type: str | None
    review_message: str | None
    error: str | None
    approved_by: str | None
    created_at: datetime
    updated_at: datetime


def _summary(job: Job) -> JobSummary:
    return JobSummary(id=job.id, batch_id=job.batch_id, filename=job.file.filename, item_code=job.item_code, client_name=job.client_name,
                      status=job.status, current_step=job.current_step, current_node=job.current_node, kind=job.kind,
                      workflow_key=job.workflow_key, workflow_version=job.workflow_version, pouch_type=job.pouch_type,
                      review_message=(job.review or {}).get("message"), error=job.error, approved_by=job.approved_by,
                      created_at=job.created_at, updated_at=job.updated_at)


@router.get("/jobs")
def list_jobs(status: str | None = None, q: str | None = None, limit: int = 20, offset: int = 0, kind: str = "job",
              session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> dict:
    """`kind`: "job" (default) hides the workflow editor's test runs; "test" lists only those.
    Newest first, `limit` (at most 500) per page from `offset`; `total` counts every match."""
    query = select(Job).where(Job.kind == kind)
    if status:
        query = query.where(Job.status == status)
    if q:
        like = f"%{q.strip()}%"
        query = query.where((Job.item_code.ilike(like)) | (Job.client_name.ilike(like)))
    total = session.scalar(select(func.count()).select_from(query.subquery())) or 0
    page = query.order_by(desc(Job.id)).limit(max(1, min(limit, 500))).offset(max(0, offset))
    counts = dict(session.execute(select(Job.status, func.count()).where(Job.kind == kind).group_by(Job.status)).all())
    return {"jobs": [_summary(j) for j in session.scalars(page)], "counts": counts, "total": total, "limit": limit, "offset": offset}


def _job(session: Session, job_id: int) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "No such job")
    return job


@router.get("/jobs/{job_id}")
def get_job(job_id: int, session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> dict:
    job = _job(session, job_id)
    steps = {s.step: s for s in session.scalars(select(JobStep).where(JobStep.job_id == job_id))}
    events = session.scalars(select(JobEvent).where(JobEvent.job_id == job_id).order_by(desc(JobEvent.id)).limit(300)).all()
    graph, wf_key, wf_version = runner.load_graph(session, job)
    return {
        "job": _summary(job),
        "inputs": job.inputs,
        "review": job.review,
        "index_snapshot": job.index_snapshot,
        "keyline_template": job.keyline_template,
        "keyline_version": job.keyline_version,
        "approved_at": job.approved_at,
        # The workflow this job walks and the nodes it visited (the live canvas): the graph is the
        # pinned published version, or a test run's draft snapshot.
        "workflow": {"key": wf_key, "version": wf_version, "kind": job.kind, "path": job.workflow_path or [],
                     "current_node": job.current_node, "graph": graph.model_dump(mode="json")},
        "steps": [
            {"step": name, "status": steps[name].status if name in steps else "pending",
             "attempt": steps[name].attempt if name in steps else 0,
             "started_at": steps[name].started_at if name in steps else None,
             "finished_at": steps[name].finished_at if name in steps else None,
             "error": steps[name].error if name in steps else None}
            for name in STEPS
        ],
        "outputs": {name: s.output for name, s in steps.items() if s.status == "done" and s.output},
        "events": [{"at": e.created_at, "level": e.level, "step": e.step, "message": e.message, "data": e.data} for e in events],
    }


def _authorized_for_job(request: Request, session: Session, job_id: int) -> None:
    if tokens.check(request.query_params.get("token"), job_id):
        return
    auth.current_user(request, session)  # raises 401 when neither a token nor a session is present



@router.get("/jobs/{job_id}/share-token")
def share_token(job_id: int, session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> dict:
    """Generate a long-lived (7-day) signed token for sharing a job's 3D mockup publicly.
    The token authorises read-only access to the job's scene data and file assets."""
    _job(session, job_id)  # 404 if job does not exist
    token = tokens.make(job_id, ttl_s=7 * 24 * 3600)  # 7-day share link
    share_url = f"/share/{job_id}?token={token}"
    return {"token": token, "share_url": share_url, "expires_in_days": 7}



@router.get("/jobs/{job_id}/scene")
def scene(job_id: int, request: Request, session: Session = Depends(get_session)) -> dict:
    """Everything the 3D viewer / render page needs: geometry spec + texture URLs."""
    _authorized_for_job(request, session, job_id)
    steps = {s.step: s for s in session.scalars(select(JobStep).where(JobStep.job_id == job_id, JobStep.status == "done"))}
    if "build_geometry" not in steps or "texture" not in steps:
        raise HTTPException(409, "The job has not reached the texture step yet")
    token = request.query_params.get("token")
    suffix = f"&token={token}" if token else ""
    url = lambda key: f"/api/jobs/{job_id}/file?key={key}{suffix}"  # noqa: E731
    job = _job(session, job_id)
    adj = job_adjustments(session, job)
    # Artwork placement adjustments travel as texture transforms: the viewer, the headless renders
    # and the GLB export (KHR_texture_transform) all apply the same numbers.
    textures = {
        role: {"url": url(t["web_key"]), "width_mm": t["width_mm"], "height_mm": t["height_mm"], "color": t.get("color"),
               "clear": t.get("clear", False),
               "masks": {k: url(v) for k, v in (t.get("masks") or {}).items()},
               "transform": adj.panels[role].transform() if role in adj.panels else None,
               # the texture before overlays / colour correction were baked in: the job page edits on top of it
               "raw_url": url(t["raw_web_key"]) if t.get("raw_web_key") else None}
        for role, t in steps["texture"].output["textures"].items()
    }
    # The uploads the adjustments refer to (panel pictures, logos): name and preview for the job page.
    ids = {p.file_id for p in adj.panels.values() if p.file_id} | {o.file_id for p in adj.panels.values() for o in p.overlays if o.file_id}
    files = {f.id: {"filename": f.filename, "kind": panel_art.kind_of(f.filename) or "pdf", "preview_url": f"/api/uploads/{f.id}/preview"}
             for f in session.scalars(select(UploadedFile).where(UploadedFile.id.in_(ids)))} if ids else {}
    return {"job_id": job_id, "geometry": steps["build_geometry"].output["geometry"], "textures": textures, "adjust": adj.model_dump(), "files": files}


class ArtworkOut(BaseModel):
    file_id: int
    filename: str
    kind: str  # image / pdf
    width_px: int
    height_px: int
    preview_url: str


@router.post("/jobs/{job_id}/artwork")
async def artwork_upload(job_id: int, file: UploadFile = File(...), session: Session = Depends(get_session),
                         user: User = Depends(auth.current_user)) -> ArtworkOut:
    """A picture or PDF for the job page's editing: a panel's new artwork or a logo overlay. Only
    registered here; the adjust call that places it reruns the job."""
    job = _job(session, job_id)
    data = await file.read()
    if len(data) > get_settings().max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"{file.filename} is larger than {get_settings().max_upload_mb} MB")
    f = register_artwork(session, file.filename or "artwork.png", data, user)
    try:
        img = panel_art.open_upload(data, dpi=72, max_side=4096)
    except Exception as exc:  # noqa: BLE001 - a corrupt upload is the operator's problem to see
        raise HTTPException(422, f"{file.filename}: cannot be opened as an image or PDF ({exc})") from exc
    _event(session, job, f"Artwork uploaded on the job page: {f.filename}", user, data={"sha256": f.sha256, "file_id": f.id})
    session.commit()
    return ArtworkOut(file_id=f.id, filename=f.filename, kind=panel_art.kind_of(f.filename) or "pdf", width_px=img.width, height_px=img.height,
                      preview_url=f"/api/uploads/{f.id}/preview")


@router.get("/uploads/{file_id}/preview")
def upload_preview(file_id: int, session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> Response:
    """A PNG (at most 2048 px) of an upload for the job page's live preview; pictures small enough are served as they are."""
    f = session.get(UploadedFile, file_id)
    if f is None:
        raise HTTPException(404, "No such file")
    storage = get_storage()
    try:
        data = storage.get_bytes(f.storage_key)
    except (FileNotFoundError, OSError, KeyError) as exc:
        raise HTTPException(404, "File not found") from exc
    headers = {"Cache-Control": "private, max-age=86400"}
    if panel_art.kind_of(f.filename, data) == "image" and len(data) <= 4 * 1024 * 1024:
        return Response(data, media_type=panel_art.media_type(f.filename), headers=headers)
    key = f"uploads/previews/{f.sha256}.png"
    if not storage.exists(key):
        storage.put_bytes(key, panel_art.preview_png(data), "image/png")
    return Response(storage.get_bytes(key), media_type="image/png", headers=headers)


def job_adjustments(session: Session, job: Job) -> Adjustments:
    """The job's adjustments over the item's saved default (outside a workflow step)."""
    from app.workflow.context import StepContext

    ctx = StepContext(session=session, job=job, storage=None, settings=get_settings())  # type: ignore[arg-type]
    return adjustments(ctx)


class AdjustIn(BaseModel):
    adjust: Adjustments = Adjustments()
    save_item_default: bool = False  # admin: also store panels / material / scene / keyline on the item
    reset: bool = False  # back to the automatic result (item default kept)
    note: str = ""


@router.post("/jobs/{job_id}/adjust")
def adjust(job_id: int, body: AdjustIn, session: Session = Depends(get_session), user: User = Depends(auth.current_user)) -> JobSummary:
    """Apply job-page adjustments and rerun the job from the first step they change."""
    job = _job(session, job_id)
    if job.status == "RUNNING":
        raise HTTPException(409, "The job is running (pause or cancel it first)")
    job.control = None
    inputs = dict(job.inputs or {})
    if body.reset:
        for key in ("adjust", "keyline_overrides", "spec_corrections", "panel_choices"):
            inputs.pop(key, None)
        from_step = "extract_specs"
        _event(session, job, "Adjustments reset to the automatic result", user)
    else:
        adj = body.adjust
        windows_before = (inputs.get("adjust") or {}).get("windows") or None
        inputs["adjust"] = adj.model_dump(mode="json", exclude_unset=False)
        if adj.specs:
            inputs["spec_corrections"] = {**inputs.get("spec_corrections", {}), **{f"spec_table.{k}": v for k, v in adj.specs.items()}}
        if adj.keyline:
            inputs["keyline_overrides"] = {**inputs.get("keyline_overrides", {}), **adj.keyline}
        from_step = adj.earliest_step(windows_changed=windows_before != (inputs["adjust"].get("windows") or None))
        _event(session, job, "Adjustments applied" + (f": {body.note}" if body.note else ""), user, data=adj.model_dump(exclude_defaults=True))
        if body.save_item_default:
            if user.role != "admin":
                raise HTTPException(403, "Only administrators can save item defaults")
            if not job.item_code:
                raise HTTPException(422, "The job has no item code to save defaults for")
            key = job.item_code.lower()
            current = store.get_version(session, "item_override", key)
            data = dict(current.data) if current else {}
            data["adjustments"] = adj.model_copy(update={"specs": {}, "keyline": {}}).model_dump()
            data["keyline_overrides"] = {**data.get("keyline_overrides", {}), **adj.keyline}
            version = store.save(session, "item_override", key, data, store.Author.of(user), body.note or f"job #{job.id} adjustments saved as item default")
            # This job keeps following the default it just created (its index snapshot is otherwise pinned).
            snapshot = {k: dict(v) for k, v in (job.index_snapshot or {}).items()}
            snapshot.setdefault("item_override", {})[key] = version.version
            job.index_snapshot = snapshot
            _event(session, job, f"Adjustments saved as the default for {job.item_code} (item_override v{version.version})", user)
    job.inputs, job.status, job.updated_at = inputs, "QUEUED", utcnow()
    session.commit()
    queue.enqueue(job.id, from_step)
    return _summary(job)


@router.get("/jobs/{job_id}/file")
def job_file(job_id: int, key: str, request: Request, session: Session = Depends(get_session)) -> Response:
    _authorized_for_job(request, session, job_id)
    if not key.startswith(f"jobs/{job_id}/") or ".." in key:
        raise HTTPException(403, "Not a file of this job")
    try:
        data = get_storage().get_bytes(key)
    except (FileNotFoundError, OSError, KeyError) as exc:
        raise HTTPException(404, "File not found") from exc
    media = mimetypes.guess_type(key)[0] or ("model/gltf-binary" if key.endswith(".glb") else "application/octet-stream")
    return Response(data, media_type=media, headers={"Cache-Control": "private, max-age=300"})


@router.get("/uploads/{file_id}/pdf")
def original_pdf(file_id: int, session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> Response:
    f = session.get(UploadedFile, file_id)
    if f is None:
        raise HTTPException(404, "No such file")
    return Response(get_storage().get_bytes(f.storage_key), media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{f.filename}"'})


# ---------------------------------------------------------------- review, rerun, approve
class ReviewIn(BaseModel):
    action: Literal["specs", "pouch_type", "keyline", "panels", "texture", "workflow_review"]
    corrections: dict[str, Any] = {}  # specs
    acknowledge: list[str] = []  # specs / texture: "<code>@<field>"
    pouch_type: str | None = None
    keyline_overrides: dict[str, Any] = {}
    panel_choices: dict[str, dict] = {}
    node: str | None = None  # workflow_review: the REVIEW node
    edge: str | None = None  # workflow_review: the chosen branch (when the node has several)
    note: str = ""


RESUME_FROM = auto_review.RESUME_FROM


@router.post("/jobs/{job_id}/review")
def review(job_id: int, body: ReviewIn, session: Session = Depends(get_session), user: User = Depends(auth.current_user)) -> JobSummary:
    job = _job(session, job_id)
    if job.status != "NEEDS_REVIEW":
        # (an answer sent a moment after another operator's, or after a cancel, must not restart the job)
        raise HTTPException(409, f"The job is not waiting for a review (it is {job.status})")
    if body.action == "pouch_type" and not body.pouch_type:
        raise HTTPException(422, "Pick a pouch type")
    if body.action == "workflow_review":
        node = body.node or ((job.review or {}).get("node"))
        if not node:
            raise HTTPException(422, "Which review node is being answered?")
        choices = {c["edge"] for c in ((job.review or {}).get("details") or {}).get("choices", [])}
        if len(choices) > 1 and body.edge not in choices:
            raise HTTPException(422, "Pick one of the branches")
    step = auto_review.submit(session, job, body.model_dump(), user.email, STEPS)
    _event(session, job, f"Review '{body.action}' submitted" + (f": {body.note}" if body.note else ""), user,
           data=body.model_dump(exclude_defaults=True))
    session.commit()
    queue.enqueue(job.id, step)
    return _summary(job)


@router.post("/jobs/{job_id}/panel-file")
async def panel_file(job_id: int, role: str = Form(...), file: UploadFile = File(...), session: Session = Depends(get_session),
                     user: User = Depends(auth.current_user)) -> JobSummary:
    job = _job(session, job_id)
    f = register_file(session, file.filename or f"{role}.pdf", await file.read(), None, user)
    inputs = dict(job.inputs or {})
    inputs["panel_choices"] = {**inputs.get("panel_choices", {}), role: {"file_id": f.id}}
    job.inputs, job.status = inputs, "QUEUED"
    _event(session, job, f"{role} panel uploaded: {f.filename}", user, data={"sha256": f.sha256})
    session.commit()
    queue.enqueue(job.id, "link_panels")
    return _summary(job)


class RerunIn(BaseModel):
    from_step: str | None = None  # an engine step ...
    from_node: str | None = None  # ... or a node of the job's workflow
    latest_index: bool = False
    output_preset: str | None = None  # render with another output preset (reruns from build_geometry at the latest)


@router.post("/jobs/{job_id}/rerun")
def rerun(job_id: int, body: RerunIn, session: Session = Depends(get_session), user: User = Depends(auth.current_user)) -> JobSummary:
    job = _job(session, job_id)
    if body.from_step is not None and body.from_step not in STEPS:
        raise HTTPException(422, f"Unknown step {body.from_step}")
    if body.from_node is not None:
        graph, _k, _v = runner.load_graph(session, job)
        if graph.node(body.from_node) is None:
            raise HTTPException(422, f"Node {body.from_node!r} is not in this job's workflow")
    if body.from_step is None and body.from_node is None:
        raise HTTPException(422, "Say which step or node to rerun from")
    if job.status == "RUNNING":
        raise HTTPException(409, "The job is running (pause or cancel it first)")
    job.control = None  # a rerun of a paused / cancelled job starts it again
    if body.latest_index:
        if user.role != "admin":
            raise HTTPException(403, "Only administrators can re-render on the latest index")
        job.index_snapshot = store.snapshot(session)
        if job.kind != "test":
            job.workflow_version = None  # the latest published version of its workflow, too
        _event(session, job, "Index snapshot moved to the latest versions", user)
    from_step = body.from_step
    if body.output_preset:
        if body.output_preset not in (job.index_snapshot or {}).get("output_preset", {}):
            raise HTTPException(422, f"Output preset {body.output_preset!r} is not in this job's index snapshot")
        job.inputs = {**(job.inputs or {}), "output_preset": body.output_preset}
        if from_step is None or STEPS.index(from_step) > STEPS.index("build_geometry"):
            from_step = "build_geometry"
        _event(session, job, f"Output preset set to {body.output_preset}", user)
    if from_step is None or STEPS.index(from_step) <= STEPS.index("extract_specs"):
        # The drawing is measured again: confirmations of the old measurement (measured_keyline.*)
        # would be applied to the new one. Spec-table values the operator typed stay.
        corrections = dict((job.inputs or {}).get("spec_corrections") or {})
        stale = [k for k in corrections if k.startswith("measured_keyline.")]
        if stale:
            for k in stale:
                corrections.pop(k)
            job.inputs = {**(job.inputs or {}), "spec_corrections": corrections}
            _event(session, job, f"{len(stale)} confirmed keyline measurement(s) dropped: the drawing is measured again", user, data={"dropped": stale})
    job.status, job.updated_at = "QUEUED", utcnow()
    _event(session, job, f"Rerun from {from_step or 'node ' + str(body.from_node)}", user)
    session.commit()
    queue.enqueue(job.id, from_step, body.from_node)
    return _summary(job)


RUNNING_STATES = ("QUEUED", "RUNNING")


@router.post("/jobs/{job_id}/pause")
def pause(job_id: int, session: Session = Depends(get_session), user: User = Depends(auth.current_user)) -> JobSummary:
    """Stop the job: a running one after the step it is on, a queued one at once. Resume continues
    from the next step (everything already done is kept)."""
    job = _job(session, job_id)
    if job.status not in RUNNING_STATES:
        raise HTTPException(409, f"Only a queued or running job can be paused (this one is {job.status})")
    if job.status == "RUNNING":
        job.control = "pause"  # the worker acts on it between steps
        _event(session, job, "Pause requested (stops after the current step)", user)
    else:
        job.status, job.control, job.updated_at = "PAUSED", None, utcnow()
        _event(session, job, "Paused", user)
    session.commit()
    return _summary(job)


@router.post("/jobs/{job_id}/resume")
def resume(job_id: int, session: Session = Depends(get_session), user: User = Depends(auth.current_user)) -> JobSummary:
    job = _job(session, job_id)
    if job.status != "PAUSED":
        raise HTTPException(409, f"Only a paused job can be resumed (this one is {job.status})")
    job.control, job.status, job.updated_at = None, "QUEUED", utcnow()
    _event(session, job, "Resumed", user)
    session.commit()
    queue.enqueue(job.id)
    return _summary(job)


@router.post("/jobs/{job_id}/cancel")
def cancel(job_id: int, session: Session = Depends(get_session), user: User = Depends(auth.current_user)) -> JobSummary:
    """Stop the job. A running one stops after its current step; a rerun from any step starts it again."""
    job = _job(session, job_id)
    if job.status in ("DONE", "CANCELLED"):
        raise HTTPException(409, f"The job is already {job.status}")
    if job.status == "RUNNING":
        job.control = "cancel"  # the worker acts on it between steps
        _event(session, job, "Cancel requested (stops after the current step)", user)
    else:
        job.status, job.review, job.control, job.current_node, job.updated_at = "CANCELLED", None, None, None, utcnow()
        _event(session, job, "Cancelled", user)
    session.commit()
    return _summary(job)


@router.post("/jobs/{job_id}/approve")
def approve(job_id: int, session: Session = Depends(get_session), user: User = Depends(auth.require_admin)) -> JobSummary:
    job = _job(session, job_id)
    if job.status != "DONE":
        raise HTTPException(409, "Only finished jobs can be approved")
    job.approved_by, job.approved_at = user.email, utcnow()
    _event(session, job, "Mockups approved", user)
    session.commit()
    return _summary(job)


# ---------------------------------------------------------------- download
def audit_record(session: Session, job: Job) -> dict:
    steps = {s.step: s for s in session.scalars(select(JobStep).where(JobStep.job_id == job.id))}
    out = lambda n: steps[n].output if n in steps and steps[n].output else {}  # noqa: E731
    panels = out("link_panels").get("panels", {})
    files = [{"role": "front", "filename": job.file.filename, "sha256": job.file.sha256}]
    for role, p in panels.items():
        if role != "front" and p.get("file_id"):
            f = session.get(UploadedFile, p["file_id"])
            entry = {"role": role, "filename": f.filename, "sha256": f.sha256}
            if p.get("source") in ("sheet", "blank"):  # printed on the job's own sheet, cut out of it
                entry["from_sheet"] = True
            files.append(entry)
        elif role != "front":
            files.append({"role": role, "substitute": p.get("source"), "color": p.get("color")})
    return {
        "job_id": job.id, "item_code": job.item_code, "client": job.client_name, "status": job.status,
        "input_files": files,
        "extracted": out("extract_specs").get("sheet"),
        "operator_inputs": job.inputs,
        "validated": out("validate").get("sheet"),
        "pouch_type": {"key": job.pouch_type, "source": out("match_pouch_type").get("source"),
                       "version": out("match_pouch_type").get("pouch_type_version")},
        "keyline": {"template": job.keyline_template, "version": job.keyline_version, "values": out("resolve_keyline").get("keyline")},
        "workflow": {"key": job.workflow_key, "version": job.workflow_version, "path": job.workflow_path or []},
        "index_snapshot": job.index_snapshot,
        "outputs": out("export").get("files", []),
        "approved_by": job.approved_by, "approved_at": job.approved_at,
        "events": [{"at": e.created_at, "message": e.message} for e in session.scalars(
            select(JobEvent).where(JobEvent.job_id == job.id, JobEvent.level == "audit").order_by(JobEvent.id))],
    }


@router.get("/jobs/{job_id}/audit")
def audit(job_id: int, session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> dict:
    return audit_record(session, _job(session, job_id))


@router.get("/jobs/{job_id}/download.zip")
def download_zip(job_id: int, session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> StreamingResponse:
    job = _job(session, job_id)
    row = session.scalar(select(JobStep).where(JobStep.job_id == job_id, JobStep.step == "export", JobStep.status == "done"))
    if row is None:
        raise HTTPException(409, "The job has no exports yet")
    storage = get_storage()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in row.output["files"]:
            zf.writestr(f["name"], storage.get_bytes(f["key"]))
        zf.writestr("data/audit.json", json.dumps(audit_record(session, job), indent=1, default=str))
    buf.seek(0)
    name = f"{job.item_code or 'job'}_{job.id}_mockups.zip"
    return StreamingResponse(buf, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}"'})
