"""Which pages a given user is allowed to see and raise tickets about.

Every client-facing read of the site list goes through here, so the rule lives
in one place: an admin is unrestricted, and a client sees exactly the pages
assigned to them under Users (`/admin/users`). A client with no assignment sees
nothing — that is the safe direction to fail, and the empty state says so.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Site, User


def visible_site_ids(user: User) -> set[int] | None:
    """Site ids this user may see, or None meaning unrestricted."""
    if user.is_admin:
        return None
    return {site.id for site in user.sites}


def can_access(user: User, site: Site) -> bool:
    return user.is_admin or any(assigned.id == site.id for assigned in user.sites)


def accessible_sites(db: Session, user: User, *, active_only: bool = True) -> list[Site]:
    """Pages this user may pick from, ordered by name."""
    if user.is_admin:
        query = select(Site).order_by(Site.name)
        if active_only:
            query = query.where(Site.is_active.is_(True))
        return list(db.scalars(query).all())

    return [
        site
        for site in user.sites
        if site.is_active or not active_only
    ]
