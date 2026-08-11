"""Password hashing, signed session cookies, and auth dependencies."""

from __future__ import annotations

import bcrypt
from fastapi import Depends, HTTPException, Request, Response, status
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import User

settings = get_settings()

_serializer = URLSafeTimedSerializer(settings.secret_key, salt="codepr-monitor-session")

# bcrypt only considers the first 72 bytes of input and errors on longer ones.
_BCRYPT_MAX_BYTES = 72


def _truncate(password: str) -> bytes:
    return password.encode("utf-8")[:_BCRYPT_MAX_BYTES]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_truncate(password), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(_truncate(password), password_hash.encode("utf-8"))
    except ValueError:
        return False


def set_session(
    response: Response, user: User, *, impersonator: User | None = None
) -> None:
    """Sign a session for `user`.

    `impersonator` records the admin behind an impersonated session. It is the
    only thing that separates "signed in as this person" from "acting as this
    person", so it is carried inside the signed cookie rather than anywhere the
    browser could edit.
    """
    payload: dict[str, int] = {"uid": user.id}
    if impersonator is not None:
        payload["imp"] = impersonator.id

    token = _serializer.dumps(payload)
    response.set_cookie(
        settings.session_cookie_name,
        token,
        max_age=settings.session_max_age_seconds,
        httponly=True,
        samesite="lax",
        path="/",
    )


def clear_session(response: Response) -> None:
    response.delete_cookie(settings.session_cookie_name, path="/")


def get_current_user(
    request: Request, db: Session = Depends(get_db)
) -> User | None:
    """Resolve the signed session cookie to the effective user, or None.

    "Effective" matters while an admin is impersonating: this returns the person
    being acted as, so every permission check in the app — including
    `require_admin` — measures the impersonated account rather than the admin
    behind it. The admin is stashed on `request.state.impersonator` for the
    banner and for the route that ends the impersonation.
    """
    request.state.impersonator = None

    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        return None
    try:
        data = _serializer.loads(token, max_age=settings.session_max_age_seconds)
    except (BadSignature, SignatureExpired):
        return None
    user_id = data.get("uid")
    if not isinstance(user_id, int):
        return None

    user = db.get(User, user_id)
    if user is None:
        return None

    impersonator_id = data.get("imp")
    if impersonator_id is not None:
        # The cookie is signed, but the standing behind it can be revoked. An
        # impersonation is only valid while the admin who started it is still an
        # admin, so a demoted or deleted admin invalidates the whole session
        # rather than silently leaving their session logged in as someone else.
        impersonator = (
            db.get(User, impersonator_id) if isinstance(impersonator_id, int) else None
        )
        if impersonator is None or not impersonator.is_admin:
            return None
        request.state.impersonator = impersonator

    return user


def get_impersonator(
    request: Request, user: User | None = Depends(get_current_user)
) -> User | None:
    """The admin behind an impersonated session, or None for a normal one."""
    return getattr(request.state, "impersonator", None)


def _redirect_to_login() -> HTTPException:
    # Browsers follow the Location header; /api callers get this as a 401 body.
    return HTTPException(
        status_code=status.HTTP_303_SEE_OTHER,
        detail="Authentication required.",
        headers={"Location": "/login"},
    )


def require_user(user: User | None = Depends(get_current_user)) -> User:
    if user is None:
        raise _redirect_to_login()
    return user


def require_admin(user: User = Depends(require_user)) -> User:
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This area is restricted to administrators.",
        )
    return user


def require_impersonation(
    impersonator: User | None = Depends(get_impersonator),
) -> User:
    """The admin to hand the session back to when impersonation ends.

    Deliberately not behind `require_admin`: an admin acting as a client is not
    an admin for the length of that session, so the way out cannot sit in the
    admin area.
    """
    if impersonator is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No impersonation is in progress.",
        )
    return impersonator
