"""Client-facing pages: page status and ticket submission."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Site, Ticket, TicketKind, User
from ..odoo import sync_ticket_background
from ..presenters import build_site_cards, summarize
from ..security import require_user
from ..templating import templates

router = APIRouter(tags=["client"])


@router.get("/status", response_class=HTMLResponse)
def status_page(
    request: Request,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    cards = build_site_cards(db)
    return templates.TemplateResponse(
        request,
        "status.html",
        {"user": user, "cards": cards, "summary": summarize(cards)},
    )


@router.get("/tickets", response_class=HTMLResponse)
def tickets_page(
    request: Request,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
    submitted: int | None = None,
):
    return _render_tickets(request, db, user, submitted_id=submitted)


def _render_tickets(
    request: Request,
    db: Session,
    user: User,
    *,
    submitted_id: int | None = None,
    error: str | None = None,
    status_code: int = 200,
):
    sites = db.scalars(
        select(Site).where(Site.is_active.is_(True)).order_by(Site.name)
    ).all()
    my_tickets = db.scalars(
        select(Ticket)
        .where(Ticket.user_id == user.id)
        .order_by(Ticket.submitted_at.desc())
    ).all()
    return templates.TemplateResponse(
        request,
        "tickets.html",
        {
            "user": user,
            "sites": sites,
            "tickets": my_tickets,
            "submitted_id": submitted_id,
            "error": error,
        },
        status_code=status_code,
    )


@router.post("/tickets")
def submit_ticket(
    request: Request,
    site_id: str = Form(""),
    kind: str = Form("issue"),
    subject: str = Form(""),
    body: str = Form(""),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    # Fields default to "" rather than being required, because FastAPI reports an
    # empty form value as missing and would answer with a raw 422 JSON body
    # instead of the friendly inline error this form is built around.
    site = db.get(Site, int(site_id)) if site_id.isdigit() else None
    subject = subject.strip()

    if site is None:
        return _render_tickets(
            request,
            db,
            user,
            error="Choose which page this is about.",
            status_code=400,
        )

    if not subject:
        return _render_tickets(
            request, db, user, error="Add a short subject.", status_code=400
        )

    try:
        ticket_kind = TicketKind(kind)
    except ValueError:
        ticket_kind = TicketKind.ISSUE

    # submitted_at, user, and site are all captured here; they are the fields the
    # client sees on their ticket and the ones mirrored to Odoo.
    ticket = Ticket(
        site_id=site.id,
        user_id=user.id,
        subject=subject[:200],
        body=body.strip(),
        kind=ticket_kind,
    )
    db.add(ticket)
    db.commit()
    db.refresh(ticket)

    sync_ticket_background(ticket.id)

    return RedirectResponse(f"/tickets?submitted={ticket.id}", status_code=303)
