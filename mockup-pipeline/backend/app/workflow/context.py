"""What a workflow step gets: the job, its pinned index, storage, previous outputs and a logger."""

import hashlib
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.index import store
from app.index.fields import FieldDef, compose_template
from app.index.schemas import KINDS
from app.models import Job, JobEvent, JobStep, UploadedFile
from app.pdf.profile import PdfProfile
from app.specs.validate import ValidationRules
from app.storage import Storage

M = TypeVar("M", bound=BaseModel)


class JobIndex:
    """The index exactly as it was when the job was created (versions pinned in index_snapshot)."""

    def __init__(self, session: Session, snapshot: dict[str, dict[str, int]]):
        self.session = session
        self.snapshot = snapshot
        self._cache: dict[tuple[str, str], BaseModel | None] = {}

    def version(self, kind: str, key: str) -> int | None:
        return self.snapshot.get(kind, {}).get(key)

    def get(self, kind: str, key: str) -> BaseModel | None:
        if (kind, key) not in self._cache:
            number = self.version(kind, key)
            row = store.get_version(self.session, kind, key, number) if number else None
            self._cache[(kind, key)] = KINDS[kind].model_validate(row.data) if row else None
        return self._cache[(kind, key)]

    def all(self, kind: str) -> dict[str, BaseModel]:
        return {key: model for key in self.snapshot.get(kind, {}) if (model := self.get(kind, key)) is not None}

    def fields(self) -> dict[str, FieldDef]:
        """The field dictionary (index kind field) as pinned for this job; empty on an unseeded index."""
        return self.all("field")  # type: ignore[return-value]

    def pdf_profile(self) -> PdfProfile:
        """The PDF profile with its OCR template composed from the field dictionary."""
        profile: PdfProfile = self.get("pdf_profile", "default") or PdfProfile()  # type: ignore[assignment]
        return compose_profile(profile, self.fields())

    def validation_rules(self) -> ValidationRules:
        return self.get("validation_rules", "default") or ValidationRules()  # type: ignore[return-value]

    def required_fields(self) -> list[str] | None:
        """Fields the dictionary marks required; None when the dictionary is empty (rules decide)."""
        fields = self.fields()
        return [k for k, f in fields.items() if f.required and not f.stop] if fields else None

    def field_confidence(self) -> dict[str, float]:
        return {k: f.min_confidence for k, f in self.fields().items() if f.min_confidence is not None}


def compose_profile(profile: PdfProfile, fields: dict[str, FieldDef]) -> PdfProfile:
    if not fields:
        return profile
    return profile.model_copy(update={"spec_template": compose_template(profile.spec_template, fields)})


@dataclass
class StepContext:
    session: Session
    job: Job
    storage: Storage
    settings: Settings
    step: str = ""
    _index: JobIndex | None = field(default=None, repr=False)

    @property
    def prefix(self) -> str:
        return f"jobs/{self.job.id}"

    @property
    def inputs(self) -> dict[str, Any]:
        return self.job.inputs or {}

    @property
    def index(self) -> JobIndex:
        if self._index is None or self._index.snapshot is not self.job.index_snapshot:
            self._index = JobIndex(self.session, self.job.index_snapshot or {})
        return self._index

    def output(self, step: str, model: type[M]) -> M:
        row = self.session.scalar(select(JobStep).where(JobStep.job_id == self.job.id, JobStep.step == step))
        if row is None or row.output is None or row.status != "done":
            raise RuntimeError(f"step {step!r} has no output yet; rerun from an earlier step")
        return model.model_validate(row.output)

    def log(self, message: str, level: str = "info", data: dict | None = None) -> None:
        self.session.add(JobEvent(job_id=self.job.id, level=level, step=self.step, message=message, data=data))

    def local_file(self, f: UploadedFile) -> Path:
        """A local copy of an uploaded file (storage may be a remote bucket), cached by content hash.

        A multi-page PDF (a cover page in front of the sheet) is reduced to its artwork page, so
        every step works on a one-page file; which page was taken is logged once."""
        from pypdf import PdfReader

        from app.pdf.sheet import artwork_page, single_page_copy

        cache = self.settings.work_dir / "cache"
        cache.mkdir(parents=True, exist_ok=True)
        path = cache / f"{f.sha256}.pdf"
        if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != f.sha256:
            data = self.storage.get_bytes(f.storage_key)
            if hashlib.sha256(data).hexdigest() != f.sha256:
                raise RuntimeError(f"stored file {f.storage_key} does not match its recorded SHA-256")
            path.write_bytes(data)
        pages = len(PdfReader(path).pages)
        if pages <= 1:
            return path
        page = artwork_page(path)
        one = cache / f"{f.sha256}_p{page + 1}.pdf"
        if not one.exists():
            single_page_copy(path, one, page)
        if self.step == "ingest":  # once per job (ingest is the first step to open the file)
            self.log(f"{f.filename} has {pages} pages; page {page + 1} carries the artwork and is used", "audit",
                     {"pages": pages, "artwork_page": page + 1})
        return one


def format_exception(exc: BaseException) -> str:
    return "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[-8000:]
