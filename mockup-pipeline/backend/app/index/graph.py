"""The workflow as data (spec section 4): a directed graph of nodes and edges, edited on a canvas.

A workflow is an index entry of kind `workflow` (versioned like every other entry: publishing writes
a new version and jobs pin the version they ran). Drafts live apart in `workflow_drafts` until
published, so the running system never sees a half-edited graph.

Node types and what they do when a job walks the graph (app.workflow.runner):

  start            the uploaded PDF
  prepare          ingest + artwork trim + spec / dimension extraction (engine steps)
  decision         reads the extracted fields and follows the first edge whose conditions hold;
                   every decision needs one ELSE edge (`otherwise`)
  fetch            the fields this branch needs: a missing or weak one pauses for review
  validate         size rules and cross-checks (engine step)
  set_pouch_type   assigns a pouch type from the catalog (or "automatic": the match rules decide)
  resolve_keyline  keyline template + precedence (engine step)
  link_panels      required panels from remarks codes / the sheet (engine step)
  build_3d         geometry spec (engine step)
  artwork          finished textures for every panel (engine step)
  render           output preset renders + export (engine steps)
  review           pauses for a person with a message; they continue, or pick one of several
                   labelled outgoing edges
  sub_workflow     runs another published workflow, then continues here
  end              results

A node that stands for engine steps runs those steps and, first, any earlier step in the engine
order that has not run yet, so the admin may arrange the executing nodes in any order that reads
well and the outputs stay consistent.
"""

from collections import deque
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from app.index.conditions import RuleGroup

NodeType = Literal[
    "start", "prepare", "decision", "fetch", "validate", "set_pouch_type", "resolve_keyline",
    "link_panels", "build_3d", "artwork", "render", "review", "sub_workflow", "end",
]

# node type -> engine steps it stands for (app.workflow.engine.STEPS order)
NODE_STEPS: dict[str, list[str]] = {
    "start": [],
    "prepare": ["ingest", "trim_artwork", "extract_specs"],
    "decision": [],
    "fetch": [],
    "validate": ["validate"],
    "set_pouch_type": ["match_pouch_type"],
    "resolve_keyline": ["resolve_keyline"],
    "link_panels": ["link_panels"],
    "build_3d": ["build_geometry"],
    "artwork": ["texture"],
    "render": ["render", "export"],
    "review": [],
    "sub_workflow": [],
    "end": [],
}

NODE_LABELS: dict[str, str] = {
    "start": "Start", "prepare": "Prepare", "decision": "Decision", "fetch": "Fetch fields", "validate": "Validate",
    "set_pouch_type": "Set pouch type", "resolve_keyline": "Resolve keyline", "link_panels": "Link panels",
    "build_3d": "Build 3D", "artwork": "Artwork", "render": "Render", "review": "Review", "sub_workflow": "Sub-workflow", "end": "End",
}

NODE_HELP: dict[str, str] = {
    "start": "Where every job begins: the uploaded PDF.",
    "prepare": "Checks the PDF, separates artwork from the technical drawing and reads the spec table and dimension lines.",
    "decision": "Branches on the extracted fields. Edges are tried in order; the ELSE edge is taken when no condition holds.",
    "fetch": "Names the fields this branch needs. A required field that is missing, or one read below its confidence, pauses the job for review.",
    "validate": "Size rules and cross-checks (TrimBox vs size, dieline vs table, standard sizes).",
    "set_pouch_type": "Assigns a pouch type. 'Automatic' lets the catalog's match rules decide.",
    "resolve_keyline": "Resolves every keyline value (item > client > pouch type rule > dieline > table > default).",
    "link_panels": "Finds the back, gusset and side panels: on the sheet, in the file registry by remarks code, or asks the operator.",
    "build_3d": "Builds the geometry specification and picks the output preset and materials.",
    "artwork": "Cuts the bleed and produces the finished texture of every panel.",
    "render": "Renders the output preset's views, the GLB and the turntable, and exports the files.",
    "review": "Pauses for a person. With several labelled outgoing edges the reviewer chooses the branch.",
    "sub_workflow": "Runs another published workflow here, then continues.",
    "end": "The job is done; results are available.",
}


class FetchField(BaseModel):
    key: str = Field(description="field dictionary key, e.g. pouch_height_mm")
    required: bool = True
    min_confidence: float | None = Field(None, ge=0, le=1, description="overrides the field's own threshold")


class Position(BaseModel):
    x: float = 0
    y: float = 0


class Node(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_\-]{0,60}$")
    type: NodeType
    label: str = ""
    position: Position = Position()
    # decision
    question: str = ""
    # fetch
    fields: list[FetchField] = []
    # set_pouch_type (None = automatic: the match rules decide)
    pouch_type: str | None = None
    # review
    message: str = ""
    # sub_workflow
    workflow: str | None = None
    notes: str = ""

    def title(self) -> str:
        return self.label or self.question or NODE_LABELS[self.type]


class Edge(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_\-]{0,60}$")
    source: str
    target: str
    label: str = ""
    when: list[RuleGroup] = Field([], description="decision edges: taken when ANY group holds (ALL conditions of a group)")
    otherwise: bool = Field(False, description="the ELSE edge of a decision: taken when no other edge holds")
    order: int = Field(0, description="decision edges are tried in this order")


class WorkflowGraph(BaseModel):
    name: str
    description: str = ""
    nodes: list[Node] = Field(min_length=1)
    edges: list[Edge] = []

    @model_validator(mode="after")
    def _ids_unique_and_placed(self) -> "WorkflowGraph":
        ids = [n.id for n in self.nodes]
        if len(ids) != len(set(ids)):
            raise ValueError("node ids must be unique")
        eids = [e.id for e in self.edges]
        if len(eids) != len(set(eids)):
            raise ValueError("edge ids must be unique")
        # A graph written by hand (seed YAML, import) carries no positions: lay it out once.
        if len(self.nodes) > 1 and all(n.position.x == 0 and n.position.y == 0 for n in self.nodes):
            for n, placed in zip(self.nodes, auto_layout(self).nodes):
                n.position = placed.position
        return self

    # -- lookups
    def node(self, node_id: str) -> Node | None:
        return next((n for n in self.nodes if n.id == node_id), None)

    def start(self) -> Node | None:
        return next((n for n in self.nodes if n.type == "start"), None)

    def outgoing(self, node_id: str) -> list[Edge]:
        return sorted((e for e in self.edges if e.source == node_id), key=lambda e: (e.otherwise, e.order, e.id))

    def incoming(self, node_id: str) -> list[Edge]:
        return [e for e in self.edges if e.target == node_id]

    def reachable(self) -> set[str]:
        start = self.start()
        if start is None:
            return set()
        ids = {n.id for n in self.nodes}
        seen: set[str] = set()
        queue = deque([start.id])
        while queue:
            cur = queue.popleft()
            if cur in seen:
                continue
            seen.add(cur)
            queue.extend(e.target for e in self.outgoing(cur) if e.target in ids)
        return seen

    def downstream(self, node_id: str) -> set[str]:
        """Every node reachable from `node_id` (itself included)."""
        ids = {n.id for n in self.nodes}
        seen: set[str] = set()
        queue = deque([node_id])
        while queue:
            cur = queue.popleft()
            if cur in seen:
                continue
            seen.add(cur)
            queue.extend(e.target for e in self.outgoing(cur) if e.target in ids)
        return seen


def validate_graph(graph: WorkflowGraph, pouch_types: set[str], fields: set[str], workflows: set[str], self_key: str | None = None) -> list[str]:
    """Publish checks (spec 4.4). Returns every problem found; empty = publishable."""
    problems: list[str] = []
    ids = {n.id for n in graph.nodes}
    starts = [n for n in graph.nodes if n.type == "start"]
    if len(starts) != 1:
        problems.append(f"exactly one START node is required (found {len(starts)})")
    for e in graph.edges:
        if e.source not in ids or e.target not in ids:
            problems.append(f"edge {e.id}: connects unknown nodes ({e.source} -> {e.target})")
    for n in graph.nodes:
        out = graph.outgoing(n.id)
        label = f"{NODE_LABELS[n.type]} '{n.title()}'"
        if n.type == "end":
            if out:
                problems.append(f"{label}: END cannot have outgoing edges")
            continue
        if n.type == "decision":
            if not any(e.otherwise for e in out):
                problems.append(f"{label}: every DECISION needs an ELSE edge")
            if sum(1 for e in out if e.otherwise) > 1:
                problems.append(f"{label}: more than one ELSE edge")
            if not any(not e.otherwise for e in out):
                problems.append(f"{label}: needs at least one condition edge besides ELSE")
            for e in out:
                if not e.otherwise and not e.when:
                    problems.append(f"{label}: edge '{e.label or e.id}' has no conditions and is not the ELSE edge")
        elif n.type == "review":
            if len(out) > 1 and any(not e.label.strip() for e in out):
                problems.append(f"{label}: a REVIEW with several outgoing edges needs a label on each (the reviewer's choices)")
        else:
            if len(out) == 0:
                problems.append(f"{label}: has no outgoing edge (every path must end in END or REVIEW)")
            if len(out) > 1:
                problems.append(f"{label}: has {len(out)} outgoing edges; only DECISION and REVIEW branch")
        if n.type == "set_pouch_type" and n.pouch_type is not None and n.pouch_type not in pouch_types:
            problems.append(f"{label}: pouch type {n.pouch_type!r} is not in the catalog")
        if n.type == "fetch":
            for f in n.fields:
                if f.key not in fields:
                    problems.append(f"{label}: field {f.key!r} is not in the field dictionary")
            if not n.fields:
                problems.append(f"{label}: lists no fields")
        if n.type == "sub_workflow":
            if n.workflow not in workflows:
                problems.append(f"{label}: workflow {n.workflow!r} is not published")
            elif self_key and n.workflow == self_key:
                problems.append(f"{label}: a workflow cannot call itself")
        if n.type == "start" and graph.incoming(n.id):
            problems.append(f"{label}: START cannot have incoming edges")
    if starts:
        seen = graph.reachable()
        unreachable = [graph.node(i).title() for i in ids - seen]  # type: ignore[union-attr]
        if unreachable:
            problems.append("unreachable node(s): " + ", ".join(sorted(unreachable)))
        cycle = _find_cycle(graph, starts[0].id)
        if cycle:
            problems.append("the graph has a cycle: " + " -> ".join(cycle))
    return problems


def _find_cycle(graph: WorkflowGraph, start: str) -> list[str] | None:
    state: dict[str, int] = {}
    parent: dict[str, str] = {}

    def visit(node: str) -> list[str] | None:
        state[node] = 1
        for e in graph.outgoing(node):
            nxt = e.target
            if state.get(nxt) == 1:
                cycle, cur = [nxt], node
                while cur != nxt and cur in parent:
                    cycle.append(cur)
                    cur = parent[cur]
                cycle.append(nxt)
                return list(reversed(cycle))
            if state.get(nxt) is None:
                parent[nxt] = node
                found = visit(nxt)
                if found:
                    return found
        state[node] = 2
        return None

    return visit(start)


def auto_layout(graph: WorkflowGraph, dx: float = 250, dy: float = 92) -> WorkflowGraph:
    """Layered positions from START, left to right; each column is centred on the spine, so branches
    fan out above and below the main flow instead of hanging off its top row."""
    start = graph.start()
    if start is None:
        return graph
    ids = {n.id for n in graph.nodes}
    depth: dict[str, int] = {start.id: 0}
    order: list[str] = []
    queue = deque([start.id])
    guard = 0
    while queue and guard < 10_000:
        guard += 1
        cur = queue.popleft()
        if cur not in order:
            order.append(cur)
        for e in graph.outgoing(cur):
            if e.target not in ids:
                continue
            d = depth[cur] + 1
            if e.target not in depth or depth[e.target] < d:
                if d > len(ids):  # a cycle: stop deepening
                    continue
                depth[e.target] = d
                queue.append(e.target)
    columns: dict[int, list[str]] = {}
    for node_id in order:
        columns.setdefault(depth[node_id], []).append(node_id)
    tail = max(depth.values(), default=0) + 1
    for n in graph.nodes:  # unreachable nodes go in a column of their own
        if n.id not in depth:
            columns.setdefault(tail, []).append(n.id)
    positions: dict[str, Position] = {}
    for d, ids in columns.items():
        for i, node_id in enumerate(ids):
            positions[node_id] = Position(x=d * dx, y=round((i - (len(ids) - 1) / 2) * dy, 1))
    nodes = [n.model_copy(update={"position": positions[n.id]}) for n in graph.nodes]
    return graph.model_copy(update={"nodes": nodes})


def summarize_edge(e: Edge) -> str:
    if e.otherwise:
        return "ELSE"
    if e.label:
        return e.label
    parts = []
    for g in e.when:
        parts.append(" and ".join(f"{c.field.split('.')[-1]} {c.op} {c.value if c.value is not None else ''}".strip() for c in g.all))
    return " or ".join(parts)


def linear_graph(name: str = "Linear (built in)") -> WorkflowGraph:
    """The engine's fixed order as a graph: what runs when no workflow is published yet."""
    types = ["start", "prepare", "validate", "set_pouch_type", "resolve_keyline", "link_panels", "build_3d", "artwork", "render", "end"]
    nodes = [Node(id=t, type=t, position=Position(x=i * 250, y=0)) for i, t in enumerate(types)]  # type: ignore[arg-type]
    edges = [Edge(id=f"e{i}", source=a.id, target=b.id) for i, (a, b) in enumerate(zip(nodes, nodes[1:]))]
    return WorkflowGraph(name=name, description="Every step in the engine's order; pouch type by match rules.", nodes=nodes, edges=edges)


def graph_from(data: dict[str, Any]) -> WorkflowGraph:
    return WorkflowGraph.model_validate(data)
