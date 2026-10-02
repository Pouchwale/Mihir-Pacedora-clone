"""job control: pause / cancel requests

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-25
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("jobs") as b:
        b.add_column(sa.Column("control", sa.String(10)))  # "pause" | "cancel" until the worker acts on it


def downgrade() -> None:
    with op.batch_alter_table("jobs") as b:
        b.drop_column("control")
