"""Versioned index store: every change is a new version with author, time and reason."""

import difflib
from dataclasses import dataclass
from typing import Any

import yaml
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.index.schemas import KINDS, cross_check, validate_entry
from app.models import IndexEntry, IndexVersion, User, utcnow


class IndexError_(ValueError):
    """A save/import was rejected; `problems` lists every reason (shown in the admin UI)."""

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


@dataclass
class Author:
    id: int | None
    email: str

    @classmethod
    def of(cls, user: User | None) -> "Author":
        return cls(user.id, user.email) if user else cls(None, "system")


def _errors(exc: ValidationError) -> list[str]:
    return [f"{'.'.join(str(p) for p in e['loc']) or '(root)'}: {e['msg']}" for e in exc.errors()]


def normalize(kind: str, key: str, data: dict) -> dict:
    """Validate and return the canonical JSON form (defaults filled in) that is stored."""
    try:
        model = validate_entry(kind, key, data)
    except ValidationError as exc:
        raise IndexError_([f"{kind} {key}: {m}" for m in _errors(exc)]) from exc
    except ValueError as exc:
        raise IndexError_([f"{kind} {key}: {exc}"]) from exc
    return model.model_dump(mode="json")


def get_entry(session: Session, kind: str, key: str) -> IndexEntry | None:
    return session.scalar(select(IndexEntry).where(IndexEntry.kind == kind, IndexEntry.key == key))


def get_version(session: Session, kind: str, key: str, version: int | None = None) -> IndexVersion | None:
    entry = get_entry(session, kind, key)
    if entry is None:
        return None
    number = version or entry.current_version
    return session.scalar(select(IndexVersion).where(IndexVersion.entry_id == entry.id, IndexVersion.version == number))


def list_entries(session: Session, kind: str | None = None, include_archived: bool = False) -> list[tuple[IndexEntry, IndexVersion]]:
    q = select(IndexEntry).options(selectinload(IndexEntry.versions)).order_by(IndexEntry.kind, IndexEntry.key)
    if kind:
        q = q.where(IndexEntry.kind == kind)
    if not include_archived:
        q = q.where(IndexEntry.archived.is_(False))
    out = []
    for entry in session.scalars(q):
        current = next(v for v in entry.versions if v.version == entry.current_version)
        out.append((entry, current))
    return out


def load_all(session: Session, overrides: dict[tuple[str, str], dict | None] | None = None) -> dict[str, dict[str, BaseModel]]:
    """Current (non-archived) entries as models, optionally with pending changes applied."""
    loaded: dict[str, dict[str, BaseModel]] = {k: {} for k in KINDS}
    for entry, version in list_entries(session):
        if entry.kind in KINDS:  # a kind removed from the code stays in the table, harmless
            loaded[entry.kind][entry.key] = KINDS[entry.kind].model_validate(version.data)
    for (kind, key), data in (overrides or {}).items():
        if data is None:
            loaded[kind].pop(key, None)
        else:
            loaded[kind][key] = KINDS[kind].model_validate(data)
    return loaded


def _append(session: Session, entry: IndexEntry, data: dict, action: str, reason: str, author: Author) -> IndexVersion:
    number = entry.current_version + 1
    version = IndexVersion(entry=entry, version=number, data=data, action=action, reason=reason,
                           author_id=author.id, author_email=author.email)
    entry.current_version = number
    entry.updated_at = utcnow()
    session.add(version)
    return version


def save(session: Session, kind: str, key: str, data: dict, author: Author, reason: str, action: str | None = None) -> IndexVersion:
    """Create or update an entry. Returns the (possibly unchanged) current version."""
    if not reason.strip():
        raise IndexError_(["a reason is required for every index change"])
    clean = normalize(kind, key, data)
    problems = cross_check(load_all(session, {(kind, key): clean}))
    if problems:
        raise IndexError_(problems)
    entry = get_entry(session, kind, key)
    if entry is None:
        entry = IndexEntry(kind=kind, key=key, current_version=0)
        session.add(entry)
        return _append(session, entry, clean, action or "create", reason, author)
    current = get_version(session, kind, key)
    if current is not None and current.data == clean and not entry.archived:
        return current  # nothing changed: no new version
    was_archived, entry.archived = entry.archived, False
    return _append(session, entry, clean, action or ("restore" if was_archived else "update"), reason, author)


def archive(session: Session, kind: str, key: str, author: Author, reason: str) -> IndexVersion:
    entry = get_entry(session, kind, key)
    if entry is None or entry.archived:
        raise IndexError_([f"{kind} {key} does not exist"])
    if not reason.strip():
        raise IndexError_(["a reason is required for every index change"])
    problems = cross_check(load_all(session, {(kind, key): None}))
    if problems:
        raise IndexError_(problems)
    current = get_version(session, kind, key)
    entry.archived = True
    return _append(session, entry, current.data, "archive", reason, author)


def restore(session: Session, kind: str, key: str, version: int, author: Author, reason: str) -> IndexVersion:
    old = get_version(session, kind, key, version)
    if old is None:
        raise IndexError_([f"{kind} {key} has no version {version}"])
    return save(session, kind, key, old.data, author, reason or f"restore version {version}", action="restore")


def history(session: Session, kind: str, key: str) -> list[IndexVersion]:
    entry = get_entry(session, kind, key)
    return list(reversed(entry.versions)) if entry else []


def to_yaml(data: Any) -> str:
    return yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=100)


def diff(old: dict | None, new: dict | None) -> str:
    a = to_yaml(old).splitlines() if old is not None else []
    b = to_yaml(new).splitlines() if new is not None else []
    return "\n".join(difflib.unified_diff(a, b, "before", "after", lineterm=""))


def snapshot(session: Session) -> dict[str, dict[str, int]]:
    """{kind: {key: version}} of the current index; jobs store this to re-render identically."""
    out: dict[str, dict[str, int]] = {}
    for entry, _ in list_entries(session):
        out.setdefault(entry.kind, {})[entry.key] = entry.current_version
    return out


# ---------------------------------------------------------------- YAML import / export
def export_yaml(session: Session) -> str:
    doc: dict[str, dict[str, Any]] = {}
    for entry, version in list_entries(session):
        doc.setdefault(entry.kind, {})[entry.key] = version.data
    header = "# Pouch mockup index export. Import with the admin UI; every change becomes a new version.\n"
    return header + to_yaml({"index_format": 1, **doc})


@dataclass
class ImportPlan:
    created: list[tuple[str, str]]
    updated: list[tuple[str, str]]
    unchanged: list[tuple[str, str]]
    archived: list[tuple[str, str]]
    diffs: dict[str, str]
    data: dict[tuple[str, str], dict]


def plan_import(session: Session, text: str, archive_missing: bool = False) -> ImportPlan:
    """Validate a whole YAML file and compute what applying it would change. Writes nothing."""
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise IndexError_([f"YAML syntax: {exc}"]) from exc
    if not isinstance(doc, dict):
        raise IndexError_(["YAML must be a mapping of kind -> key -> entry"])
    doc.pop("index_format", None)
    problems: list[str] = []
    incoming: dict[tuple[str, str], dict] = {}
    for kind, entries in doc.items():
        if str(kind).startswith("x-"):
            continue  # holders for YAML anchors (shared blocks), not entries

        if kind not in KINDS:
            problems.append(f"unknown kind {kind!r}")
            continue
        for key, data in (entries or {}).items():
            try:
                incoming[(kind, str(key))] = normalize(kind, str(key), data or {})
            except IndexError_ as exc:
                problems += exc.problems
    if problems:
        raise IndexError_(problems)

    current = {(e.kind, e.key): v.data for e, v in list_entries(session)}
    changes: dict[tuple[str, str], dict | None] = dict(incoming)
    archived = [k for k in current if k not in incoming] if archive_missing else []
    for k in archived:
        changes[k] = None
    problems = cross_check(load_all(session, changes))
    if problems:
        raise IndexError_(problems)

    plan = ImportPlan([], [], [], archived, {}, incoming)
    for k, data in incoming.items():
        if k not in current:
            archived_entry = get_entry(session, *k)
            plan.created.append(k)
            plan.diffs[f"{k[0]}/{k[1]}"] = diff(get_version(session, *k).data if archived_entry else None, data)
        elif current[k] == data:
            plan.unchanged.append(k)
        else:
            plan.updated.append(k)
            plan.diffs[f"{k[0]}/{k[1]}"] = diff(current[k], data)
    for k in archived:
        plan.diffs[f"{k[0]}/{k[1]}"] = diff(current[k], None)
    return plan


def apply_import(session: Session, plan: ImportPlan, author: Author, reason: str, action: str = "import") -> None:
    if not reason.strip():
        raise IndexError_(["a reason is required for every index change"])
    # Write in dependency order so reference checks pass entry by entry.
    order = ["field", "pouch_catalog", "keyline_template", "output_preset", "pdf_profile", "validation_rules", "material",
             "pouch_type", "standard_size", "client", "item_override", "workflow"]
    for kind in order:
        keys = [k for k in [*plan.created, *plan.updated] if k[0] == kind]
        if kind == "workflow":
            keys = _workflows_first_referenced(keys, plan.data)
        for k in keys:
            save(session, k[0], k[1], plan.data[k], author, reason, action=action)
    for kind in reversed(order):
        for k in [k for k in plan.archived if k[0] == kind]:
            archive(session, k[0], k[1], author, reason)


def _workflows_first_referenced(keys: list[tuple[str, str]], data: dict[tuple[str, str], dict]) -> list[tuple[str, str]]:
    """Sub-workflows before the workflows that call them (a cycle keeps the given order)."""
    refs = {k: {n.get("workflow") for n in data[k].get("nodes", []) if n.get("type") == "sub_workflow"} for k in keys}
    ordered: list[tuple[str, str]] = []
    pending = list(keys)
    while pending:
        ready = [k for k in pending if not (refs[k] & {p[1] for p in pending if p != k})]
        if not ready:
            ready = pending[:1]
        ordered += ready
        pending = [k for k in pending if k not in ready]
    return ordered
