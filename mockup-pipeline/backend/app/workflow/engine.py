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


def run_job(job_id: int, from_step: str | None = None, engine=None, from_node: str | None = None) -> str:
    """Run a job: redo `from_step` and everything after it (default: only what has not run yet),
    or everything from `from_node` of its workflow. Returns the final job status."""
    raise_stream_limits()
    with Session(engine or get_engine(), expire_on_commit=False) as session:
        job = session.get(Job, job_id)
        if job is None:
            raise ValueError(f"job {job_id} does not exist")
        if job.control in ("pause", "cancel"):  # asked for while the job was still queued
            return runner.apply_control(session, job, None, job.control)
        if job.status in ("CANCELLED", "PAUSED") and from_step is None and from_node is None:
            return job.status  # a stale queue entry; resume / rerun set the status back to QUEUED first
        graph, key, version = runner.load_graph(session, job)
        if job.kind != "test" and key and (job.workflow_key != key or job.workflow_version != version):
            job.workflow_key, job.workflow_version = key, version
        start = STEPS.index(from_step) if from_step in STEPS else None
        if from_node and graph.node(from_node) is not None:
            node_start = runner.reset_index(graph, from_node)
            if node_start is not None:
                start = node_start if start is None else min(start, node_start)
            inputs = dict(job.inputs or {})
            reviews = dict(inputs.get("reviews") or {})
            if reviews.pop(from_node, None) is not None:
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
    except Exception:  # noqa: BLE001
        log.exception("job crashed outside a step", extra={"fields": {"job": job_id}})
