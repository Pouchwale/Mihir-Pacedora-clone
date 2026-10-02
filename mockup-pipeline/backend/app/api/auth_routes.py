from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import auth
from app.db import get_session
from app.models import User

router = APIRouter(prefix="/api")


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    role: str
    active: bool

    @classmethod
    def of(cls, u: User) -> "UserOut":
        return cls(id=u.id, email=u.email, name=u.name, role=u.role, active=u.active)


class LoginIn(BaseModel):
    email: str
    password: str


@router.post("/auth/login")
def login(body: LoginIn, response: Response, session: Session = Depends(get_session)) -> UserOut:
    user, token = auth.login(session, body.email, body.password)
    auth.set_cookie(response, token)
    return UserOut.of(user)


@router.post("/auth/logout")
def logout(request: Request, response: Response, session: Session = Depends(get_session)) -> dict:
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


class UserCreate(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    name: str = ""
    role: auth.Role
    password: str


class UserPatch(BaseModel):
    name: str | None = None
    role: auth.Role | None = None
    active: bool | None = None
    password: str | None = Field(None, description="Set a new password")


@router.get("/users")
def list_users(session: Session = Depends(get_session), _: User = Depends(auth.require_admin)) -> list[UserOut]:
    return [UserOut.of(u) for u in session.scalars(select(User).order_by(User.email))]


@router.post("/users")
def create_user(body: UserCreate, session: Session = Depends(get_session), _: User = Depends(auth.require_admin)) -> UserOut:
    auth.validate_password(body.password)
    email = body.email.strip().lower()
    if session.scalar(select(User).where(User.email == email)):
        raise HTTPException(409, "A user with this email exists")
    user = User(email=email, name=body.name, role=body.role, password_hash=auth.hash_password(body.password))
    session.add(user)
    session.commit()
    return UserOut.of(user)


@router.patch("/users/{user_id}")
def update_user(user_id: int, body: UserPatch, session: Session = Depends(get_session), admin: User = Depends(auth.require_admin)) -> UserOut:
    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(404, "No such user")
    demoting = (body.role and body.role != "admin") or body.active is False
    if user.role == "admin" and demoting:
        admins = session.scalar(select(func.count()).select_from(User).where(User.role == "admin", User.active.is_(True)))
        if admins <= 1:
            raise HTTPException(409, "Keep at least one active administrator")
    if body.name is not None:
        user.name = body.name
    if body.role is not None:
        user.role = body.role
    if body.active is not None:
        user.active = body.active
    if body.password:
        auth.validate_password(body.password)
        user.password_hash = auth.hash_password(body.password)
        user.failed_logins, user.locked_until = 0, None
    session.commit()
    return UserOut.of(user)
