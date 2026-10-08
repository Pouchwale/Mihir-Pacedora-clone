"""Email + password auth with server-side sessions (spec section 6).

The browser holds a random token in an HttpOnly cookie; the database stores only its SHA-256.
Mutating requests must carry `X-Requested-With: fetch`, which a cross-site form cannot send (CSRF).
"""

import hashlib
import secrets
from datetime import timedelta
from types import SimpleNamespace
from typing import Literal

import bcrypt
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_session
from app.models import User, UserSession, utcnow

COOKIE = "pm_session"
Role = Literal["admin", "head_designer", "designer", "manager"]
ROLE_LABELS = {"admin": "Admin", "head_designer": "Head of Designer", "designer": "Designer", "manager": "Manager"}
# What each role may do beyond using jobs (upload, review, adjust, share, download), which everyone may.
PERMISSIONS = {
    "manage_users": {"admin"},                                    # the Users page: accounts, roles, passwords
    "view_activity": {"admin", "manager"},                        # the activity log of every user
    "edit_index": {"admin", "head_designer", "designer"},         # index entries (materials, clients, ...)
    "edit_keyline": {"admin", "head_designer"},                   # keyline / dieline values and workflows
    "approve": {"admin", "head_designer", "manager"},             # approve finished jobs
    "see_all_jobs": {"admin"},                                    # everyone else sees only the jobs they uploaded
    "manage_errors": {"admin"},                                   # the error reports users raise
}
# Index kinds that hold keyline and dieline values: designers may look but not change them.
KEYLINE_KINDS = {"keyline_template", "pouch_type", "standard_size", "workflow"}
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
    request.state.user = SimpleNamespace(email=s.user.email, role=s.user.role)  # for the activity log
    return s.user


def can(user: User, permission: str) -> bool:
    return user.role in PERMISSIONS[permission]


def permissions(user: User) -> list[str]:
    return [p for p, roles in PERMISSIONS.items() if user.role in roles]


def require(permission: str):
    """Dependency: the signed-in user, or 403 when their role lacks `permission`."""
    def check(user: User = Depends(current_user)) -> User:
        if not can(user, permission):
            raise HTTPException(403, f"Your role ({ROLE_LABELS.get(user.role, user.role)}) may not do this")
        return user
    return check


def can_edit_kind(user: User, kind: str) -> bool:
    return can(user, "edit_keyline" if kind in KEYLINE_KINDS else "edit_index")


def require_kind(user: User, kind: str) -> None:
    if not can_edit_kind(user, kind):
        what = "keyline, dieline and workflow values" if kind in KEYLINE_KINDS else "the index"
        raise HTTPException(403, f"Your role ({ROLE_LABELS.get(user.role, user.role)}) may not change {what}")


require_admin = require("manage_users")


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
