"""View models shared by the client status page and the admin dashboard."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Check, CheckStatus, Site
from .monitor import average_response_ms, latest_check, recent_checks, uptime_percent


@dataclass
class SiteCard:
    site: Site
    status: CheckStatus | None
    detail: str
    checked_at: datetime | None
    response_ms: float | None
    uptime_24h: float | None
    avg_ms_24h: float | None
    history: list[Check]

    @property
    def status_value(self) -> str:
        return self.status.value if self.status else "pending"


def build_site_cards(
    db: Session,
    *,
    include_inactive: bool = False,
    history_limit: int = 30,
    only_site_ids: set[int] | None = None,
) -> list[SiteCard]:
    """Build the status cards. `only_site_ids` of None means no restriction;
    an empty set means no pages, which is what an unassigned client sees."""
    query = select(Site).order_by(Site.name)
    if not include_inactive:
        query = query.where(Site.is_active.is_(True))
    if only_site_ids is not None:
        if not only_site_ids:
            return []
        query = query.where(Site.id.in_(only_site_ids))

    cards: list[SiteCard] = []
    for site in db.scalars(query).all():
        last = latest_check(db, site.id)
        cards.append(
            SiteCard(
                site=site,
                status=last.status if last else None,
                detail=last.detail if last else "",
                checked_at=last.checked_at if last else None,
                response_ms=last.response_ms if last else None,
                uptime_24h=uptime_percent(db, site.id, hours=24),
                avg_ms_24h=average_response_ms(db, site.id, hours=24),
                history=recent_checks(db, site.id, limit=history_limit),
            )
        )
    return cards


def summarize(cards: list[SiteCard]) -> dict[str, int]:
    return {
        "total": len(cards),
        "up": sum(1 for c in cards if c.status == CheckStatus.UP),
        "degraded": sum(1 for c in cards if c.status == CheckStatus.DEGRADED),
        "down": sum(1 for c in cards if c.status == CheckStatus.DOWN),
        "pending": sum(1 for c in cards if c.status is None),
    }
