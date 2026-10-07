"""roles: admin, head_designer, designer, manager (operators become designers)

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-07
"""

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE users SET role = 'designer' WHERE role = 'operator'")


def downgrade() -> None:
    op.execute("UPDATE users SET role = 'operator' WHERE role NOT IN ('admin', 'operator')")
