"""Database tables. The index is a generic versioned document store: one row per (kind, key)
in index_entries and an append-only index_versions history; nothing is ever updated in place."""

from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    password_hash: Mapped[str] = mapped_column(String(100))
    role: Mapped[str] = mapped_column(String(20))  # "admin" or "operator"
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class UserSession(Base):
    __tablename__ = "user_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)  # sha256 of the cookie token
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    user: Mapped[User] = relationship()


class IndexEntry(Base):
    __tablename__ = "index_entries"
    __table_args__ = (UniqueConstraint("kind", "key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    key: Mapped[str] = mapped_column(String(120))
    current_version: Mapped[int] = mapped_column(Integer)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    versions: Mapped[list["IndexVersion"]] = relationship(back_populates="entry", order_by="IndexVersion.version")


class Batch(Base):
    """One upload action (many PDFs or a ZIP)."""

    __tablename__ = "batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class UploadedFile(Base):
    """File registry: every uploaded PDF, looked up by item code when linking panels."""

    __tablename__ = "uploaded_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("batches.id", ondelete="SET NULL"), nullable=True, index=True)
    filename: Mapped[str] = mapped_column(String(300))
    item_code: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    size: Mapped[int] = mapped_column(Integer)
    storage_key: Mapped[str] = mapped_column(String(400))
    uploaded_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("batches.id", ondelete="SET NULL"), nullable=True, index=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("uploaded_files.id"))
    item_code: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(20), index=True)  # QUEUED RUNNING NEEDS_REVIEW PAUSED CANCELLED FAILED DONE
    current_step: Mapped[str] = mapped_column(String(40))
    # An operator's request to the running worker: "pause" (stop after the current step, resume
    # later from there) or "cancel" (stop; a rerun starts it again). Cleared when acted on.
    control: Mapped[str | None] = mapped_column(String(10), nullable=True)
    review: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # what the operator must fix
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Operator decisions (spec corrections, forced pouch type, panel choices, keyline overrides, ...)
    inputs: Mapped[dict] = mapped_column(JSON, default=dict)
    index_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # {kind: {key: version}}
    client_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    pouch_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    keyline_template: Mapped[str | None] = mapped_column(String(120), nullable=True)
    keyline_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String(254), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # The workflow graph that ran this job (spec 4): "test" jobs run a draft graph from the editor's
    # test mode and never appear in the jobs list; the path is what the live canvas highlights.
    kind: Mapped[str] = mapped_column(String(10), default="job")
    workflow_key: Mapped[str | None] = mapped_column(String(120), nullable=True)
    workflow_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    workflow_path: Mapped[list | None] = mapped_column(JSON, nullable=True)
    current_node: Mapped[str | None] = mapped_column(String(80), nullable=True)
    file: Mapped[UploadedFile] = relationship()


class WorkflowDraft(Base):
    """The unpublished graph of a workflow (one per key); publishing writes an index version."""

    __tablename__ = "workflow_drafts"

    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    graph: Mapped[dict] = mapped_column(JSON)
    updated_by: Mapped[str] = mapped_column(String(254))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class JobStep(Base):
    """Latest run of one workflow step of a job (typed output as JSON)."""

    __tablename__ = "job_steps"
    __table_args__ = (UniqueConstraint("job_id", "step"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    step: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(20))  # running done failed needs_review
    attempt: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    output: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class JobEvent(Base):
    """Job log and audit trail (who did what, warnings, errors)."""

    __tablename__ = "job_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    level: Mapped[str] = mapped_column(String(10))  # info warning error audit
    step: Mapped[str | None] = mapped_column(String(40), nullable=True)
    message: Mapped[str] = mapped_column(Text)
    data: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class IndexVersion(Base):
    __tablename__ = "index_versions"
    __table_args__ = (UniqueConstraint("entry_id", "version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entry_id: Mapped[int] = mapped_column(ForeignKey("index_entries.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    data: Mapped[dict] = mapped_column(JSON)
    action: Mapped[str] = mapped_column(String(20))  # create, update, archive, restore, import, seed
    reason: Mapped[str] = mapped_column(Text)
    author_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    author_email: Mapped[str] = mapped_column(String(254))  # kept even if the user is deleted
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    entry: Mapped[IndexEntry] = relationship(back_populates="versions")
