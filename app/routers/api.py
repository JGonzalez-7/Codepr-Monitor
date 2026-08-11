"""JSON endpoints backing live refresh, plus the container health probe."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User
from ..presenters import build_site_cards, summarize
from ..security import require_user
from ..templating import status_blurb, status_label

router = APIRouter(tags=["api"])


@router.get("/healthz", include_in_schema=False)
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/api/status")
def api_status(
    user: User = Depends(require_user), db: Session = Depends(get_db)
) -> dict:
    """Current status of every visible site, polled by the status page."""
    cards = build_site_cards(db, include_inactive=user.is_admin, history_limit=1)
    return {
        "summary": summarize(cards),
        "sites": [
            {
                "slug": card.site.slug,
                "name": card.site.name,
                "url": card.site.url,
                "status": card.status_value,
                "label": status_label(card.status),
                "blurb": status_blurb(card.status),
                "detail": card.detail,
                "checked_at": card.checked_at.isoformat() if card.checked_at else None,
                "response_ms": card.response_ms,
                "uptime_24h": card.uptime_24h,
            }
            for card in cards
        ],
    }
