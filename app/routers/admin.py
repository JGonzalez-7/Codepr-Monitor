"""Admin dashboard: fleet overview, ticket queue, site management, Uptime Kuma."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import Check, Site, Ticket, TicketStatus, User
from ..monitor import check_all_sites
from ..odoo import sync_ticket
from ..presenters import build_site_cards, summarize
from ..security import hash_password, require_admin
from ..templating import templates

router = APIRouter(prefix="/admin", tags=["admin"])
settings = get_settings()

SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(value: str) -> str:
    return SLUG_RE.sub("-", value.strip().lower()).strip("-") or "site"


@router.get("", response_class=HTMLResponse)
def dashboard(
    request: Request,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    cards = build_site_cards(db, include_inactive=True)
    open_tickets = db.scalar(
        select(func.count())
        .select_from(Ticket)
        .where(Ticket.status != TicketStatus.RESOLVED)
    )
    recent_tickets = db.scalars(
        select(Ticket).order_by(Ticket.submitted_at.desc()).limit(8)
    ).all()

    return templates.TemplateResponse(
        request,
        "admin/dashboard.html",
        {
            "user": user,
            "cards": cards,
            "summary": summarize(cards),
            "open_tickets": open_tickets or 0,
            "recent_tickets": recent_tickets,
            "check_interval": settings.check_interval_seconds,
            "cf_token_configured": settings.has_cf_access_token,
            "odoo_enabled": settings.odoo_enabled,
        },
    )


@router.post("/check-now")
def check_now(user: User = Depends(require_admin)) -> RedirectResponse:
    # Sync endpoint, so FastAPI already runs this off the event loop.
    check_all_sites()
    return RedirectResponse("/admin", status_code=303)


# --- Tickets -------------------------------------------------------------


@router.get("/tickets", response_class=HTMLResponse)
def ticket_queue(
    request: Request,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
    status: str | None = None,
):
    query = select(Ticket).order_by(Ticket.submitted_at.desc())
    if status in {s.value for s in TicketStatus}:
        query = query.where(Ticket.status == TicketStatus(status))

    return templates.TemplateResponse(
        request,
        "admin/tickets.html",
        {
            "user": user,
            "tickets": db.scalars(query).all(),
            "active_filter": status or "all",
            "statuses": list(TicketStatus),
            "odoo_enabled": settings.odoo_enabled,
        },
    )


@router.post("/tickets/{ticket_id}/status")
def update_ticket_status(
    ticket_id: int,
    status: str = Form(...),
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    ticket = db.get(Ticket, ticket_id)
    if ticket is not None and status in {s.value for s in TicketStatus}:
        ticket.status = TicketStatus(status)
        db.commit()
    return RedirectResponse("/admin/tickets", status_code=303)


@router.post("/tickets/{ticket_id}/resync")
def resync_ticket(
    ticket_id: int, user: User = Depends(require_admin)
) -> RedirectResponse:
    """Retry the Odoo mirror for a ticket whose first push failed."""
    sync_ticket(ticket_id)
    return RedirectResponse("/admin/tickets", status_code=303)


# --- Sites ---------------------------------------------------------------


@router.get("/sites", response_class=HTMLResponse)
def manage_sites(
    request: Request,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    sites = db.scalars(select(Site).order_by(Site.name)).all()
    return templates.TemplateResponse(
        request, "admin/sites.html", {"user": user, "sites": sites}
    )


@router.post("/sites")
def create_site(
    name: str = Form(...),
    url: str = Form(...),
    description: str = Form(""),
    uses_cf_access: bool = Form(False),
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    slug = _slugify(name)
    if db.scalar(select(Site).where(Site.slug == slug)):
        slug = f"{slug}-{db.scalar(select(func.count()).select_from(Site))}"

    db.add(
        Site(
            slug=slug,
            name=name.strip()[:128],
            url=url.strip()[:512],
            description=description.strip()[:512],
            uses_cf_access=uses_cf_access,
        )
    )
    db.commit()
    return RedirectResponse("/admin/sites", status_code=303)


@router.post("/sites/{site_id}")
def update_site(
    site_id: int,
    name: str = Form(...),
    url: str = Form(...),
    description: str = Form(""),
    is_active: bool = Form(False),
    uses_cf_access: bool = Form(False),
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    site = db.get(Site, site_id)
    if site is not None:
        new_url = url.strip()[:512]
        if new_url != site.url:
            # History describes the old target, so keeping it would show a status
            # that was never measured against the new URL.
            db.execute(delete(Check).where(Check.site_id == site.id))

        site.name = name.strip()[:128]
        site.url = new_url
        site.description = description.strip()[:512]
        site.is_active = is_active
        site.uses_cf_access = uses_cf_access
        db.commit()
    return RedirectResponse("/admin/sites", status_code=303)


# --- Users ---------------------------------------------------------------

USERNAME_RE = re.compile(r"^[a-z0-9_.-]{3,64}$")
MIN_PASSWORD_LENGTH = 10


def _render_users(
    request: Request,
    db: Session,
    admin: User,
    *,
    error: str | None = None,
    notice: str | None = None,
    status_code: int = 200,
):
    users = db.scalars(select(User).order_by(User.is_admin.desc(), User.username)).all()
    sites = db.scalars(select(Site).order_by(Site.name)).all()
    return templates.TemplateResponse(
        request,
        "admin/users.html",
        {
            "user": admin,
            "users": users,
            "sites": sites,
            "error": error,
            "notice": notice,
            "min_password_length": MIN_PASSWORD_LENGTH,
        },
        status_code=status_code,
    )


@router.get("/users", response_class=HTMLResponse)
def manage_users(
    request: Request,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    return _render_users(request, db, user)


@router.post("/users")
def create_user(
    request: Request,
    username: str = Form(""),
    full_name: str = Form(""),
    email: str = Form(""),
    password: str = Form(""),
    is_admin: bool = Form(False),
    site_ids: list[int] = Form(default=[]),
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Create a client account and grant it the pages it should see."""
    username = username.strip().lower()
    full_name = full_name.strip()

    if not USERNAME_RE.match(username):
        return _render_users(
            request,
            db,
            user,
            error=(
                "Usernames are 3–64 characters, lowercase letters, digits, "
                "dot, dash, or underscore."
            ),
            status_code=400,
        )

    if db.scalar(select(User).where(User.username == username)) is not None:
        return _render_users(
            request, db, user, error=f"The username {username} is taken.", status_code=400
        )

    if not full_name:
        return _render_users(
            request, db, user, error="Add the person's full name.", status_code=400
        )

    if len(password) < MIN_PASSWORD_LENGTH:
        return _render_users(
            request,
            db,
            user,
            error=f"Passwords must be at least {MIN_PASSWORD_LENGTH} characters.",
            status_code=400,
        )

    granted = db.scalars(select(Site).where(Site.id.in_(site_ids))).all() if site_ids else []

    # The password is hashed here and never stored or echoed back; the admin who
    # typed it is the one who passes it on.
    account = User(
        username=username,
        full_name=full_name[:128],
        email=email.strip()[:255],
        password_hash=hash_password(password),
        is_admin=is_admin,
        sites=list(granted),
    )
    db.add(account)
    db.commit()

    what = "an admin" if is_admin else f"{len(granted)} page(s)"
    return _render_users(
        request, db, user, notice=f"Created {username} with {what}."
    )


@router.post("/users/{user_id}/access")
def update_user_access(
    request: Request,
    user_id: int,
    site_ids: list[int] = Form(default=[]),
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Replace the set of pages a user can see and raise tickets about."""
    account = db.get(User, user_id)
    if account is None:
        return _render_users(
            request, db, user, error="That account no longer exists.", status_code=404
        )

    account.sites = list(db.scalars(select(Site).where(Site.id.in_(site_ids))).all()) if site_ids else []
    db.commit()

    return _render_users(
        request,
        db,
        user,
        notice=f"Updated the pages {account.username} can see.",
    )


# --- Uptime Kuma ---------------------------------------------------------


@router.get("/kuma", response_class=HTMLResponse)
def kuma(request: Request, user: User = Depends(require_admin)):
    return templates.TemplateResponse(
        request,
        "admin/kuma.html",
        {"user": user, "kuma_url": settings.uptime_kuma_embed_url},
    )
