"""Index admin API (spec section 3). Reads: any signed-in user. Writes: admins only."""

import json
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import auth
from app.db import get_session
from app.index import store
from app.index.conditions import spec_context
from app.index.resolve import (
    MatchResult, ResolvedKeyline, ResolvedMaterials, find_client, match_pouch_type, resolve_keyline, resolve_materials,
)
from app.index.schemas import KIND_LABELS, KIND_PAGES, KINDS, SINGLETONS, STANDARD_KEYLINE_FIELDS, json_schema
from app.models import User
from app.specs.schema import SpecSheet

router = APIRouter(prefix="/api/index")
SAMPLE_SPEC = Path(__file__).resolve().parents[1] / "index" / "seed" / "sample_spec_FGPO7215.json"


def _kind(kind: str) -> str:
    if kind not in KINDS:
        raise HTTPException(404, f"Unknown index kind {kind!r}")
    return kind


def _problems(exc: store.IndexError_) -> HTTPException:
    return HTTPException(422, {"problems": exc.problems})


class VersionOut(BaseModel):
    version: int
    action: str
    reason: str
    author: str
    created_at: datetime


class EntrySummary(BaseModel):
    kind: str
    key: str
    name: str
    version: int
    archived: bool
    updated_at: datetime
    author: str
    extra: dict[str, Any] = {}  # a few fields of the entry the list page groups or shows by


# Fields shown on the list pages (pouch types are grouped by their place in the catalog).
LIST_EXTRA: dict[str, list[str]] = {
    "pouch_type": ["form", "style", "sealing_type", "geometry_template", "priority", "active", "thumbnail"],
    "field": ["label", "kind", "required", "order", "stop", "section", "source", "min_confidence"],
    "standard_size": ["pouch_type", "width_mm", "height_mm", "gusset_mm", "tolerance_mm"],
    "material": ["surface", "priority"],
    "workflow": ["description"],
}


class EntryOut(BaseModel):
    kind: str
    key: str
    version: int
    current_version: int
    archived: bool
    data: dict
    yaml: str
    meta: VersionOut


def _version_out(v) -> VersionOut:
    return VersionOut(version=v.version, action=v.action, reason=v.reason, author=v.author_email, created_at=v.created_at)


@router.get("/kinds")
def kinds(session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> list[dict]:
    counts: dict[str, int] = {}
    for entry, _v in store.list_entries(session):
        counts[entry.kind] = counts.get(entry.kind, 0) + 1
    return [{"kind": k, "label": KIND_LABELS[k], "singleton": k in SINGLETONS, "count": counts.get(k, 0), "page": KIND_PAGES.get(k)} for k in KINDS]


@router.get("/schema/{kind}")
def schema(kind: str, _: User = Depends(auth.current_user)) -> dict:
    return {"schema": json_schema(_kind(kind)), "standard_keyline_fields": STANDARD_KEYLINE_FIELDS}


@router.get("/export", response_class=PlainTextResponse)
def export(session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> PlainTextResponse:
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    return PlainTextResponse(
        store.export_yaml(session), media_type="application/x-yaml",
        headers={"Content-Disposition": f'attachment; filename="index-{stamp}.yaml"'},
    )


class ImportIn(BaseModel):
    yaml: str
    reason: str = ""
    archive_missing: bool = False
    dry_run: bool = True


@router.post("/import")
def import_yaml(body: ImportIn, session: Session = Depends(get_session), user: User = Depends(auth.require_admin)) -> dict:
    try:
        plan = store.plan_import(session, body.yaml, body.archive_missing)
        if not body.dry_run:
            store.apply_import(session, plan, store.Author.of(user), body.reason)
            session.commit()
    except store.IndexError_ as exc:
        session.rollback()
        raise _problems(exc) from exc
    fmt = lambda keys: [f"{k}/{n}" for k, n in keys]  # noqa: E731
    return {
        "applied": not body.dry_run,
        "created": fmt(plan.created), "updated": fmt(plan.updated),
        "unchanged": fmt(plan.unchanged), "archived": fmt(plan.archived), "diffs": plan.diffs,
    }


class TestIn(BaseModel):
    spec_sheet: SpecSheet
    panels: list[str] = []
    pouch_type: str | None = None  # force a type (what the operator's type picker does)


class TestOut(BaseModel):
    context: dict
    client: str | None
    item_override: str | None
    match: MatchResult
    keyline: ResolvedKeyline | None
    keyline_version: int | None
    materials: ResolvedMaterials
    index_snapshot: dict[str, dict[str, int]]


@router.get("/sample-spec")
def sample_spec(_: User = Depends(auth.current_user)) -> dict:
    """The FGPO7215 extraction from Phase 1, for trying rules in the admin UI."""
    return json.loads(SAMPLE_SPEC.read_text(encoding="utf-8"))


@router.post("/test")
def test_rules(body: TestIn, session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> TestOut:
    """Run matching, keyline resolution and materials for a spec sheet against the current index."""
    index = store.load_all(session)
    ctx = spec_context(body.spec_sheet, body.panels)
    client_key, client = find_client(index["client"], ctx["spec"].get("client_name"))
    item_key = (ctx["spec"].get("item_no") or "").lower()
    item = index["item_override"].get(item_key)
    match = match_pouch_type(index["pouch_type"], ctx, item)
    chosen = body.pouch_type or match.pouch_type
    keyline = version = None
    if chosen:
        if chosen not in index["pouch_type"]:
            raise HTTPException(422, f"Unknown pouch type {chosen!r}")
        kt_key = index["pouch_type"][chosen].keyline_template
        keyline = resolve_keyline(kt_key, index["keyline_template"][kt_key], chosen, ctx, client, item)
        version = store.get_entry(session, "keyline_template", kt_key).current_version
    return TestOut(
        context=ctx, client=client_key, item_override=item_key if item else None, match=match, keyline=keyline,
        keyline_version=version, materials=resolve_materials(index["material"], ctx), index_snapshot=store.snapshot(session),
    )


@router.post("/test-fields")
async def test_fields(file: UploadFile = File(...), fields: str = Form(""), session: Session = Depends(get_session),
                      _: User = Depends(auth.current_user)) -> dict:
    """Field dictionary tester: read one PDF's spec table with the current dictionary (plus unsaved
    edits passed as JSON {key: entry}) and return every field's value, confidence and cell crop."""
    from app.pdf import raise_stream_limits

    raise_stream_limits()
    import base64
    import io
    import shutil
    import uuid

    from PIL import Image
    from pypdf import PdfReader

    from app.config import get_settings
    from app.errors import NeedsReview
    from app.index.fields import FieldDef
    from app.pdf.profile import PdfProfile
    from app.pdf.sheet import artwork_page, single_page_copy
    from app.specs.validate import ValidationRules
    from app.steps import extract_specs, trim_artwork
    from app.storage import LocalStorage
    from app.workflow.context import compose_profile

    index = store.load_all(session)
    dictionary: dict[str, FieldDef] = dict(index["field"])  # type: ignore[arg-type]
    if fields.strip():
        try:
            for key, data in json.loads(fields).items():
                dictionary[key] = FieldDef.model_validate(data)
        except (ValueError, TypeError) as exc:  # JSON errors and pydantic ValidationError are ValueErrors
            raise HTTPException(422, {"problems": [f"fields: {exc}"]}) from exc
    profile = compose_profile(index["pdf_profile"].get("default") or PdfProfile(), dictionary)  # type: ignore[arg-type]
    rules: ValidationRules = index["validation_rules"].get("default") or ValidationRules()  # type: ignore[assignment]
    data = await file.read()
    if not data.startswith(b"%PDF-"):
        raise HTTPException(422, f"{file.filename} is not a PDF")
    root = get_settings().work_dir / "field_tests" / uuid.uuid4().hex
    root.mkdir(parents=True, exist_ok=True)
    try:
        pdf = root / (file.filename or "test.pdf")
        pdf.write_bytes(data)
        if len(PdfReader(pdf).pages) > 1:
            one = root / "page.pdf"
            single_page_copy(pdf, one, artwork_page(pdf))
            pdf = one
        storage = LocalStorage(root / "out")
        try:
            trim = trim_artwork.run(trim_artwork.TrimArtworkInput(pdf_path=pdf, filename=file.filename or pdf.name, panel="front", key_prefix="t"), profile, storage)
            specs = extract_specs.run(extract_specs.ExtractSpecsInput(
                pdf_path=pdf, filename=file.filename or pdf.name, key_prefix="t", trim_width_mm=trim.trim_width_mm,
                trim_height_mm=trim.trim_height_mm, sheet_image_key=trim.bleed_key), profile, rules, storage)  # type: ignore[arg-type]
        except NeedsReview as exc:
            raise HTTPException(422, {"problems": [exc.message, *[p.get("message", "") for p in exc.details.get("problems", [])]]}) from exc
        image = Image.open(storage.path(specs.spec_image_key)).convert("RGB")
        out = []
        table = specs.sheet.spec_table
        for name, cell in specs.cells.items():
            column = getattr(table, name, None)
            crop = None
            if cell.bbox_px:
                x0, y0, x1, y1 = cell.bbox_px
                pad = 12
                box = image.crop((max(0, x0 - pad), max(0, y0 - pad), min(image.width, x1 + pad), min(image.height, y1 + pad)))
                if box.width > 700:
                    box = box.resize((700, max(1, int(box.height * 700 / box.width))))
                buf = io.BytesIO()
                box.save(buf, format="PNG")
                crop = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
            value = getattr(column, "value", None)
            if hasattr(value, "value"):
                value = value.value
            if name == "layers" and value:
                value = [f"{l.micron:g} mic {l.material}" if l.micron else l.material for l in value]
            entry = dictionary.get(name)
            out.append({
                "key": name, "name": entry.name if entry else name, "label": entry.label if entry else "", "value": value,
                "confidence": getattr(column, "confidence", cell.confidence), "raw": cell.raw, "source": cell.source,
                "format_ok": cell.format_ok, "reason": cell.reason, "crop": crop,
                "threshold": entry.min_confidence if entry and entry.min_confidence is not None else rules.min_confidence,
                "required": bool(entry and entry.required),
            })
        order = {k: f.order for k, f in dictionary.items()}
        out.sort(key=lambda r: (order.get(r["key"], 9999), r["key"]))
        return {
            "filename": file.filename, "mode": specs.mode, "text_source": specs.text_source, "roll_form": specs.roll_form,
            "fields": out, "linked_codes": specs.sheet.linked_codes, "inks": table.inks.value,
            "issues": [i.model_dump() for i in specs.report.issues],
        }
    finally:
        shutil.rmtree(root, ignore_errors=True)


@router.get("/{kind}")
def list_kind(kind: str, include_archived: bool = False, session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> list[EntrySummary]:
    out = []
    for entry, v in store.list_entries(session, _kind(kind), include_archived):
        out.append(EntrySummary(
            kind=entry.kind, key=entry.key, name=str(v.data.get("name") or v.data.get("client_name") or entry.key),
            version=entry.current_version, archived=entry.archived, updated_at=entry.updated_at, author=v.author_email,
            extra={k: v.data.get(k) for k in LIST_EXTRA.get(kind, []) if k in v.data},
        ))
    return out


@router.get("/{kind}/{key}")
def get_entry(kind: str, key: str, version: int | None = None, session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> EntryOut:
    v = store.get_version(session, _kind(kind), key, version)
    if v is None:
        raise HTTPException(404, f"{kind} {key} not found")
    return EntryOut(kind=kind, key=key, version=v.version, current_version=v.entry.current_version, archived=v.entry.archived,
                    data=v.data, yaml=store.to_yaml(v.data), meta=_version_out(v))


class SaveIn(BaseModel):
    data: dict[str, Any] | None = None
    yaml: str | None = None  # alternative to data: the entry as YAML text
    reason: str


@router.put("/{kind}/{key}")
def save_entry(kind: str, key: str, body: SaveIn, session: Session = Depends(get_session), user: User = Depends(auth.require_admin)) -> EntryOut:
    data = body.data
    if body.yaml is not None:
        try:
            data = yaml.safe_load(body.yaml) or {}
        except yaml.YAMLError as exc:
            raise HTTPException(422, {"problems": [f"YAML syntax: {exc}"]}) from exc
    if not isinstance(data, dict):
        raise HTTPException(422, {"problems": ["entry must be a mapping"]})
    try:
        author = store.Author.of(user)
        if kind == "output_preset" and data.get("is_default"):
            # Moving the default: the previous default gets a version of its own with the same reason.
            for other, version in store.list_entries(session, "output_preset"):
                if other.key != key and version.data.get("is_default"):
                    session.add(other)
                    store._append(session, other, {**version.data, "is_default": False}, "update", f"{body.reason} (default moved to {key})", author)
        store.save(session, _kind(kind), key, data, author, body.reason)
        session.commit()
    except store.IndexError_ as exc:
        session.rollback()
        raise _problems(exc) from exc
    return get_entry(kind, key, None, session, user)


class ReasonIn(BaseModel):
    reason: str


@router.delete("/{kind}/{key}")
def archive_entry(kind: str, key: str, body: ReasonIn, session: Session = Depends(get_session), user: User = Depends(auth.require_admin)) -> dict:
    try:
        store.archive(session, _kind(kind), key, store.Author.of(user), body.reason)
        session.commit()
    except store.IndexError_ as exc:
        session.rollback()
        raise _problems(exc) from exc
    return {"archived": True}


@router.get("/{kind}/{key}/history")
def history(kind: str, key: str, session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> list[VersionOut]:
    return [_version_out(v) for v in store.history(session, _kind(kind), key)]


@router.get("/{kind}/{key}/diff", response_class=PlainTextResponse)
def diff(kind: str, key: str, a: int, b: int | None = None, session: Session = Depends(get_session), _: User = Depends(auth.current_user)) -> str:
    va, vb = store.get_version(session, _kind(kind), key, a), store.get_version(session, kind, key, b)
    if va is None or vb is None:
        raise HTTPException(404, "version not found")
    return store.diff(va.data, vb.data)


class RestoreIn(BaseModel):
    version: int
    reason: str


@router.post("/{kind}/{key}/restore")
def restore(kind: str, key: str, body: RestoreIn, session: Session = Depends(get_session), user: User = Depends(auth.require_admin)) -> EntryOut:
    try:
        store.restore(session, _kind(kind), key, body.version, store.Author.of(user), body.reason)
        session.commit()
    except store.IndexError_ as exc:
        session.rollback()
        raise _problems(exc) from exc
    return get_entry(kind, key, None, session, user)
