"""Graph runner (spec 4): walks a job's workflow graph and runs the engine steps its nodes stand for.

Every run walks the graph again from START. Engine steps whose last result is still valid are kept
(a node whose steps are all done passes without work), decisions are evaluated afresh on the
current data, and the nodes visited are written to `job.workflow_path` as they run: that record is
what the live canvas colours (green passed, amber paused for review, red failed, grey not visited).

`from_step` (reruns, review resumes) marks the engine steps to redo: that step and every later one
are reset before the walk. `from_node` maps a node to the earliest step it or anything after it
runs, and clears the node's own review acknowledgement so a REVIEW pauses again.
"""

import importlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import NeedsReview
from app.config import get_settings
from app.index import store
from app.index.conditions import matches, spec_context
from app.index.graph import NODE_LABELS, NODE_STEPS, Edge, Node, WorkflowGraph, linear_graph, summarize_edge
from app.models import Job, JobStep, utcnow
from app.specs.validate import Issue
from app.workflow.context import StepContext, format_exception

STEPS = [
    "ingest", "trim_artwork", "extract_specs", "validate", "match_pouch_type", "resolve_keyline",
    "link_panels", "build_geometry", "texture", "render", "export",
]
MAX_SUB_DEPTH = 5
log = logging.getLogger("workflow")


def step_module(name: str):
    return importlib.import_module(f"app.workflow.steps.{name}")


class _Stop(Exception):
    """The walk ended early (paused, cancelled, waiting for review or failed); the job row says why."""

    def __init__(self, status: str):
        super().__init__(status)
        self.status = status


def control_request(session: Session, job_id: int) -> str | None:
    """The operator's pause / cancel request as committed right now (not the session's cached row)."""
    return session.execute(select(Job.control).where(Job.id == job_id)).scalar_one_or_none()


def apply_control(session: Session, job: Job, ctx: StepContext | None, request: str) -> str:
    """Act on a pause / cancel request: the job stops here and the row says so."""
    job.control = None
    job.current_node = None
    job.status = "PAUSED" if request == "pause" else "CANCELLED"
    job.review, job.updated_at = None, utcnow()
    if ctx is not None:
        ctx.step = ""
        ctx.log("Paused by the operator; resume continues from the next step" if request == "pause" else "Cancelled by the operator", "audit")
    session.commit()
    return job.status


class WorkflowError(RuntimeError):
    """The graph cannot be walked as written (a draft in test mode, or a broken published version)."""


# ---------------------------------------------------------------- graph loading
def load_graph(session: Session, job: Job) -> tuple[WorkflowGraph, str | None, int | None]:
    """The graph a job runs: a test job's draft snapshot, else the version pinned on the job, else
    the published default; the built-in linear order when nothing is published yet."""
    inputs = job.inputs or {}
    if job.kind == "test" and inputs.get("workflow_graph"):
        return WorkflowGraph.model_validate(inputs["workflow_graph"]), inputs.get("workflow_key") or "draft", None
    key = job.workflow_key or get_settings().default_workflow
    if not job.workflow_key and store.get_version(session, "workflow", key) is None:
        key = "default"
    row = store.get_version(session, "workflow", key, job.workflow_version)
    if row is None or row.entry.archived and job.workflow_version is None:
        if key != "default":
            row = store.get_version(session, "workflow", "default", None)
            key = "default"
        if row is None:
            return linear_graph(), None, None
    return WorkflowGraph.model_validate(row.data), key, row.version


def published_graph(session: Session, key: str, version: int | None = None) -> WorkflowGraph | None:
    row = store.get_version(session, "workflow", key, version)
    return WorkflowGraph.model_validate(row.data) if row else None


def reset_index(graph: WorkflowGraph, node_id: str) -> int | None:
    """Index into STEPS of the first step a rerun from `node_id` must redo (None: nothing to redo)."""
    steps = [s for n in graph.downstream(node_id) for s in NODE_STEPS[graph.node(n).type]]  # type: ignore[union-attr]
    return min((STEPS.index(s) for s in steps), default=None)


# ---------------------------------------------------------------- the walk
@dataclass
class PathNode:
    node: str
    type: str
    label: str
    status: str = "running"  # running, passed, review, failed
    started_at: str = ""
    finished_at: str | None = None
    steps: list[dict[str, Any]] = field(default_factory=list)
    branch: str | None = None  # decision: the edge taken (its condition summary)
    edge: str | None = None
    reason: str = ""
    parent: str | None = None  # the sub_workflow node this ran under
    cached: bool = False  # every step was already done: nothing ran

    def dump(self) -> dict[str, Any]:
        return dict(self.__dict__)


class Walker:
    def __init__(self, session: Session, job: Job, ctx: StepContext, graph: WorkflowGraph):
        self.session, self.job, self.ctx, self.graph = session, job, ctx, graph
        self.path: list[PathNode] = []
        self.rows: dict[str, JobStep] = {r.step: r for r in session.scalars(select(JobStep).where(JobStep.job_id == job.id))}

    # -- bookkeeping
    def _save_path(self) -> None:
        self.job.workflow_path = [p.dump() for p in self.path]
        self.job.updated_at = utcnow()
        self.session.commit()

    def _enter(self, node: Node, parent: str | None) -> PathNode:
        self._obey_control()
        rec = PathNode(node=node.id, type=node.type, label=node.title(), started_at=utcnow().isoformat(), parent=parent)
        self.path.append(rec)
        self.job.current_node = node.id
        self._save_path()
        return rec

    def _obey_control(self) -> None:
        """Between steps: stop when the operator asked to pause or cancel (the path keeps what ran)."""
        request = control_request(self.session, self.job.id)
        if request in ("pause", "cancel"):
            self.job.workflow_path = [p.dump() for p in self.path]
            raise _Stop(apply_control(self.session, self.job, self.ctx, request))

    def _leave(self, rec: PathNode, status: str, reason: str | None = None) -> None:
        rec.status, rec.finished_at = status, utcnow().isoformat()
        if reason:
            rec.reason = reason
        self._save_path()

    # -- walking
    def run(self) -> str:
        start = self.graph.start()
        if start is None:
            return self._fail(None, WorkflowError("the workflow has no START node"))
        try:
            self.walk(self.graph, start.id, 0, None)
        except _Stop as stop:
            return stop.status
        self.job.status, self.job.current_step, self.job.current_node, self.job.updated_at = "DONE", "done", None, utcnow()
        self.ctx.step = ""
        self.ctx.log("Job done", "audit")
        self.session.commit()
        return self.job.status

    def walk(self, graph: WorkflowGraph, node_id: str, depth: int, parent: str | None) -> None:
        cur = graph.node(node_id)
        guard = 0
        while cur is not None:
            guard += 1
            if guard > 500:
                raise _Stop(self._fail(None, WorkflowError("the workflow loops")))
            rec = self._enter(cur, parent)
            self.ctx.step = cur.type if not NODE_STEPS[cur.type] else self.ctx.step
            try:
                nxt = self.execute(graph, cur, rec, depth)
            except NeedsReview as exc:
                # (_run_step already rolled back a step's partial work and marked its row.)
                self._leave(rec, "review", exc.message)
                self.job.status = "NEEDS_REVIEW"
                self.job.review = {"step": self.ctx.step or cur.type, "node": cur.id, **exc.to_dict()}
                self.job.updated_at = utcnow()
                self.ctx.log(f"Needs review: {exc.message}", "warning", {"code": exc.code, "node": cur.id})
                request = control_request(self.session, self.job.id)
                if request in ("pause", "cancel"):  # the operator's stop wins over an automatic answer
                    raise _Stop(apply_control(self.session, self.job, self.ctx, request)) from exc
                if self.ctx.settings.auto_review and self.job.kind != "test":
                    from app.workflow import auto_review, queue
                    from app.workflow.engine import STEPS

                    step = auto_review.try_answer(self.session, self.job, self.ctx, STEPS)
                    if step is not False:
                        self.session.commit()
                        queue.enqueue(self.job.id, step or None)
                        raise _Stop("QUEUED") from exc
                self.session.commit()
                log.info("job needs review", extra={"fields": {"job": self.job.id, "node": cur.id, "code": exc.code}})
                raise _Stop(self.job.status) from exc
            except _Stop:
                raise
            except Exception as exc:  # noqa: BLE001 - every failure is recorded on the job
                self.session.rollback()
                self._leave(rec, "failed", str(exc)[:500])
                raise _Stop(self._fail(cur, exc)) from exc
            self._leave(rec, "passed")
            if cur.type == "end" or nxt is None:
                return
            following = graph.node(nxt)
            if following is None:
                raise _Stop(self._fail(cur, WorkflowError(f"edge leads to unknown node {nxt!r}")))
            cur = following

    def _fail(self, node: Node | None, exc: BaseException) -> str:
        where = f"{NODE_LABELS[node.type]} '{node.title()}'" if node else "workflow"
        self.job.status, self.job.error, self.job.updated_at = "FAILED", f"{where}: {exc}", utcnow()
        self.ctx.log(f"Failed at {where}: {exc}", "error")
        self.session.commit()
        log.error("job failed", exc_info=exc, extra={"fields": {"job": self.job.id, "node": node.id if node else None}})
        return self.job.status

    def _single_next(self, graph: WorkflowGraph, node: Node) -> str | None:
        out = graph.outgoing(node.id)
        if not out:
            if node.type in ("end", "review"):
                return None
            raise WorkflowError(f"{NODE_LABELS[node.type]} '{node.title()}' has no outgoing edge")
        return out[0].target

    def execute(self, graph: WorkflowGraph, node: Node, rec: PathNode, depth: int) -> str | None:
        kind = node.type
        if kind == "start":
            return self._single_next(graph, node)
        if kind == "end":
            return None
        if kind == "decision":
            return self._decide(graph, node, rec)
        if kind == "fetch":
            self._fetch(node, rec)
            return self._single_next(graph, node)
        if kind == "review":
            return self._review(graph, node, rec)
        if kind == "sub_workflow":
            self._sub_workflow(node, rec, depth)
            return self._single_next(graph, node)
        if kind == "set_pouch_type":
            self._set_pouch_type(node, rec)
        self._run_steps(NODE_STEPS[kind], node, rec)
        return self._single_next(graph, node)

    # -- node kinds
    def _decide(self, graph: WorkflowGraph, node: Node, rec: PathNode) -> str:
        ctx = decision_context(self.ctx)
        chosen: Edge | None = None
        for edge in graph.outgoing(node.id):
            if not edge.otherwise and edge.when and matches(edge.when, ctx):
                chosen = edge
                break
        if chosen is None:
            chosen = next((e for e in graph.outgoing(node.id) if e.otherwise), None)
        if chosen is None:
            raise WorkflowError(f"no edge of decision '{node.title()}' matched and it has no ELSE edge")
        rec.branch, rec.edge = summarize_edge(chosen), chosen.id
        looked_at = sorted({c.field for e in graph.outgoing(node.id) for g in e.when for c in g.all})
        seen = {f: _lookup(ctx, f) for f in looked_at}
        rec.reason = ", ".join(f"{k.split('.')[-1]} = {v!r}" for k, v in seen.items())[:400]
        self.ctx.log(f"Decision '{node.title()}': {rec.branch}" + (f" ({rec.reason})" if rec.reason else ""), "audit",
                     {"node": node.id, "edge": chosen.id, "values": {k: _jsonable(v) for k, v in seen.items()}})
        return chosen.target

    def _fetch(self, node: Node, rec: PathNode) -> None:
        from app.steps import extract_specs as extract_impl
        from app.workflow.steps.validate import spec_review

        if self.rows.get("extract_specs") is None or self.rows["extract_specs"].status != "done":
            self._run_steps(NODE_STEPS["prepare"], node, rec)  # a FETCH before PREPARE still needs the data
        extracted = self.ctx.output("extract_specs", extract_impl.ExtractSpecsOutput)
        sheet = current_sheet(self.ctx)
        rules = self.ctx.index.validation_rules()
        dictionary = self.ctx.index.fields()
        issues: list[Issue] = []
        got = []
        for f in node.fields:
            column = getattr(sheet.spec_table, f.key, None)
            if column is None:
                continue  # a dictionary key that is not a table column (nothing to check here)
            value, confidence = getattr(column, "value", None), getattr(column, "confidence", 1.0)
            entry = dictionary.get(f.key)
            threshold = f.min_confidence if f.min_confidence is not None else (entry.min_confidence if entry and entry.min_confidence is not None else rules.min_confidence)
            if value in (None, "", []):
                if f.required:
                    issues.append(Issue(code="missing", field=f.key, message=f"Needed by '{node.title()}' but not read from the sheet"))
                continue
            if confidence < threshold:
                issues.append(Issue(code="low_confidence", field=f.key, message=f"Confidence {confidence:.2f} < {threshold} (needed by '{node.title()}')"))
            else:
                got.append(f.key)
        if issues:  # (a plain artwork page gets the details form instead of the specs form)
            raise spec_review(extracted, sheet, issues, f"{len(issues)} field(s) needed by '{node.title()}' are missing or uncertain: "
                              + ", ".join(i.field for i in issues), code="fetch_fields")
        rec.reason = f"{len(got)} field(s) present" + (f": {', '.join(got)}" if got else "")

    def _review(self, graph: WorkflowGraph, node: Node, rec: PathNode) -> str | None:
        out = graph.outgoing(node.id)
        acks = (self.ctx.inputs.get("reviews") or {})
        ack = acks.get(node.id)
        choices = [{"edge": e.id, "label": e.label or e.target} for e in out]
        if ack is None or (len(out) > 1 and ack.get("edge") not in {e.id for e in out}):
            raise NeedsReview("workflow_review", node.message or f"Review: {node.title()}", {
                "form": "workflow_review", "node": node.id, "title": node.title(), "message": node.message, "choices": choices,
            })
        rec.reason = f"continued by {ack.get('by', 'operator')}" + (f": {ack['note']}" if ack.get("note") else "")
        if len(out) > 1:
            edge = next(e for e in out if e.id == ack.get("edge"))
            rec.branch, rec.edge = edge.label or edge.id, edge.id
            return edge.target
        return out[0].target if out else None

    def _sub_workflow(self, node: Node, rec: PathNode, depth: int) -> None:
        if depth >= MAX_SUB_DEPTH:
            raise WorkflowError(f"sub-workflows nested deeper than {MAX_SUB_DEPTH}")
        key = node.workflow or ""
        sub = published_graph(self.session, key, self.ctx.index.version("workflow", key))
        if sub is None or sub.start() is None:
            raise WorkflowError(f"sub-workflow {key!r} is not published")
        rec.reason = f"runs workflow {key}"
        self.walk(sub, sub.start().id, depth + 1, node.id)  # type: ignore[union-attr]

    def _set_pouch_type(self, node: Node, rec: PathNode) -> None:
        from app.workflow.steps.match_pouch_type import Output as MatchOutput

        inputs = dict(self.job.inputs or {})
        if node.pouch_type:
            inputs["workflow_pouch_type"] = node.pouch_type
            rec.reason = f"sets {node.pouch_type}"
        else:
            inputs.pop("workflow_pouch_type", None)
            rec.reason = "automatic (match rules)"
        self.job.inputs = inputs
        row = self.rows.get("match_pouch_type")
        if row is not None and row.status == "done" and row.output and not inputs.get("pouch_type"):
            # A previous walk may have taken another branch: redo the match when this node's choice
            # differs from what was decided then (an operator's pick always stands).
            previous = MatchOutput.model_validate(row.output)
            stale = (node.pouch_type is not None and previous.pouch_type != node.pouch_type) or (node.pouch_type is None and previous.source == "workflow")
            if stale:
                self._reset_from("match_pouch_type")

    def _reset_from(self, step: str) -> None:
        for name in STEPS[STEPS.index(step):]:
            row = self.rows.get(name)
            if row is not None and row.status == "done":
                row.status = "pending"
        self.session.commit()

    # -- engine steps
    def _run_steps(self, names: list[str], node: Node, rec: PathNode) -> None:
        ran = 0
        for name in names:
            for pre in STEPS[:STEPS.index(name) + 1]:
                row = self.rows.get(pre)
                if row is not None and row.status == "done":
                    continue
                self._run_step(pre, rec, implicit=pre not in names)
                ran += 1
        if not ran:
            rec.cached = True
            rec.reason = "already up to date"

    def _run_step(self, name: str, rec: PathNode, implicit: bool) -> None:
        job, session, ctx = self.job, self.session, self.ctx
        self._obey_control()
        ctx.step = name
        row = self.rows.get(name)
        if row is None:
            row = JobStep(job_id=job.id, step=name, status="pending", attempt=0)
            session.add(row)
            self.rows[name] = row
        row.status, row.attempt, row.started_at, row.finished_at, row.error = "running", row.attempt + 1, utcnow(), None, None
        job.current_step, job.updated_at = name, utcnow()
        entry = {"step": name, "implicit": implicit, "status": "running", "seconds": None}
        rec.steps.append(entry)
        self._save_path()
        started = time.perf_counter()
        try:
            output = step_module(name).run(ctx)
        except NeedsReview as exc:
            session.rollback()
            row.status, row.finished_at, row.error = "needs_review", utcnow(), exc.message
            entry.update(status="needs_review", seconds=round(time.perf_counter() - started, 1))
            raise
        except Exception as exc:
            session.rollback()
            row.status, row.finished_at, row.error = "failed", utcnow(), format_exception(exc)
            entry.update(status="failed", seconds=round(time.perf_counter() - started, 1))
            session.commit()
            raise
        row.output = output.model_dump(mode="json")
        row.status, row.finished_at = "done", utcnow()
        entry.update(status="done", seconds=round(time.perf_counter() - started, 1))
        ctx.log(f"{name} done in {time.perf_counter() - started:.1f} s")
        session.commit()


# ---------------------------------------------------------------- data for decisions
def current_sheet(ctx: StepContext):
    """The spec sheet as it stands: validated (with corrections) when validate ran, else the extraction
    with the operator's corrections applied."""
    from app.steps import extract_specs as extract_impl
    from app.workflow.steps.validate import Output as ValidateOutput
    from app.workflow.steps.validate import apply_corrections

    row = ctx.session.scalar(select(JobStep).where(JobStep.job_id == ctx.job.id, JobStep.step == "validate"))
    if row is not None and row.status == "done" and row.output:
        return ValidateOutput.model_validate(row.output).sheet
    extracted = ctx.output("extract_specs", extract_impl.ExtractSpecsOutput)
    sheet, _ = apply_corrections(extracted.sheet, ctx.inputs.get("spec_corrections") or {})
    return sheet


def decision_context(ctx: StepContext) -> dict:
    """What conditions can look at: spec.*, measured.*, panels, linked_codes, job.* and keyline.*."""
    from app.steps import extract_specs as extract_impl

    rows = {r.step: r for r in ctx.session.scalars(select(JobStep).where(JobStep.job_id == ctx.job.id, JobStep.status == "done"))}
    job = ctx.job
    info: dict[str, Any] = {"pouch_type": job.pouch_type, "item_code": job.item_code, "filename": job.file.filename, "client": job.client_name,
                            "kind": job.kind}
    if "extract_specs" in rows:
        sheet = current_sheet(ctx)
        panels = list((rows["link_panels"].output or {}).get("panels", {})) if "link_panels" in rows else None
        out = spec_context(sheet, panels)
        extracted = extract_impl.ExtractSpecsOutput.model_validate(rows["extract_specs"].output)
        info.update(mode=extracted.mode, roll_form=extracted.roll_form, repeats=extracted.repeats, layout=extracted.layout.kind,
                    sheet_panels=len(extracted.layout.panels) if extracted.layout.kind == "multi" else 1, text_source=extracted.text_source,
                    layout_problem=extracted.layout_problem)
    else:
        out = {"spec": {}, "measured": {}, "linked_codes": {}, "panels": []}
    out["job"] = info
    if "resolve_keyline" in rows:
        out["keyline"] = {k: f.get("value") for k, f in (rows["resolve_keyline"].output or {}).get("keyline", {}).get("fields", {}).items()}
    return out


def _lookup(ctx: dict, path: str) -> Any:
    cur: Any = ctx
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def _jsonable(v: Any) -> Any:
    return v if isinstance(v, (str, int, float, bool, type(None), list, dict)) else str(v)
