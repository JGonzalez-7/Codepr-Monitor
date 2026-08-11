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


def set_session(response: Response, user: User) -> None:
    token = _serializer.dumps({"uid": user.id})
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
    """Resolve the signed session cookie to a user, or None."""
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
    return db.get(User, user_id)


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
