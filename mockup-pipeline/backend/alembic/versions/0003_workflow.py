"""workflow graphs: job path, job kind (test runs), workflow drafts

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-25
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("jobs") as b:
        b.add_column(sa.Column("kind", sa.String(10), nullable=False, server_default="job"))  # job | test
        b.add_column(sa.Column("workflow_key", sa.String(120)))
        b.add_column(sa.Column("workflow_version", sa.Integer))
        b.add_column(sa.Column("workflow_path", sa.JSON))
        b.add_column(sa.Column("current_node", sa.String(80)))
    op.create_table(
        "workflow_drafts",
        sa.Column("key", sa.String(120), primary_key=True),
        sa.Column("graph", sa.JSON, nullable=False),
        sa.Column("updated_by", sa.String(254), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("workflow_drafts")
    with op.batch_alter_table("jobs") as b:
        for col in ("current_node", "workflow_path", "workflow_version", "workflow_key", "kind"):
            b.drop_column(col)
