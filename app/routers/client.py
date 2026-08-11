"""Client-facing pages: page status and ticket submission."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..access import accessible_sites, can_access, visible_site_ids
from ..attachments import AttachmentError, clean_filename, read_image
from ..config import get_settings
from ..db import get_db
from ..models import Site, Ticket, TicketAttachment, TicketKind, User
from ..odoo import sync_ticket_background
from ..presenters import build_site_cards, summarize
from ..security import require_user
from ..templating import templates

router = APIRouter(tags=["client"])
settings = get_settings()


@router.get("/status", response_class=HTMLResponse)
def status_page(
    request: Request,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    cards = build_site_cards(db, only_site_ids=visible_site_ids(user))
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
    sites = accessible_sites(db, user)
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
            "max_attachments": settings.max_attachments_per_ticket,
            "max_attachment_mb": settings.max_attachment_mb,
        },
        status_code=status_code,
    )


def _collect_screenshots(uploads: list[UploadFile]) -> list[TicketAttachment]:
    """Validate the uploaded screenshots into unsaved attachment rows.

    Raises AttachmentError with a message meant for the client.

    Submitting the form without picking a file still sends one part for the
    input, with a blank filename. Those are dropped here before anything is
    counted or read.

    The filename is read with getattr rather than an isinstance check: FastAPI
    hands over Starlette's UploadFile, not the FastAPI subclass this module
    imports, so isinstance against the latter is False for every real upload.
    (Widening the annotation to `UploadFile | str` is also wrong — pydantic
    resolves that union by coercing every upload to a string.)
    """
    chosen = [up for up in uploads if (getattr(up, "filename", "") or "").strip()]
    if not chosen:
        return []

    if len(chosen) > settings.max_attachments_per_ticket:
        raise AttachmentError(
            f"Attach at most {settings.max_attachments_per_ticket} screenshots. "
            f"You selected {len(chosen)}."
        )

    attachments: list[TicketAttachment] = []
    for upload in chosen:
        filename = clean_filename(upload.filename or "")
        data, content_type = read_image(
            upload.file,
            max_bytes=settings.max_attachment_bytes,
            label=filename,
        )
        attachments.append(
            TicketAttachment(
                filename=filename,
                content_type=content_type,
                size_bytes=len(data),
                data=data,
            )
        )
    return attachments


@router.get("/tickets/attachments/{attachment_id}")
def ticket_attachment(
    attachment_id: int,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Serve one screenshot to its submitter, or to any admin."""
    attachment = db.get(TicketAttachment, attachment_id)

    # A missing attachment and someone else's attachment answer identically, so
    # a client cannot probe for which ticket ids exist.
    if attachment is None or (
        not user.is_admin and attachment.ticket.user_id != user.id
    ):
        raise HTTPException(status_code=404, detail="Screenshot not found.")

    return Response(
        content=attachment.data,
        media_type=attachment.content_type,
        headers={
            # clean_filename leaves nothing that could break out of the quotes.
            "Content-Disposition": f'inline; filename="{attachment.filename}"',
            # The stored type was sniffed, not taken from the client; tell the
            # browser not to second-guess it, and forbid the response from
            # pulling in anything of its own.
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src 'self'",
            "Cache-Control": "private, max-age=300",
        },
    )


@router.post("/tickets")
def submit_ticket(
    request: Request,
    site_id: str = Form(""),
    kind: str = Form("issue"),
    subject: str = Form(""),
    body: str = Form(""),
    screenshots: list[UploadFile] = File(default=[]),
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

    # The dropdown only offers pages this user holds, but the id arrives in the
    # request body, so the same rule is enforced here rather than trusted.
    if not can_access(user, site):
        return _render_tickets(
            request,
            db,
            user,
            error="You do not have access to that page.",
            status_code=403,
        )

    if not subject:
        return _render_tickets(
            request, db, user, error="Add a short subject.", status_code=400
        )

    try:
        ticket_kind = TicketKind(kind)
    except ValueError:
        ticket_kind = TicketKind.ISSUE

    try:
        attachments = _collect_screenshots(screenshots)
    except AttachmentError as exc:
        # A browser cannot repopulate a file input, so say so rather than let the
        # client wonder why the picker went blank.
        return _render_tickets(
            request,
            db,
            user,
            error=f"{exc} Please choose the screenshots again.",
            status_code=400,
        )

    # submitted_at, user, and site are all captured here; they are the fields the
    # client sees on their ticket and the ones mirrored to Odoo.
    ticket = Ticket(
        site_id=site.id,
        user_id=user.id,
        subject=subject[:200],
        body=body.strip(),
        kind=ticket_kind,
        attachments=attachments,
    )
    db.add(ticket)
    db.commit()
    db.refresh(ticket)

    sync_ticket_background(ticket.id)

    return RedirectResponse(f"/tickets?submitted={ticket.id}", status_code=303)
