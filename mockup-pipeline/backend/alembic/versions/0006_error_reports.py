"""error reports: problems users raise for the admin

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-08
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "error_reports",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("job_id", sa.Integer, sa.ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("message", sa.Text, nullable=False, server_default=""),
        sa.Column("page", sa.String(300), nullable=False, server_default=""),
        sa.Column("context", sa.JSON, nullable=True),
        sa.Column("status", sa.String(10), nullable=False, server_default="open", index=True),
        sa.Column("admin_note", sa.Text, nullable=False, server_default=""),
        sa.Column("resolved_by", sa.String(254), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("error_reports")
