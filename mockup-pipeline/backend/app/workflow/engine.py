"""Workflow engine (spec 4): runs a job along its workflow graph (app.workflow.runner).

The engine steps, in the order their outputs depend on each other:

ingest -> trim_artwork -> extract_specs -> validate -> match_pouch_type -> resolve_keyline ->
link_panels -> build_geometry -> texture -> render -> export

Each step is its own module with a typed output stored in job_steps. A step that raises
NeedsReview pauses the job until an operator fixes the input and the job resumes; any other
exception fails the job (the traceback is kept). Steps are idempotent: re-running one overwrites
its own outputs under the job's storage prefix. Which steps run, in what order and with what
decisions in between is the workflow graph (index kind `workflow`, edited on the canvas).
"""

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_engine
from app.models import Job, JobStep, utcnow
from app.pdf import raise_stream_limits
from app.storage import get_storage
from app.workflow import runner
from app.workflow.context import StepContext
from app.workflow.runner import STEPS, step_module  # noqa: F401 - re-exported

log = logging.getLogger("workflow")


PENDING = "pending_from"  # job.inputs: where a queued rerun that was paused / cancelled before it ran starts


def _remember_start(job: Job, from_step: str | None, from_node: str | None) -> None:
    """Keep a queue entry's start point on the job (the entry itself is gone once popped)."""
    if from_step not in STEPS and not from_node:
        return
    inputs = dict(job.inputs or {})
    p = dict(inputs.get(PENDING) or {})
    old = p.get("step")
    if from_step in STEPS and (old not in STEPS or STEPS.index(from_step) < STEPS.index(old)):
        p["step"] = from_step
    if from_node and from_node not in (p.get("nodes") or []):
        p["nodes"] = [*(p.get("nodes") or []), from_node]
    inputs[PENDING] = p
    job.inputs = inputs


def run_job(job_id: int, from_step: str | None = None, engine=None, from_node: str | None = None) -> str:
    """Run a job: redo `from_step` and everything after it (default: only what has not run yet),
    or everything from `from_node` of its workflow. Returns the final job status."""
    raise_stream_limits()
    with Session(engine or get_engine(), expire_on_commit=False) as session:
        job = session.get(Job, job_id)
        if job is None:
            raise ValueError(f"job {job_id} does not exist")
        if job.control in ("pause", "cancel"):  # asked for while the job was still queued
            _remember_start(job, from_step, from_node)
            return runner.apply_control(session, job, None, job.control)
        if job.status in ("CANCELLED", "PAUSED"):
            # a stale queue entry (whatever step it names): resume / rerun set the status back to QUEUED first.
            # Its start point is kept on the job: a rerun / adjustment paused while queued is redone on Resume
            # (otherwise Resume found every step done and called the job DONE with the old renders).
            _remember_start(job, from_step, from_node)
            session.commit()
            return job.status
        # Start points kept on the job: "_queued_from" (queue.enqueue, thread mode: survives a restart) and
        # PENDING (a queue entry popped while the job was paused / cancelled, any mode). The earliest step wins.
        inputs = dict(job.inputs or {})
        queued_from = inputs.pop("_queued_from", None) or {}
        pending = inputs.pop(PENDING, None) or {}
        if queued_from or pending:
            job.inputs = inputs
        for p_step in (queued_from.get("step"), pending.get("step")):
            if p_step in STEPS and (from_step not in STEPS or STEPS.index(p_step) < STEPS.index(from_step)):
                from_step = p_step
        nodes = [n for n in [from_node, queued_from.get("node"), *(pending.get("nodes") or [])] if n]
        graph, key, version = runner.load_graph(session, job)
        if job.kind != "test" and key and (job.workflow_key != key or job.workflow_version != version):
            job.workflow_key, job.workflow_version = key, version
        start = STEPS.index(from_step) if from_step in STEPS else None
        for node in dict.fromkeys(nodes):
            if graph.node(node) is None:
                continue
            node_start = runner.reset_index(graph, node, session)
            if node_start is not None:
                start = node_start if start is None else min(start, node_start)
            inputs = dict(job.inputs or {})
            reviews = dict(inputs.get("reviews") or {})
            if reviews.pop(node, None) is not None:
                inputs["reviews"] = reviews
                job.inputs = inputs
        if start is not None:
            for row in session.scalars(select(JobStep).where(JobStep.job_id == job_id, JobStep.step.in_(STEPS[start:]))):
                row.status = "pending"
        job.status, job.review, job.error, job.current_node, job.updated_at = "RUNNING", None, None, None, utcnow()
        session.commit()
        ctx = StepContext(session=session, job=job, storage=get_storage(), settings=get_settings())
        return runner.Walker(session, job, ctx, graph).run()


def run_job_safe(job_id: int, from_step: str | None = None, from_node: str | None = None) -> None:
    """Queue entry point: never lets an exception escape into the worker loop."""
    try:
        run_job(job_id, from_step, from_node=from_node)
    except Exception as exc:  # noqa: BLE001
        log.exception("job crashed outside a step", extra={"fields": {"job": job_id}})
        try:  # (never leave the row RUNNING for ever: the UI would show a running job and refuse every rerun)
            with Session(get_engine()) as session:
                job = session.get(Job, job_id)
                if job is not None and job.status in ("RUNNING", "QUEUED"):
                    job.status, job.error, job.updated_at = "FAILED", f"crashed outside a step: {exc}"[:2000], utcnow()
                    session.commit()
        except Exception:  # noqa: BLE001 - the database itself is down: nothing more to do here
            log.exception("could not mark the crashed job failed", extra={"fields": {"job": job_id}})
