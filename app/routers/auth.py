"""Login, logout, and ending an impersonated session."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User
from ..security import (
    clear_session,
    get_current_user,
    require_impersonation,
    set_session,
    verify_password,
)
from ..templating import templates

log = logging.getLogger(__name__)

router = APIRouter(tags=["auth"])


def landing_for(user: User) -> str:
    return "/admin" if user.is_admin else "/status"


@router.get("/", include_in_schema=False)
def index(user: User | None = Depends(get_current_user)) -> RedirectResponse:
    if user is None:
        return RedirectResponse("/login", status_code=303)
    return RedirectResponse(landing_for(user), status_code=303)


@router.get("/login", response_class=HTMLResponse)
def login_form(request: Request, user: User | None = Depends(get_current_user)):
    if user is not None:
        return RedirectResponse(landing_for(user), status_code=303)
    return templates.TemplateResponse(request, "login.html", {"error": None})


@router.post("/login")
def login(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db),
):
    user = db.scalar(select(User).where(User.username == username.strip().lower()))

    # Same message either way so the form does not reveal which usernames exist.
    if user is None or not verify_password(password, user.password_hash):
        return templates.TemplateResponse(
            request,
            "login.html",
            {"error": "Incorrect username or password."},
            status_code=401,
        )

    response = RedirectResponse(landing_for(user), status_code=303)
    set_session(response, user)
    return response


@router.post("/logout")
def logout() -> RedirectResponse:
    response = RedirectResponse("/login", status_code=303)
    clear_session(response)
    return response


@router.post("/impersonate/stop")
def stop_impersonating(
    admin: User = Depends(require_impersonation),
) -> RedirectResponse:
    """Hand the session back to the admin who started the impersonation.

    This lives here rather than under /admin because the session doing the
    asking is not an admin one — that is the whole point of it.
    """
    log.info("Impersonation ended, session returned to %s", admin.username)
    response = RedirectResponse(landing_for(admin), status_code=303)
    set_session(response, admin)
    return response
