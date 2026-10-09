// The workflow canvas (React Flow): the same component draws the editor (nodes can be moved,
// connected and deleted) and a job's live view (read-only, nodes coloured by the path the job took:
// green passed, amber paused for review, red failed, blue running, grey not visited).
import {
  addEdge, applyEdgeChanges, applyNodeChanges, Background, Controls, Handle, MarkerType, Panel, Position, ReactFlow,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps, type NodeTypes, type ReactFlowInstance, type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NodeType, PathRecord, WfEdge, WfGraph, WfNode } from "../api";

export const NODE_LABELS: Record<NodeType, string> = {
  start: "Start", prepare: "Prepare", decision: "Decision", fetch: "Fetch fields", validate: "Validate", set_pouch_type: "Set pouch type",
  resolve_keyline: "Resolve keyline", link_panels: "Link panels", build_3d: "Build 3D", artwork: "Artwork", render: "Render",
  review: "Review", sub_workflow: "Sub-workflow", end: "End",
};
const ICONS: Record<NodeType, string> = {
  start: "▶", prepare: "⚙", decision: "◆", fetch: "⤓", validate: "✓", set_pouch_type: "▣", resolve_keyline: "⌗", link_panels: "⧉",
  build_3d: "⬡", artwork: "▦", render: "◉", review: "👁", sub_workflow: "⇄", end: "■",
};

export type NodeStatus = PathRecord["status"] | "idle";
type WfNodeData = { node: WfNode; status: NodeStatus; current: boolean; record?: PathRecord; readOnly: boolean };
type RfNode = Node<WfNodeData, "wf">;

export function nodeTitle(n: WfNode): string {
  return n.label || n.question || NODE_LABELS[n.type];
}

export function edgeCaption(e: WfEdge): string {
  if (e.otherwise) return "ELSE";
  if (e.label) return e.label;
  return e.when.map((g) => g.all.map((c) => `${c.field.split(".").pop()} ${c.op} ${c.value === undefined || c.value === null ? "" : Array.isArray(c.value) ? c.value.join("|") : String(c.value)}`.trim()).join(" and ")).join(" or ");
}

function subtitle(n: WfNode): string {
  switch (n.type) {
    case "set_pouch_type": return n.pouch_type ?? "automatic (match rules)";
    case "fetch": return n.fields.map((f) => f.key + (f.required ? "" : "?")).join(", ") || "no fields";
    case "sub_workflow": return n.workflow ?? "no workflow";
    case "review": return n.message ? n.message.slice(0, 60) : "";
    case "decision": return n.label && n.question ? n.question : "";
    default: return "";
  }
}

const WfNodeView = memo(function WfNodeView({ data, selected }: NodeProps<RfNode>) {
  const { node, status, current, record } = data;
  const isDecision = node.type === "decision";
  const cls = `wf-node type-${node.type} status-${status}${current ? " current" : ""}${selected ? " selected" : ""}${isDecision ? " decision" : ""}`;
  return (
    <div className={cls} title={record?.reason || undefined}>
      {node.type !== "start" && <Handle type="target" position={Position.Left} />}
      <div className="wf-node-head"><span className="wf-icon">{ICONS[node.type]}</span><span className="wf-kind">{NODE_LABELS[node.type]}</span>
        {status !== "idle" && <span className={`wf-dot ${status}`} />}</div>
      <div className="wf-title">{nodeTitle(node)}</div>
      {subtitle(node) && <div className="wf-sub">{subtitle(node)}</div>}
      {record?.branch && <div className="wf-branch">→ {record.branch}</div>}
      {record?.cached && <div className="wf-sub muted">up to date</div>}
      {node.type !== "end" && <Handle type="source" position={Position.Right} />}
    </div>
  );
});

const nodeTypes: NodeTypes = { wf: WfNodeView as never };

const COLOURS: Record<NodeStatus, string> = { passed: "var(--ok)", review: "var(--warn)", failed: "var(--bad)", running: "var(--accent)", idle: "var(--muted)" };

interface Props {
  graph: WfGraph;
  onChange?: (g: WfGraph) => void; // absent = read-only
  path?: PathRecord[];
  currentNode?: string | null;
  selectedNode?: string | null;
  selectedEdge?: string | null;
  onSelectNode?: (id: string | null) => void;
  onSelectEdge?: (id: string | null) => void;
  height?: number | string;
}

export default function WorkflowCanvas({ graph, onChange, path = [], currentNode, selectedNode, selectedEdge, onSelectNode, onSelectEdge, height = 560 }: Props) {
  const readOnly = !onChange;
  // Full screen: a long flowchart needs the whole window to be read (the viewer's way: fill the window,
  // and go truly full screen where the browser allows); the graph is fitted on the way in and out.
  const box = useRef<HTMLDivElement>(null);
  const rf = useRef<ReactFlowInstance<RfNode, Edge> | null>(null);
  const [full, setFull] = useState(false);
  const toggled = useRef(false);
  useEffect(() => {
    const t = toggled.current ? window.setTimeout(() => rf.current?.fitView({ padding: 0.06, maxZoom: 1 }), 80) : undefined;
    toggled.current = true;
    const onFull = () => { if (!document.fullscreenElement) setFull(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    document.addEventListener("fullscreenchange", onFull);
    if (full) window.addEventListener("keydown", onKey);
    return () => { window.clearTimeout(t); document.removeEventListener("fullscreenchange", onFull); window.removeEventListener("keydown", onKey); };
  }, [full]);
  const toggleFull = () => {
    if (full) {
      setFull(false);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    } else {
      setFull(true);
      box.current?.requestFullscreen?.().catch(() => undefined);
    }
  };
  const records = useMemo(() => {
    const m = new Map<string, PathRecord>();
    for (const r of path) if (!r.parent) m.set(r.node, r); // this graph's own nodes (sub-workflow nodes have a parent); the latest record wins
    return m;
  }, [path]);

  const nodes: RfNode[] = useMemo(() => graph.nodes.map((n) => {
    const rec = records.get(n.id);
    const status: NodeStatus = rec ? rec.status : "idle";
    return { id: n.id, type: "wf", position: n.position, selected: n.id === selectedNode, draggable: !readOnly, connectable: !readOnly, deletable: !readOnly && n.type !== "start",
      data: { node: n, status, current: n.id === currentNode, record: rec, readOnly } };
  }), [graph.nodes, records, currentNode, selectedNode, readOnly]);

  const edges: Edge[] = useMemo(() => graph.edges.map((e) => {
    const from = records.get(e.source);
    const to = records.get(e.target);
    // an edge was taken when the walk left its source along it (decision / review: the recorded edge; others: the target was visited)
    const taken = !!from && (from.edge ? from.edge === e.id : !!to);
    const colour = taken ? COLOURS[to?.status ?? "passed"] : "var(--muted)";
    return {
      id: e.id, source: e.source, target: e.target, type: "smoothstep", label: edgeCaption(e) || undefined, selected: e.id === selectedEdge,
      deletable: !readOnly, animated: taken && to?.status === "running",
      style: { stroke: colour, strokeWidth: taken ? 2.5 : 1.5, strokeDasharray: e.otherwise ? "6 4" : undefined, opacity: path.length && !taken ? 0.45 : 1 },
      labelStyle: { fill: "var(--text)", fontSize: 11 }, labelBgStyle: { fill: "var(--panel)", fillOpacity: 0.9 }, labelBgPadding: [4, 2], labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, color: colour },
      data: { edge: e },
    };
  }), [graph.edges, records, selectedEdge, readOnly, path.length]);

  const onNodesChange = useCallback((changes: NodeChange<RfNode>[]) => {
    if (!onChange) return;
    const next = applyNodeChanges(changes, nodes);
    const kept = new Set(next.map((n) => n.id));
    const positions = new Map(next.map((n) => [n.id, n.position]));
    const removed = graph.nodes.some((n) => !kept.has(n.id));
    const moved = graph.nodes.some((n) => { const p = positions.get(n.id); return p && (p.x !== n.position.x || p.y !== n.position.y); });
    if (!removed && !moved) return;
    onChange({
      ...graph,
      nodes: graph.nodes.filter((n) => kept.has(n.id)).map((n) => ({ ...n, position: positions.get(n.id) ?? n.position })),
      edges: graph.edges.filter((e) => kept.has(e.source) && kept.has(e.target)),
    });
  }, [graph, nodes, onChange]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (!onChange) return;
    const next = applyEdgeChanges(changes, edges);
    const kept = new Set(next.map((e) => e.id));
    if (kept.size === graph.edges.length) return;
    onChange({ ...graph, edges: graph.edges.filter((e) => kept.has(e.id)) });
  }, [graph, edges, onChange]);

  const onConnect = useCallback((c: Connection) => {
    if (!onChange || !c.source || !c.target || c.source === c.target) return;
    if (graph.edges.some((e) => e.source === c.source && e.target === c.target)) return;
    const source = graph.nodes.find((n) => n.id === c.source);
    const branching = source?.type === "decision" || source?.type === "review";
    if (!branching && graph.edges.some((e) => e.source === c.source)) return; // only DECISION and REVIEW branch
    const id = nextId("e", graph.edges.map((e) => e.id));
    const siblings = graph.edges.filter((e) => e.source === c.source);
    const edge: WfEdge = {
      id, source: c.source, target: c.target, label: "", when: [], order: siblings.length + 1,
      // a decision's first edge is its ELSE edge; later ones carry conditions
      otherwise: source?.type === "decision" && !siblings.some((e) => e.otherwise),
    };
    addEdge(c, edges); // keeps React Flow's internal bookkeeping consistent
    onChange({ ...graph, edges: [...graph.edges, edge] });
    onSelectEdge?.(id);
  }, [graph, edges, onChange, onSelectEdge]);

  // A wide graph must stay readable: start at a legible zoom, anchored at START, rather than
  // shrinking the whole flowchart to fit (the fit button in the controls still does that).
  const initial: Viewport = useMemo(() => {
    const xs = graph.nodes.map((n) => n.position.x);
    const ys = graph.nodes.map((n) => n.position.y);
    const minX = Math.min(0, ...xs), minY = Math.min(0, ...ys), maxY = Math.max(80, ...ys) + 80;
    const zoom = 0.8;
    const h = typeof height === "number" ? height : 560;
    return { x: 24 - minX * zoom, y: Math.max(24 - minY * zoom, h / 2 - ((minY + maxY) / 2) * zoom), zoom };
  }, [graph.nodes, height]);
  const wide = useMemo(() => Math.max(0, ...graph.nodes.map((n) => n.position.x)) > 1100, [graph.nodes]);

  return (
    <div ref={box} className={`wf-canvas${full ? " wf-full" : ""}`} style={full ? undefined : { height }}>
      <ReactFlow
        onInit={(i) => { rf.current = i; }}
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
        onNodeClick={(_, n) => { onSelectEdge?.(null); onSelectNode?.(n.id); }}
        onEdgeClick={(_, e) => { onSelectNode?.(null); onSelectEdge?.(e.id); }}
        onPaneClick={() => { onSelectNode?.(null); onSelectEdge?.(null); }}
        nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable
        fitView={!wide} fitViewOptions={{ padding: 0.2, maxZoom: 1 }} defaultViewport={initial}
        minZoom={0.15} maxZoom={1.6} proOptions={{ hideAttribution: true }}
        zoomOnScroll={false} preventScrolling={false} /* the wheel scrolls the page; zoom with ctrl+wheel, a pinch or the buttons */
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
      >
        <Background gap={18} size={1} />
        <Controls showInteractive={false} />
        <Panel position="top-right"><button className="small" onClick={toggleFull} title="Show the whole workflow (Esc leaves)">{full ? "✕ Exit full screen" : "⛶ Full screen"}</button></Panel>
      </ReactFlow>
    </div>
  );
}

export function nextId(prefix: string, taken: string[]): string {
  const set = new Set(taken);
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!set.has(id)) return id;
  }
}
