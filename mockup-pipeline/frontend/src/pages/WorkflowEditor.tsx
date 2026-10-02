// Visual workflow editor (spec 4): canvas + node library + settings panel, draft vs published,
// validation, publishing with a reason, versions, and test mode (run a PDF through the draft and
// watch the path light up).
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, emptyNode, type JobWorkflow, type NodeType, type PathRecord, type WfGraph, type WorkflowMeta, type WorkflowOut } from "../api";
import { useSession } from "../App";
import History from "../components/History";
import { EdgeSettings, NodeSettings, PALETTE } from "../components/NodeSettings";
import WorkflowCanvas, { NODE_LABELS, nextId, nodeTitle } from "../components/WorkflowCanvas";
import { formatTime } from "../util";

type Dict = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Side = "settings" | "test" | "versions";

const starter = (name: string): WfGraph => {
  const types: NodeType[] = ["start", "prepare", "validate", "set_pouch_type", "resolve_keyline", "link_panels", "build_3d", "artwork", "render", "end"];
  const nodes = types.map((t, i) => emptyNode(t, t, i * 250, 0));
  return { name, description: "", nodes, edges: nodes.slice(1).map((n, i) => ({ id: `e${i + 1}`, source: nodes[i].id, target: n.id, label: "", when: [], otherwise: false, order: 0 })) };
};

export default function WorkflowEditor() {
  const { key = "default" } = useParams();
  const { isAdmin } = useSession();
  const navigate = useNavigate();
  const [meta, setMeta] = useState<WorkflowMeta | null>(null);
  const [info, setInfo] = useState<WorkflowOut | null>(null);
  const [graph, setGraph] = useState<WfGraph | null>(null);
  const [saved, setSaved] = useState(""); // JSON of the last saved draft (or published graph)
  const [problems, setProblems] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("settings");
  const [busy, setBusy] = useState(false);
  const [testJob, setTestJob] = useState<Dict | null>(null);
  const [testing, setTesting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [m, w] = await Promise.all([api.get<WorkflowMeta>("/api/workflows/meta"), api.get<WorkflowOut>(`/api/workflows/${key}`).catch((e) => { if (e instanceof ApiError && e.status === 404) return null; throw e; })]);
    setMeta(m);
    if (w === null) {
      const g = starter(key);
      setInfo({ key, name: key, archived: false, problems: [], published: null, draft: null });
      setGraph(g);
      setSaved("");
      return;
    }
    setInfo(w);
    const g = w.draft?.graph ?? w.published?.graph ?? starter(key);
    setGraph(g);
    setSaved(JSON.stringify(g));
    setProblems(w.problems);
  }, [key]);

  useEffect(() => { load().catch((e) => setError(String(e.message ?? e))); }, [load]);

  const dirty = !!graph && JSON.stringify(graph) !== saved;
  const change = (g: WfGraph) => { setGraph(g); setNotice(""); };

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      if (ok) setNotice(ok);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = () => graph && run(async () => {
    const w = await api.put<WorkflowOut>(`/api/workflows/${key}/draft`, { graph });
    setInfo(w);
    setSaved(JSON.stringify(w.draft?.graph ?? graph));
    if (w.draft) setGraph(w.draft.graph);
    setProblems(w.problems);
  }, "Draft saved.");
  const validate = () => graph && run(async () => {
    const r = await api.post<{ problems: string[] }>(`/api/workflows/${key}/validate`, { graph });
    setProblems(r.problems);
    setNotice(r.problems.length ? "" : "The graph is valid and can be published.");
  });
  const layout = () => graph && run(async () => {
    const r = await api.post<{ graph: WfGraph }>(`/api/workflows/${key}/layout`, { graph });
    change(r.graph);
  });
  const publish = () => graph && run(async () => {
    const reason = window.prompt("Reason for publishing this version (kept in the history)");
    if (!reason?.trim()) return;
    const w = await api.post<WorkflowOut>(`/api/workflows/${key}/publish`, { reason, graph });
    setInfo(w);
    setGraph(w.published!.graph);
    setSaved(JSON.stringify(w.published!.graph));
    setProblems([]);
    setNotice(`Published as version ${w.published!.version}. New jobs use it from now on.`);
  });
  const discard = () => run(async () => {
    if (!window.confirm("Discard the draft and go back to the published graph?")) return;
    const w = await api.del<WorkflowOut>(`/api/workflows/${key}/draft`, {});
    setInfo(w);
    const g = w.published?.graph ?? starter(key);
    setGraph(g);
    setSaved(JSON.stringify(g));
    setProblems(w.problems);
  }, "Draft discarded.");

  const addNode = (type: NodeType) => {
    if (!graph) return;
    const id = nextId(type + "_", graph.nodes.map((n) => n.id));
    const right = Math.max(0, ...graph.nodes.map((n) => n.position.x));
    const n = emptyNode(id, type, right + 250, 120 * (graph.nodes.filter((x) => x.position.x === right).length % 4));
    change({ ...graph, nodes: [...graph.nodes, n] });
    setSelEdge(null);
    setSelNode(id);
    setSide("settings");
  };

  // test mode: run a PDF through the current graph and follow the job
  const startTest = (file: File) => {
    if (!graph) return;
    const form = new FormData();
    form.append("file", file);
    form.append("graph", JSON.stringify(graph));
    setTesting(true);
    setTestJob(null);
    setError("");
    fetch(`/api/workflows/${key}/test`, { method: "POST", body: form, headers: { "X-Requested-With": "fetch" }, credentials: "same-origin" })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : (body.detail?.problems ?? []).join("; ") || JSON.stringify(body.detail));
        const poll = async () => {
          const d = await api.get<Dict>(`/api/jobs/${body.job_id}`);
          setTestJob(d);
          if (["QUEUED", "RUNNING"].includes(d.job.status)) setTimeout(poll, 2000);
          else setTesting(false);
        };
        poll();
      })
      .catch((e) => { setError(String(e.message ?? e)); setTesting(false); });
  };

  if (error && !graph) return <div className="msg bad">{error}</div>;
  if (!graph || !meta || !info) return <div className="muted">Loading…</div>;
  const node = selNode ? graph.nodes.find((n) => n.id === selNode) : undefined;
  const edge = selEdge ? graph.edges.find((e) => e.id === selEdge) : undefined;
  const wf: JobWorkflow | undefined = testJob?.workflow;
  const path: PathRecord[] = testJob ? wf?.path ?? [] : [];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="muted small"><Link to="/workflows">Workflows</Link> / <code>{key}</code></div>
          <h1 className="row" style={{ gap: 8 }}>
            <input className="wf-name" value={graph.name} onChange={(e) => change({ ...graph, name: e.target.value })} disabled={!isAdmin} aria-label="workflow name" />
            {info.published ? <span className="badge ok">published v{info.published.version}</span> : <span className="badge warn">never published</span>}
            {(info.draft || dirty) && <span className="badge accent">{dirty ? "unsaved changes" : "draft"}</span>}
          </h1>
          <div className="muted small">
            {info.published && <>v{info.published.version} by {info.published.author}, {formatTime(info.published.created_at)} · “{info.published.reason}”</>}
            {info.draft && <> · draft by {info.draft.updated_by}, {formatTime(info.draft.updated_at)}</>}
          </div>
        </div>
        <div className="row">
          <button onClick={layout} disabled={busy}>Auto-layout</button>
          <button onClick={validate} disabled={busy}>Validate</button>
          {isAdmin && <button onClick={saveDraft} disabled={busy || !dirty}>Save draft</button>}
          {isAdmin && info.draft && <button onClick={discard} disabled={busy}>Discard draft</button>}
          {isAdmin && <button className="primary" onClick={publish} disabled={busy}>Publish…</button>}
        </div>
      </div>
      <input className="wf-desc" placeholder="What this workflow is for (shown in the list)" value={graph.description} onChange={(e) => change({ ...graph, description: e.target.value })} disabled={!isAdmin} />
      {problems.length > 0 && <div className="msg bad" style={{ margin: "10px 0" }}>Not publishable yet:<ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
      {notice && <div className="msg ok" style={{ margin: "10px 0" }}>{notice}</div>}
      {error && <div className="msg bad" style={{ margin: "10px 0" }}>{error}</div>}

      <div className="wf-layout">
        <aside className="card wf-palette">
          <h2>Node library</h2>
          <div className="muted small" style={{ marginBottom: 8 }}>Click to add. Drag a node's right handle to another node to connect them. Delete with Backspace.</div>
          {PALETTE.map((t) => (
            <button key={t} className="wf-palette-item" onClick={() => addNode(t)} disabled={!isAdmin} title={meta.node_types.find((x) => x.type === t)?.help}>
              <span className={`wf-swatch type-${t}`} />{NODE_LABELS[t]}
            </button>
          ))}
          <div className="muted small" style={{ marginTop: 10 }}>Legend: <span className="wf-dot passed" /> passed <span className="wf-dot review" /> review <span className="wf-dot failed" /> failed <span className="wf-dot running" /> running</div>
        </aside>

        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <WorkflowCanvas graph={graph} onChange={isAdmin ? change : undefined} path={path} currentNode={testJob?.job?.current_node}
            selectedNode={selNode} selectedEdge={selEdge} onSelectNode={(id) => { setSelNode(id); if (id) setSide("settings"); }} onSelectEdge={(id) => { setSelEdge(id); if (id) setSide("settings"); }} height={620} />
        </div>

        <aside className="card wf-side">
          <div className="tabs" style={{ marginBottom: 10 }}>
            {(["settings", "test", "versions"] as Side[]).map((s) => <button key={s} className={side === s ? "on" : ""} onClick={() => setSide(s)}>{{ settings: "Settings", test: "Test mode", versions: "Versions" }[s]}</button>)}
          </div>
          {side === "settings" && (
            <fieldset disabled={!isAdmin} style={{ border: "none", padding: 0, margin: 0, minWidth: 0 }}>
              {node && <NodeSettings graph={graph} node={node} meta={meta}
                onChange={(n) => change({ ...graph, nodes: graph.nodes.map((x) => (x.id === n.id ? n : x)) })}
                onDelete={() => { change({ ...graph, nodes: graph.nodes.filter((x) => x.id !== node.id), edges: graph.edges.filter((e) => e.source !== node.id && e.target !== node.id) }); setSelNode(null); }} />}
              {edge && <EdgeSettings graph={graph} edge={edge} meta={meta}
                onChange={(e) => change({ ...graph, edges: graph.edges.map((x) => (x.id === e.id ? e : x)) })}
                onDelete={() => { change({ ...graph, edges: graph.edges.filter((x) => x.id !== edge.id) }); setSelEdge(null); }} />}
              {!node && !edge && (
                <div className="stack">
                  <h2>Workflow</h2>
                  <div className="muted small">Select a node or an edge to edit it. Jobs walk the published version; save a draft while you work and publish when it validates.</div>
                  <div className="small">
                    <b>{graph.nodes.length}</b> nodes · <b>{graph.edges.length}</b> edges · {graph.nodes.filter((n) => n.type === "decision").length} decisions · {graph.nodes.filter((n) => n.type === "review").length} reviews
                  </div>
                  {testJob && <TestSummary job={testJob} graph={graph} onPick={(id) => { setSelNode(id); }} />}
                </div>
              )}
              {node && testJob && <NodeRun job={testJob} nodeId={node.id} />}
            </fieldset>
          )}
          {side === "test" && (
            <div className="stack">
              <h2>Test mode</h2>
              <div className="muted small">Runs a PDF through the graph as it is on the canvas (saved or not). The path lights up as the job walks it. Test runs stay out of the jobs list.</div>
              <input ref={fileInput} type="file" accept=".pdf" hidden onChange={(e) => e.target.files?.[0] && startTest(e.target.files[0])} />
              <button className="primary" disabled={testing} onClick={() => fileInput.current?.click()}>{testing ? "Running…" : "Test with a PDF…"}</button>
              {testJob && <TestSummary job={testJob} graph={graph} onPick={(id) => { setSelNode(id); setSide("settings"); }} />}
            </div>
          )}
          {side === "versions" && (info.published ? <History kind="workflow" entryKey={key} current={info.published.version} onRestored={() => load()} /> : <div className="muted">No published version yet.</div>)}
        </aside>
      </div>
      <div className="muted small" style={{ marginTop: 8 }}>
        Executing nodes run their engine steps and, first, any earlier step that has not run yet, so the order on the canvas may differ from the engine's; decisions read the extracted fields (spec.*), the job (job.mode, job.roll_form …) and, once resolved, keyline.*.
        {" "}<button className="link small" onClick={() => navigate("/workflows")}>All workflows</button>
      </div>
    </>
  );
}

function TestSummary({ job, graph, onPick }: { job: Dict; graph: WfGraph; onPick: (id: string) => void }) {
  const wf: JobWorkflow = job.workflow;
  const path: PathRecord[] = wf?.path ?? [];
  const badge: Record<string, string> = { DONE: "ok", NEEDS_REVIEW: "warn", FAILED: "bad", RUNNING: "accent", QUEUED: "" };
  return (
    <div className="stack">
      <div className="row">
        <span className={`badge ${badge[job.job.status] ?? ""}`}>{job.job.status.replace("_", " ")}</span>
        <Link to={`/jobs/${job.job.id}`} target="_blank">open test job #{job.job.id}</Link>
      </div>
      {job.review && <div className="msg warn small">Paused at <b>{job.review.node ?? job.review.step}</b>: {job.review.message}. Answer it on the job page; the test continues from there.</div>}
      {job.job.status === "FAILED" && <div className="msg bad small">{job.job.error}</div>}
      <ol className="small wf-path">
        {path.map((r, i) => (
          <li key={i}><button className="link" onClick={() => onPick(r.node)}><span className={`wf-dot ${r.status}`} /> {r.label || nodeTitle(graph.nodes.find((n) => n.id === r.node) ?? { ...graph.nodes[0], type: r.type as NodeType, label: r.node })}</button>
            {r.branch && <span className="muted"> → {r.branch}</span>}
            {r.steps.length > 0 && <span className="muted"> ({r.steps.map((s) => `${s.step}${s.seconds != null ? ` ${s.seconds}s` : ""}`).join(", ")})</span>}
            {r.parent && <span className="muted"> in {r.parent}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function NodeRun({ job, nodeId }: { job: Dict; nodeId: string }) {
  const wf: JobWorkflow = job.workflow;
  const rec = (wf?.path ?? []).filter((r) => r.node === nodeId && !r.parent).slice(-1)[0];
  if (!rec) return <div className="muted small" style={{ marginTop: 10 }}>This node was not visited in the last run.</div>;
  const stepNames = new Set(rec.steps.map((s) => s.step));
  const events: Dict[] = (job.events ?? []).filter((e: Dict) => stepNames.has(e.step) || e.step === rec.type || e.data?.node === nodeId).slice(0, 12);
  return (
    <div className="stack" style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
      <div><span className={`badge ${{ passed: "ok", review: "warn", failed: "bad", running: "accent" }[rec.status]}`}>{rec.status}</span> {rec.reason && <span className="small">{rec.reason}</span>}</div>
      {rec.branch && <div className="small">Branch taken: <b>{rec.branch}</b></div>}
      {rec.steps.length > 0 && (
        <table className="kl-table"><tbody>
          {rec.steps.map((s) => <tr key={s.step}><td><code>{s.step}</code>{s.implicit && <span className="muted small"> (prerequisite)</span>}</td><td><span className={`badge ${{ done: "ok", failed: "bad", needs_review: "warn" }[s.status] ?? ""}`}>{s.status}</span></td><td className="muted small">{s.seconds != null ? `${s.seconds} s` : ""}</td></tr>)}
        </tbody></table>
      )}
      {events.length > 0 && <div className="small stack" style={{ gap: 2 }}>{events.map((e, i) => <div key={i} className="muted">{e.message}</div>)}</div>}
    </div>
  );
}
