"""Email + password auth with server-side sessions (spec section 6).

The browser holds a random token in an HttpOnly cookie; the database stores only its SHA-256.
Mutating requests must carry `X-Requested-With: fetch`, which a cross-site form cannot send (CSRF).
"""

import hashlib
import secrets
from datetime import timedelta
from typing import Literal

import bcrypt
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_session
from app.models import User, UserSession, utcnow

COOKIE = "pm_session"
Role = Literal["admin", "operator"]
MAX_FAILED = 8
LOCK_MINUTES = 15
MIN_PASSWORD = 10


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def check_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except ValueError:
        return False


def validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD:
        raise HTTPException(422, f"Password must be at least {MIN_PASSWORD} characters")


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def login(session: Session, email: str, password: str) -> tuple[User, str]:
    user = session.scalar(select(User).where(User.email == email.strip().lower()))
    now = utcnow()
    if user and user.locked_until and _aware(user.locked_until) > now:
        raise HTTPException(429, "Too many failed attempts; try again in a few minutes")
    if user is None or not user.active or not check_password(password, user.password_hash):
        if user:
            user.failed_logins += 1
            if user.failed_logins >= MAX_FAILED:
                user.locked_until = now + timedelta(minutes=LOCK_MINUTES)
                user.failed_logins = 0
            session.commit()
        raise HTTPException(401, "Wrong email or password")
    user.failed_logins = 0
    user.locked_until = None
    user.last_login_at = now
    token = secrets.token_urlsafe(32)
    session.add(UserSession(token_hash=_token_hash(token), user_id=user.id, expires_at=now + timedelta(hours=get_settings().session_hours)))
    session.commit()
    return user, token


def logout(session: Session, token: str | None) -> None:
    if token:
        s = session.get(UserSession, _token_hash(token))
        if s:
            session.delete(s)
            session.commit()


def set_cookie(response: Response, token: str) -> None:
    s = get_settings()
    response.set_cookie(COOKIE, token, max_age=s.session_hours * 3600, httponly=True, secure=s.cookie_secure, samesite="lax", path="/")


def clear_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE, path="/")


def _aware(dt):
    from datetime import timezone

    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)  # SQLite returns naive datetimes


def current_user(request: Request, session: Session = Depends(get_session)) -> User:
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "Not signed in")
    s = session.get(UserSession, _token_hash(token))
    if s is None or _aware(s.expires_at) < utcnow() or not s.user.active:
        raise HTTPException(401, "Session expired")
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("x-requested-with") != "fetch":
        raise HTTPException(403, "Missing X-Requested-With header")
    return s.user


def require_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(403, "Administrators only")
    return user


def ensure_admin(session: Session) -> str | None:
    """Create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD while no active admin exists."""
    if session.scalar(select(User).where(User.role == "admin", User.active.is_(True))):
        return None
    s = get_settings()
    if not s.admin_email or not s.admin_password:
        return "No administrator exists. Set ADMIN_EMAIL and ADMIN_PASSWORD."
    if len(s.admin_password) < MIN_PASSWORD:
        return f"ADMIN_PASSWORD must be at least {MIN_PASSWORD} characters."
    email = s.admin_email.strip().lower()
    user = session.scalar(select(User).where(User.email == email))
    if user:
        user.role, user.active, user.password_hash = "admin", True, hash_password(s.admin_password)
    else:
        session.add(User(email=email, name="Administrator", role="admin", password_hash=hash_password(s.admin_password)))
    session.commit()
    return f"Administrator {email} created."
