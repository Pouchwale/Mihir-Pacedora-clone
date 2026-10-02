"""uploads, jobs, job steps and job events

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-24
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "batches",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("created_by_id", sa.Integer, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "uploaded_files",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("batch_id", sa.Integer, sa.ForeignKey("batches.id", ondelete="SET NULL")),
        sa.Column("filename", sa.String(300), nullable=False),
        sa.Column("item_code", sa.String(40)),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("size", sa.Integer, nullable=False),
        sa.Column("storage_key", sa.String(400), nullable=False),
        sa.Column("uploaded_by_id", sa.Integer, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_uploaded_files_batch_id", "uploaded_files", ["batch_id"])
    op.create_index("ix_uploaded_files_item_code", "uploaded_files", ["item_code"])
    op.create_index("ix_uploaded_files_sha256", "uploaded_files", ["sha256"])
    op.create_table(
        "jobs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("batch_id", sa.Integer, sa.ForeignKey("batches.id", ondelete="SET NULL")),
        sa.Column("file_id", sa.Integer, sa.ForeignKey("uploaded_files.id"), nullable=False),
        sa.Column("item_code", sa.String(40)),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("current_step", sa.String(40), nullable=False),
        sa.Column("review", sa.JSON),
        sa.Column("error", sa.Text),
        sa.Column("inputs", sa.JSON, nullable=False),
        sa.Column("index_snapshot", sa.JSON),
        sa.Column("client_name", sa.String(200)),
        sa.Column("pouch_type", sa.String(120)),
        sa.Column("keyline_template", sa.String(120)),
        sa.Column("keyline_version", sa.Integer),
        sa.Column("created_by_id", sa.Integer, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("approved_by", sa.String(254)),
        sa.Column("approved_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_jobs_batch_id", "jobs", ["batch_id"])
    op.create_index("ix_jobs_item_code", "jobs", ["item_code"])
    op.create_index("ix_jobs_status", "jobs", ["status"])
    op.create_table(
        "job_steps",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("job_id", sa.Integer, sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("step", sa.String(40), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("attempt", sa.Integer, nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("output", sa.JSON),
        sa.Column("error", sa.Text),
        sa.UniqueConstraint("job_id", "step"),
    )
    op.create_index("ix_job_steps_job_id", "job_steps", ["job_id"])
    op.create_table(
        "job_events",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("job_id", sa.Integer, sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("level", sa.String(10), nullable=False),
        sa.Column("step", sa.String(40)),
        sa.Column("message", sa.Text, nullable=False),
        sa.Column("data", sa.JSON),
    )
    op.create_index("ix_job_events_job_id", "job_events", ["job_id"])


def downgrade() -> None:
    for table in ("job_events", "job_steps", "jobs", "uploaded_files", "batches"):
        op.drop_table(table)
