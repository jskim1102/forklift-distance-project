"""add ip_cams.calibration

Revision ID: 6aded381ab2a
Revises: 14d6b54de992
Create Date: 2026-06-22 11:18:08.442088

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6aded381ab2a'
down_revision: Union[str, Sequence[str], None] = '14d6b54de992'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # 기존 ip_cams 에 nullable calibration 컬럼 추가 (비파괴 — 기존 행은 NULL).
    op.add_column("ip_cams", sa.Column("calibration", sa.JSON(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    # SQLite 는 직접 DROP COLUMN 미지원 → batch(테이블 재생성)로 처리.
    with op.batch_alter_table("ip_cams") as batch_op:
        batch_op.drop_column("calibration")
