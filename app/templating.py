"""Shared Jinja2 environment and presentation helpers."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fastapi import Request
from fastapi.templating import Jinja2Templates

from .models import CheckStatus, TicketStatus

TEMPLATES_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"


def session_context(request: Request) -> dict[str, object]:
    """Expose the impersonating admin to every template.

    `get_current_user` records it on the request, so the banner in base.html
    works on every page without threading a new key through each route's
    context.
    """
    return {"impersonator": getattr(request.state, "impersonator", None)}


templates = Jinja2Templates(
    directory=str(TEMPLATES_DIR), context_processors=[session_context]
)

# Client-facing wording. "degraded" deliberately avoids claiming the site is up.
STATUS_LABELS = {
    CheckStatus.UP: "Online",
    CheckStatus.DEGRADED: "Needs attention",
    CheckStatus.DOWN: "Offline",
}

STATUS_BLURBS = {
    CheckStatus.UP: "This page is loading normally.",
    CheckStatus.DEGRADED: "We reached the server but could not confirm the page is healthy.",
    CheckStatus.DOWN: "We could not load this page.",
}

TICKET_STATUS_LABELS = {
    TicketStatus.OPEN: "Open",
    TicketStatus.IN_PROGRESS: "In progress",
    TicketStatus.RESOLVED: "Resolved",
}


def status_label(status: CheckStatus | None) -> str:
    if status is None:
        return "Checking…"
    return STATUS_LABELS.get(status, "Unknown")


def status_blurb(status: CheckStatus | None) -> str:
    if status is None:
        return "The first check has not completed yet."
    return STATUS_BLURBS.get(status, "")


def ticket_status_label(status: TicketStatus) -> str:
    return TICKET_STATUS_LABELS.get(status, status.value)


def format_dt(value: datetime | None) -> str:
    """Render a timestamp for display, in UTC, with an explicit suffix."""
    if value is None:
        return "—"
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).strftime("%b %d, %Y at %H:%M UTC")


def time_ago(value: datetime | None) -> str:
    if value is None:
        return "never"
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    seconds = (datetime.now(timezone.utc) - value).total_seconds()
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{int(seconds // 60)} min ago"
    if seconds < 86400:
        return f"{int(seconds // 3600)} hr ago"
    return f"{int(seconds // 86400)} d ago"


templates.env.filters["format_dt"] = format_dt
templates.env.filters["time_ago"] = time_ago
templates.env.filters["status_label"] = status_label
templates.env.filters["status_blurb"] = status_blurb
templates.env.filters["ticket_status_label"] = ticket_status_label
