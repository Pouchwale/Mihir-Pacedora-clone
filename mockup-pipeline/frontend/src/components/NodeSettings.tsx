// Settings panel of the workflow editor: the selected node's fields, or the selected edge's
// label / conditions / ELSE flag.
import type { FetchField, NodeType, WfEdge, WfGraph, WfNode, WorkflowMeta } from "../api";
import RuleGroups from "./RuleGroups";
import { NODE_LABELS, nodeTitle } from "./WorkflowCanvas";

interface NodeProps { graph: WfGraph; node: WfNode; meta: WorkflowMeta; onChange: (n: WfNode) => void; onDelete: () => void }

export function NodeSettings({ graph, node, meta, onChange, onDelete }: NodeProps) {
  const set = (patch: Partial<WfNode>) => onChange({ ...node, ...patch });
  const help = meta.node_types.find((t) => t.type === node.type);
  const out = graph.edges.filter((e) => e.source === node.id);
  return (
    <div className="stack">
      <div>
        <div className="muted small">{NODE_LABELS[node.type]} · <code>{node.id}</code></div>
        <h2 style={{ margin: 0 }}>{nodeTitle(node)}</h2>
        {help && <div className="muted small">{help.help}{help.steps.length > 0 && <> Engine steps: <code>{help.steps.join(", ")}</code>.</>}</div>}
      </div>
      <label className="field">Label (shown on the canvas)<input value={node.label} onChange={(e) => set({ label: e.target.value })} placeholder={NODE_LABELS[node.type]} /></label>
      {node.type === "decision" && (
        <>
          <label className="field">Question<input value={node.question} onChange={(e) => set({ question: e.target.value })} placeholder="e.g. Which sealing type?" /></label>
          <div className="small muted">Edges leave this node in order; the first whose conditions hold is taken, else the ELSE edge. Click an edge to edit its conditions.</div>
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {out.map((e) => <li key={e.id}>{e.otherwise ? <b>ELSE</b> : e.label || "(conditions)"} → {nodeTitle(graph.nodes.find((n) => n.id === e.target)!)}</li>)}
          </ol>
        </>
      )}
      {node.type === "fetch" && <FetchFields fields={node.fields} meta={meta} onChange={(fields) => set({ fields })} />}
      {node.type === "set_pouch_type" && (
        <label className="field">Pouch type
          <select value={node.pouch_type ?? ""} onChange={(e) => set({ pouch_type: e.target.value || null })}>
            <option value="">Automatic: the catalog's match rules decide</option>
            {Object.entries(meta.pouch_types).map(([k, name]) => <option key={k} value={k}>{name} ({k})</option>)}
          </select>
        </label>
      )}
      {node.type === "review" && (
        <>
          <label className="field">Message for the reviewer<textarea rows={3} value={node.message} onChange={(e) => set({ message: e.target.value })} /></label>
          <div className="small muted">{out.length > 1 ? "The reviewer picks one of the labelled outgoing edges." : out.length === 1 ? "The reviewer continues along the single outgoing edge." : "No outgoing edge: the job is done once reviewed."}</div>
        </>
      )}
      {node.type === "sub_workflow" && (
        <label className="field">Published workflow to run here
          <select value={node.workflow ?? ""} onChange={(e) => set({ workflow: e.target.value || null })}>
            <option value="">—</option>
            {Object.entries(meta.workflows).map(([k, name]) => <option key={k} value={k}>{name} ({k})</option>)}
          </select>
        </label>
      )}
      <label className="field">Notes (for other admins)<textarea rows={2} value={node.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
      {node.type !== "start" && <div><button className="danger" onClick={onDelete}>Delete node</button></div>}
    </div>
  );
}

function FetchFields({ fields, meta, onChange }: { fields: FetchField[]; meta: WorkflowMeta; onChange: (f: FetchField[]) => void }) {
  const available = meta.fields.filter((f) => !fields.some((x) => x.key === f.key));
  const update = (i: number, patch: Partial<FetchField>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div className="stack">
      <div className="small muted">Fields this branch needs. A required field that is missing, or one read below its confidence, pauses the job on the specs form.</div>
      <table className="kl-table">
        <thead><tr><th>Field</th><th>Required</th><th>Min. confidence</th><th /></tr></thead>
        <tbody>
          {fields.map((f, i) => (
            <tr key={f.key}>
              <td><code>{f.key}</code></td>
              <td><input type="checkbox" checked={f.required} onChange={(e) => update(i, { required: e.target.checked })} /></td>
              <td className="num"><input type="number" step="0.01" min={0} max={1} value={f.min_confidence ?? ""} placeholder="rules" onChange={(e) => update(i, { min_confidence: e.target.value === "" ? null : Number(e.target.value) })} /></td>
              <td><button className="link" onClick={() => onChange(fields.filter((_, j) => j !== i))}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <select value="" onChange={(e) => e.target.value && onChange([...fields, { key: e.target.value, required: true, min_confidence: null }])}>
        <option value="">+ add a field…</option>
        {available.map((f) => <option key={f.key} value={f.key}>{f.name} ({f.key})</option>)}
      </select>
    </div>
  );
}

interface EdgeProps { graph: WfGraph; edge: WfEdge; meta: WorkflowMeta; onChange: (e: WfEdge) => void; onDelete: () => void }

export function EdgeSettings({ graph, edge, meta, onChange, onDelete }: EdgeProps) {
  const source = graph.nodes.find((n) => n.id === edge.source);
  const target = graph.nodes.find((n) => n.id === edge.target);
  const set = (patch: Partial<WfEdge>) => onChange({ ...edge, ...patch });
  const decision = source?.type === "decision";
  const review = source?.type === "review";
  return (
    <div className="stack">
      <div>
        <div className="muted small">Edge · <code>{edge.id}</code></div>
        <h2 style={{ margin: 0 }}>{source ? nodeTitle(source) : "?"} → {target ? nodeTitle(target) : "?"}</h2>
      </div>
      <label className="field">Label{review ? " (the reviewer's choice)" : ""}<input value={edge.label} onChange={(e) => set({ label: e.target.value })} /></label>
      {decision && (
        <>
          <label className="check"><input type="checkbox" checked={edge.otherwise} onChange={(e) => set({ otherwise: e.target.checked, when: e.target.checked ? [] : edge.when })} /> ELSE edge (taken when no other edge holds)</label>
          {!edge.otherwise && (
            <>
              <label className="field">Order (lower is tried first)<input type="number" value={edge.order} onChange={(e) => set({ order: Number(e.target.value) })} style={{ maxWidth: 120 }} /></label>
              <div><b>Conditions</b> <span className="muted small">taken when any group has all its conditions true</span></div>
              <RuleGroups groups={edge.when} onChange={(when) => set({ when })} fields={meta.condition_fields} emptyText="No conditions yet: add a group." />
            </>
          )}
        </>
      )}
      {!decision && !review && <div className="small muted">Plain edge: the walk always continues here.</div>}
      <div><button className="danger" onClick={onDelete}>Delete edge</button></div>
    </div>
  );
}

export const PALETTE: NodeType[] = ["prepare", "decision", "fetch", "validate", "set_pouch_type", "resolve_keyline", "link_panels", "build_3d", "artwork", "render", "review", "sub_workflow", "end"];
