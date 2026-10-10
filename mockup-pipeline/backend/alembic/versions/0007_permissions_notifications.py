"""per-user permission overrides; error reports remember when their raiser saw the resolution

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-10
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as t:
        t.add_column(sa.Column("permission_overrides", sa.JSON, nullable=True))
    with op.batch_alter_table("error_reports") as t:
        t.add_column(sa.Column("user_seen_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("error_reports") as t:
        t.drop_column("user_seen_at")
    with op.batch_alter_table("users") as t:
        t.drop_column("permission_overrides")
