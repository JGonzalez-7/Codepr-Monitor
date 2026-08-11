"""First-boot seeding of monitored sites and local accounts.

Accounts are local-only for now: there is no Odoo SSO. Generated credentials are
written to SECRETS.md, which is gitignored, so they exist exactly once and are
never printed into a committed file.
"""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .models import Site, User
from .security import hash_password

log = logging.getLogger(__name__)
settings = get_settings()

# The hbpr repo is private, so its live URL comes from HBPR_URL.
SEED_SITES = [
    {
        "slug": "hbpr",
        "name": "HBPR",
        "url": settings.hbpr_url,
        "description": "Holberton PR project site.",
        "uses_cf_access": False,
    },
    {
        "slug": "scholarship",
        "name": "Holberton Scholarship",
        "url": "https://scholarship.holbertonschoolpr.com/",
        "description": "Scholarship application portal.",
        "uses_cf_access": False,
    },
    {
        "slug": "odoo",
        "name": "Odoo — code.pr",
        "url": "https://odoo.code.pr",
        "description": "Odoo ERP, behind Cloudflare Access.",
        "uses_cf_access": True,
    },
]

SEED_USERS = [
    {"username": "admin", "full_name": "CodePR Administrator", "is_admin": True},
    {"username": "user1", "full_name": "Client User One", "is_admin": False},
    {"username": "user2", "full_name": "Client User Two", "is_admin": False},
    {"username": "user3", "full_name": "Client User Three", "is_admin": False},
]


def _generate_password() -> str:
    return secrets.token_urlsafe(12)


def seed_sites(db: Session) -> None:
    """Insert any missing seed site. Existing rows are left untouched so admin
    edits survive a restart."""
    for spec in SEED_SITES:
        existing = db.scalar(select(Site).where(Site.slug == spec["slug"]))
        if existing:
            continue
        db.add(Site(**spec))
        log.info("Seeded site %s -> %s", spec["slug"], spec["url"])
    db.commit()


def seed_users(db: Session) -> list[tuple[str, str, bool]]:
    """Create missing seed accounts. Returns (username, plaintext, is_admin) for
    accounts created in this call only."""
    created: list[tuple[str, str, bool]] = []
    for spec in SEED_USERS:
        existing = db.scalar(select(User).where(User.username == spec["username"]))
        if existing:
            continue

        configured = (
            settings.seed_admin_password
            if spec["is_admin"]
            else settings.seed_user_password
        )
        password = configured or _generate_password()

        db.add(
            User(
                username=spec["username"],
                full_name=spec["full_name"],
                email=f"{spec['username']}@codepr.local",
                password_hash=hash_password(password),
                is_admin=spec["is_admin"],
            )
        )
        created.append((spec["username"], password, spec["is_admin"]))
        log.info("Seeded account %s", spec["username"])

    db.commit()
    return created


def write_secrets_file(created: list[tuple[str, str, bool]]) -> None:
    """Append newly created credentials to the gitignored SECRETS.md."""
    if not created:
        return

    path = Path(settings.secrets_file)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    lines: list[str] = []
    if not path.exists():
        lines += [
            "# CodePR-Monitor — Local Credentials",
            "",
            "Generated automatically on first boot. This file is gitignored and must",
            "never be committed. These are local application accounts only; they are",
            "unrelated to Odoo or Cloudflare Access credentials.",
            "",
        ]

    lines += [f"## Seeded {stamp}", ""]
    lines += ["| Username | Password | Role |", "| --- | --- | --- |"]
    for username, password, is_admin in created:
        role = "Admin" if is_admin else "Client"
        lines += [f"| `{username}` | `{password}` | {role} |"]
    lines += [""]

    with path.open("a", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")

    # Credentials at rest: owner-readable only.
    try:
        path.chmod(0o600)
    except OSError:
        log.warning("Could not tighten permissions on %s", path)

    log.info("Wrote %d credential(s) to %s", len(created), path)


def run_seed(db: Session) -> None:
    seed_sites(db)
    write_secrets_file(seed_users(db))
