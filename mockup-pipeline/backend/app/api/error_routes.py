"""The "Raise an error" button: any user reports a problem (from a job page or anywhere in the app, an optional
note); the admin sees every report, handles it and marks it resolved. Users see their own reports."""

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import activity, auth
from app.db import get_session
from app.models import ErrorReport, Job, User, utcnow

router = APIRouter(prefix="/api/errors")


class ReportIn(BaseModel):
    job_id: int | None = None
    message: str = Field("", max_length=4000)
    page: str = Field("", max_length=300)


class ReportOut(BaseModel):
    id: int
    job_id: int | None
    item_code: str | None
    user: str | None
    message: str
    page: str
    context: dict | None
    status: str
    admin_note: str
    resolved_by: str | None
    resolved_at: datetime | None
    created_at: datetime


def _out(session: Session, r: ErrorReport) -> ReportOut:
    job = session.get(Job, r.job_id) if r.job_id else None
    return ReportOut(id=r.id, job_id=r.job_id, item_code=job.item_code if job else None, user=r.user.email if r.user else None,
                     message=r.message, page=r.page, context=r.context, status=r.status, admin_note=r.admin_note,
                     resolved_by=r.resolved_by, resolved_at=r.resolved_at, created_at=r.created_at)


@router.post("")
def raise_error(body: ReportIn, request: Request, session: Session = Depends(get_session), user: User = Depends(auth.current_user)) -> ReportOut:
    context = None
    if body.job_id is not None:
        job = session.get(Job, body.job_id)
        if job is None or not (auth.can(user, "see_all_jobs") or job.created_by_id == user.id):
            raise HTTPException(404, "No such job")
        # the job as it was when the user hit the problem (it may be rerun before the admin looks)
        context = {"item_code": job.item_code, "status": job.status, "step": job.current_step, "node": job.current_node,
                   "pouch_type": job.pouch_type, "error": (job.error or "")[:1000] or None,
                   "review": (job.review or {}).get("message")}
    report = ErrorReport(user_id=user.id, job_id=body.job_id, message=body.message.strip(), page=body.page, context=context)
    session.add(report)
    session.commit()
    activity.record("error raised", user, request, report=report.id, job=body.job_id, message=body.message.strip()[:300])
    return _out(session, report)


@router.get("")
def list_errors(status: Literal["open", "resolved", "all"] = "open", session: Session = Depends(get_session),
                user: User = Depends(auth.current_user)) -> dict:
    """The admin: every report. Everyone else: the reports they raised."""
    query = select(ErrorReport)
    if not auth.can(user, "manage_errors"):
        query = query.where(ErrorReport.user_id == user.id)
    sub = query.subquery()
    counts = dict(session.execute(select(sub.c.status, func.count()).group_by(sub.c.status)).all())
    if status != "all":
        query = query.where(ErrorReport.status == status)
    reports = session.scalars(query.order_by(ErrorReport.id.desc()).limit(500))
    return {"reports": [_out(session, r) for r in reports], "counts": {"open": counts.get("open", 0), "resolved": counts.get("resolved", 0)}}


class ReportPatch(BaseModel):
    status: Literal["open", "resolved"] | None = None
    admin_note: str | None = Field(None, max_length=4000)


@router.patch("/{report_id}")
def handle_error(report_id: int, body: ReportPatch, request: Request, session: Session = Depends(get_session),
                 admin: User = Depends(auth.require("manage_errors"))) -> ReportOut:
    report = session.get(ErrorReport, report_id)
    if report is None:
        raise HTTPException(404, "No such report")
    if body.admin_note is not None:
        report.admin_note = body.admin_note
    if body.status is not None and body.status != report.status:
        report.status = body.status
        report.resolved_by, report.resolved_at = (admin.email, utcnow()) if body.status == "resolved" else (None, None)
    session.commit()
    activity.record("error handled", admin, request, report=report.id, status=report.status, note=report.admin_note[:300])
    return _out(session, report)
