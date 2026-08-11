"""Database engine and session handling."""

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings

settings = get_settings()

IS_SQLITE = settings.database_url.startswith("sqlite")

# check_same_thread lets the monitor thread share the engine with the request
# handlers. timeout is SQLite's lock wait: writes queue instead of failing when
# a check and a ticket submission land together.
connect_args = (
    {"check_same_thread": False, "timeout": 30.0} if IS_SQLITE else {}
)

engine = create_engine(
    settings.database_url,
    connect_args=connect_args,
    pool_pre_ping=True,
    future=True,
)

if IS_SQLITE:

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection, connection_record) -> None:
        """Settings SQLite does not apply by default, set per connection.

        WAL is the important one: without it a single writer blocks every
        reader, so the 60-second check would stall the status page. It also
        survives on the file itself, but is set here so a fresh database file
        never starts in rollback-journal mode.
        """
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        # Wait for a lock rather than raising "database is locked" immediately.
        cursor.execute("PRAGMA busy_timeout=30000")
        # SQLite ignores foreign keys unless asked; the ticket/attachment
        # cascade depends on them.
        cursor.execute("PRAGMA foreign_keys=ON")
        # Fewer fsyncs per write, still crash-safe under WAL.
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    """FastAPI dependency yielding a request-scoped session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    """Session for background work, committing on success and rolling back on error."""
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
