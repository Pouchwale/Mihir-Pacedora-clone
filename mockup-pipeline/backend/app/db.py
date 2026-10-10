"""SQLAlchemy engine and session handling."""

from collections.abc import Iterator
from functools import lru_cache
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


def make_engine(url: str) -> Engine:
    if url.startswith("sqlite"):
        path = url.split("///", 1)[-1]
        if path and path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        # timeout: a writer waits for another's lock instead of failing the job ("database is locked" took
        # down FGPO6989 while eleven reruns wrote at once; sqlite3's default wait is 5 s)
        engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 60})

        @event.listens_for(engine, "connect")
        def _fk_on(dbapi_conn, _):  # SQLite ignores foreign keys unless asked
            dbapi_conn.execute("PRAGMA foreign_keys=ON")
            if not url.endswith(":memory:"):
                dbapi_conn.execute("PRAGMA journal_mode=WAL")  # readers no longer block the writer (nor it them)
                dbapi_conn.execute("PRAGMA busy_timeout=60000")

        return engine
    return create_engine(url, pool_pre_ping=True, pool_size=5, max_overflow=5)


@lru_cache
def get_engine() -> Engine:
    return make_engine(get_settings().sqlalchemy_url())


@lru_cache
def _factory() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), expire_on_commit=False)


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one session per request, committed by the handler."""
    with _factory()() as session:
        yield session
