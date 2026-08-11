"""One-off copy of every row from SQLite into a fresh PostgreSQL database.

Used once, when moving the Docker stack onto the `db` service. Reseeding instead
of copying would lose the ticket history and mint new password hashes, so the
accounts in SECRETS.md would stop working.

Delete this file once the copy has been run and verified — it has no purpose
after that.

Run it inside the app image, with the `db` service already up:

    docker compose up -d db
    docker compose run --rm \
      -e SOURCE_DATABASE_URL="sqlite:////srv/data/codepr_monitor.db" \
      -v "$PWD/migrate_to_postgres.py:/srv/migrate_to_postgres.py:ro" \
      app python /srv/migrate_to_postgres.py

DATABASE_URL is already the PostgreSQL one from docker-compose.yml, and the
app service still mounts the old SQLite volume read-only, so both ends are in
place without extra flags.

Two things this handles that a plain row copy does not:

- **Timestamps.** SQLite has no timezone-aware type, so every datetime comes
  back naive. Inserted as-is into `timestamptz`, PostgreSQL would read it in the
  server's timezone; the app writes UTC, so each one is marked UTC here instead
  of trusting a server setting.
- **Sequences.** The copy keeps the original primary keys, which does not
  advance PostgreSQL's sequences. Left alone, the very first ticket after the
  move would try to reuse id 1. Every sequence is reset at the end.

Tables are copied parents first so foreign keys hold at every step, and the
destination must be empty — this is a move, not a sync, and re-running it would
otherwise double every row.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import Session

from app.db import Base, engine as target_engine
from app.models import (  # noqa: F401 — imported so Base knows every table
    Check,
    Site,
    Ticket,
    TicketAttachment,
    User,
    user_sites,
)

# Parents before children.
ORDER = [Site, User, Check, Ticket, TicketAttachment]


def _as_utc(value: object) -> object:
    """Mark a naive datetime as UTC, which is what the app wrote."""
    if isinstance(value, datetime) and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _reset_sequences(dst: Session) -> None:
    """Point each id sequence past the highest id that was copied in."""
    for model in ORDER:
        table = model.__tablename__
        sequence = dst.scalar(text(f"SELECT pg_get_serial_sequence('{table}', 'id')"))
        if sequence is None:
            # Not a PostgreSQL target, or the column is not a serial.
            continue
        highest = dst.scalar(select(func.max(model.id))) or 0
        # is_called=false means the next nextval() returns exactly this number.
        dst.execute(
            text("SELECT setval(:seq, :value, false)"),
            {"seq": sequence, "value": highest + 1},
        )
        print(f"  {table}.id -> next {highest + 1}")


def main() -> int:
    source_url = os.environ.get("SOURCE_DATABASE_URL", "")
    if not source_url:
        print("SOURCE_DATABASE_URL is not set.", file=sys.stderr)
        return 2

    print(f"source: {source_url.split('@')[-1]}")
    print(f"target: {target_engine.url}")

    source_engine = create_engine(
        source_url, connect_args={"check_same_thread": False}, future=True
    )
    Base.metadata.create_all(bind=target_engine)

    with Session(source_engine) as src, Session(target_engine) as dst:
        existing = sum(
            dst.scalar(select(func.count()).select_from(m.__table__)) or 0
            for m in ORDER
        )
        if existing:
            print(
                f"Target already holds {existing} rows. Refusing to copy into a "
                "non-empty database.",
                file=sys.stderr,
            )
            return 1

        for model in ORDER:
            rows = src.scalars(select(model)).all()
            for row in rows:
                # Keep the original primary key, so foreign keys still line up
                # on the other side.
                values = {
                    c.name: _as_utc(getattr(row, c.name))
                    for c in model.__table__.columns
                }
                dst.execute(model.__table__.insert().values(**values))
            print(f"  {model.__tablename__}: {len(rows)}")

        # The association table has no model class of its own.
        pairs = src.execute(select(user_sites)).all()
        for user_id, site_id in pairs:
            dst.execute(user_sites.insert().values(user_id=user_id, site_id=site_id))
        print(f"  user_sites: {len(pairs)}")

        dst.commit()

    with Session(target_engine) as dst:
        print("\nresetting sequences:")
        _reset_sequences(dst)
        dst.commit()

        print("\nverifying target:")
        for model in ORDER:
            count = dst.scalar(select(func.count()).select_from(model.__table__))
            print(f"  {model.__tablename__}: {count}")
        print(f"  user_sites: {dst.scalar(select(func.count()).select_from(user_sites))}")

    print("\nmigration complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
