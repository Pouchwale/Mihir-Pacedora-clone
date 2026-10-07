from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app import activity, auth
from app.config import get_settings
from app.db import get_session
from app.models import User, UserSession, utcnow

router = APIRouter(prefix="/api")


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    role: str
    active: bool
    permissions: list[str] = []
    locked: bool = False
    created_at: datetime | None = None
    last_login_at: datetime | None = None

    @classmethod
    def of(cls, u: User) -> "UserOut":
        locked = bool(u.locked_until and auth._aware(u.locked_until) > utcnow())
        return cls(id=u.id, email=u.email, name=u.name, role=u.role, active=u.active, permissions=auth.permissions(u),
                   locked=locked, created_at=u.created_at, last_login_at=u.last_login_at)


class LoginIn(BaseModel):
    email: str
    password: str


@router.post("/auth/login")
def login(body: LoginIn, request: Request, response: Response, session: Session = Depends(get_session)) -> UserOut:
    try:
        user, token = auth.login(session, body.email, body.password)
    except HTTPException as exc:
        activity.record("sign-in failed", None, request, email=body.email.strip().lower(), reason=exc.detail)
        raise
    auth.set_cookie(response, token)
    request.state.user = SimpleNamespace(email=user.email, role=user.role)  # the request's log line names who signed in
    activity.record("signed in", user, request)
    return UserOut.of(user)


@router.post("/auth/logout")
def logout(request: Request, response: Response, session: Session = Depends(get_session)) -> dict:
    try:
        activity.record("signed out", auth.current_user(request, session), request)
    except HTTPException:
        pass
    auth.logout(session, request.cookies.get(auth.COOKIE))
    auth.clear_cookie(response)
    return {"ok": True}


@router.get("/auth/session")
def session_user(request: Request, session: Session = Depends(get_session)) -> dict:
    """Who is signed in, or null. Unlike /auth/me this never answers 401 (used on page load)."""
    try:
        return {"user": UserOut.of(auth.current_user(request, session))}
    except HTTPException:
        return {"user": None}


@router.get("/auth/me")
def me(user: User = Depends(auth.current_user)) -> UserOut:
    return UserOut.of(user)


@router.get("/roles")
def roles(_: User = Depends(auth.current_user)) -> list[dict]:
    """The roles and what each may do, for the Users page."""
    return [{"role": r, "label": label, "permissions": [p for p, rs in auth.PERMISSIONS.items() if r in rs]}
            for r, label in auth.ROLE_LABELS.items()]


EMAIL = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class UserCreate(BaseModel):
    email: str = Field(pattern=EMAIL)
    name: str = ""
    role: auth.Role
    password: str


class UserPatch(BaseModel):
    email: str | None = Field(None, pattern=EMAIL)
    name: str | None = None
    role: auth.Role | None = None
    active: bool | None = None
    password: str | None = Field(None, description="Set a new password")
    unlock: bool = False  # clear the lock after too many wrong passwords


def _sign_out(session: Session, user: User) -> int:
    """End every session of the user, so a new password, deactivation or role change applies at once."""
    return session.execute(delete(UserSession).where(UserSession.user_id == user.id)).rowcount or 0


def _user(session: Session, user_id: int) -> User:
    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(404, "No such user")
    return user


@router.get("/users")
def list_users(session: Session = Depends(get_session), _: User = Depends(auth.require_admin)) -> list[UserOut]:
    return [UserOut.of(u) for u in session.scalars(select(User).order_by(User.email))]


@router.post("/users")
def create_user(body: UserCreate, request: Request, session: Session = Depends(get_session), admin: User = Depends(auth.require_admin)) -> UserOut:
    auth.validate_password(body.password)
    email = body.email.strip().lower()
    if session.scalar(select(User).where(User.email == email)):
        raise HTTPException(409, "A user with this email exists")
    user = User(email=email, name=body.name, role=body.role, password_hash=auth.hash_password(body.password))
    session.add(user)
    session.commit()
    activity.record("user created", admin, request, target=email, name=body.name, new_role=body.role)
    return UserOut.of(user)


@router.patch("/users/{user_id}")
def update_user(user_id: int, body: UserPatch, request: Request, session: Session = Depends(get_session), admin: User = Depends(auth.require_admin)) -> UserOut:
    user = _user(session, user_id)
    demoting = (body.role and body.role != "admin") or body.active is False
    if user.role == "admin" and demoting:
        admins = session.scalar(select(func.count()).select_from(User).where(User.role == "admin", User.active.is_(True)))
        if admins <= 1:
            raise HTTPException(409, "Keep at least one active administrator")
    changes: dict = {}
    if body.email is not None and body.email.strip().lower() != user.email:
        email = body.email.strip().lower()
        if session.scalar(select(User).where(User.email == email, User.id != user.id)):
            raise HTTPException(409, "A user with this email exists")
        changes["email"] = [user.email, email]
        user.email = email
    if body.name is not None and body.name != user.name:
        changes["name"] = [user.name, body.name]
        user.name = body.name
    if body.role is not None and body.role != user.role:
        changes["role"] = [user.role, body.role]
        user.role = body.role
    if body.active is not None and body.active != user.active:
        changes["active"] = [user.active, body.active]
        user.active = body.active
    if body.password:
        auth.validate_password(body.password)
        user.password_hash = auth.hash_password(body.password)
        user.failed_logins, user.locked_until = 0, None
        changes["credentials_reset"] = True  # never the value (a "password" key would be masked anyway)
    if body.unlock and (user.locked_until or user.failed_logins):
        user.failed_logins, user.locked_until = 0, None
        changes["unlocked"] = True
    if ({"credentials_reset", "role", "email"} & changes.keys() or changes.get("active") == [True, False]) and user.id != admin.id:
        changes["sessions_ended"] = _sign_out(session, user)  # the admin's own session survives their own edit
    session.commit()
    if changes:
        activity.record("user changed", admin, request, target=user.email, changes=changes)
    return UserOut.of(user)


@router.post("/users/{user_id}/sign-out")
def sign_out_user(user_id: int, request: Request, session: Session = Depends(get_session), admin: User = Depends(auth.require_admin)) -> dict:
    user = _user(session, user_id)
    ended = _sign_out(session, user)
    session.commit()
    activity.record("user signed out by admin", admin, request, target=user.email, sessions_ended=ended)
    return {"sessions_ended": ended}


# ---------------------------------------------------------------- activity log
class PageView(BaseModel):
    page: str = Field(max_length=300)


@router.post("/activity")
def page_view(body: PageView, request: Request, user: User = Depends(auth.current_user)) -> dict:
    """The app reports each page a user opens; with the API calls this is their whole trail."""
    activity.record("page", user, request, page=body.page)
    return {"ok": True}


@router.get("/activity")
def activity_log(day: str | None = None, user: str | None = None, action: str | None = None, reads: bool = False,
                 page: int = Query(1, ge=1), page_size: int = Query(100, ge=10, le=1000),
                 _: User = Depends(auth.require("view_activity"))) -> dict:
    day = day or date.today().isoformat()
    try:
        entries, total, everyone = activity.read(day, user or None, action or None, reads, (page - 1) * page_size, page_size)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"day": day, "days": activity.days(), "users": everyone, "entries": entries, "total": total,
            "page": page, "page_size": page_size, "pages": max(1, -(-total // page_size)),
            "folder": str(Path(get_settings().data_dir).resolve())}
