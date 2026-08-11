"""One-off copy of every row from PostgreSQL into a fresh SQLite database.

Used when moving the Docker stack off the `db` service. Reseeding instead of
copying would lose the ticket history and mint new password hashes, so the
accounts in SECRETS.md would stop working.

Run it inside the app image while the Postgres service is still up:

    docker compose run --rm --no-deps \
      -e SOURCE_DATABASE_URL="postgresql+psycopg://codepr:PASS@db:5432/codepr_monitor" \
      -e DATABASE_URL="sqlite:////srv/data/codepr_monitor.db" \
      -v codepr-monitor_monitor-sqlite-data:/srv/data \
      -v "$PWD/migrate_to_sqlite.py:/srv/migrate_to_sqlite.py:ro" \
      app python /srv/migrate_to_sqlite.py

Tables are copied parents first so foreign keys hold at every step, and the
destination must be empty — this is a move, not a sync, and re-running it would
otherwise double every row.
"""

from __future__ import annotations

import os
import sys

from sqlalchemy import create_engine, func, select
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


def main() -> int:
    source_url = os.environ.get("SOURCE_DATABASE_URL", "")
    if not source_url:
        print("SOURCE_DATABASE_URL is not set.", file=sys.stderr)
        return 2

    print(f"source: {source_url.split('@')[-1]}")
    print(f"target: {target_engine.url}")

    source_engine = create_engine(source_url, future=True)
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
                # Detach from the source session and keep the original primary
                # key, so foreign keys still line up on the other side.
                values = {
                    c.name: getattr(row, c.name) for c in model.__table__.columns
                }
                dst.execute(model.__table__.insert().values(**values))
            print(f"  {model.__tablename__}: {len(rows)}")

        # The association table has no model class of its own.
        pairs = src.execute(select(user_sites)).all()
        for user_id, site_id in pairs:
            dst.execute(user_sites.insert().values(user_id=user_id, site_id=site_id))
        print(f"  user_sites: {len(pairs)}")

        dst.commit()

    # SQLite does not use sequences, so nothing needs resetting; confirm the
    # copy instead.
    with Session(target_engine) as dst:
        print("\nverifying target:")
        for model in ORDER:
            count = dst.scalar(select(func.count()).select_from(model.__table__))
            print(f"  {model.__tablename__}: {count}")
        print(f"  user_sites: {dst.scalar(select(func.count()).select_from(user_sites))}")

    print("\nmigration complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
