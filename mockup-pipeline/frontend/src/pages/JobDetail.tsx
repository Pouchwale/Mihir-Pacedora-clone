import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, type JobWorkflow, type PathRecord } from "../api";
import { useSession } from "../App";
import AdjustPanel, { type Uploaded } from "../components/AdjustPanel";
import KeylineWorkspace from "../components/KeylineWorkspace";
import ReviewPanel from "../components/ReviewPanel";
import Viewer from "../components/Viewer";
import WorkflowCanvas, { nodeTitle } from "../components/WorkflowCanvas";
import { draftFrom, type Draft } from "../three/draft";
import type { SceneData, SceneFile } from "../three/types";
import { formatTime } from "../util";
import { JobControls, STATUS_BADGE } from "./Jobs";
import { NodeRun } from "./WorkflowEditor";

type Dict = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Tab = "keyline_workspace" | "results" | "workflow" | "specs" | "keyline" | "steps" | "log";

const fileUrl = (jobId: number, key: string) => `/api/jobs/${jobId}/file?key=${encodeURIComponent(key)}`;
const SOURCE_BADGE: Record<string, string> = { item_override: "bad", client_override: "warn", pouch_type: "accent", measured: "ok", spec_table: "ok" };

function duration(a?: string | null, b?: string | null) {
  if (!a || !b) return "";
  const s = (new Date(b).getTime() - new Date(a).getTime()) / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${(s / 60).toFixed(1)} min`;
}

export default function JobDetail() {
  const { id = "" } = useParams();
  const jobId = Number(id);
  const { isAdmin } = useSession();
  const [data, setData] = useState<Dict | null>(null);
  const [scene, setScene] = useState<SceneData | null>(null);
  const [tab, setTab] = useState<Tab>("keyline_workspace");
  const [msg, setMsg] = useState("");
  const [preset, setPreset] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [wfNode, setWfNode] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState("");
  const [shareCopied, setShareCopied] = useState(false);
  // pictures / logos uploaded from the Adjust panel in this session (the scene lists them once applied)
  const [uploaded, setUploaded] = useState<Record<string, SceneFile>>({});

  const load = useCallback(async () => {
    const d = await api.get<Dict>(`/api/jobs/${jobId}`);
    setData(d);
    return d;
  }, [jobId]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      const d = await load().catch(() => null);
      if (alive && d && ["QUEUED", "RUNNING"].includes(d.job.status)) timer = window.setTimeout(tick, 2500);
    };
    tick();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [load]);

  const hasScene = !!(data?.outputs.texture && data?.outputs.build_geometry);
  const textureStamp = data?.steps.find((s: Dict) => s.step === "texture")?.finished_at;
  useEffect(() => {
    if (!hasScene) { setScene(null); return; }
    api.get<SceneData>(`/api/jobs/${jobId}/scene`).then((s) => { setScene(s); setDraft(draftFrom(s.adjust as Partial<Draft>)); }).catch(() => setScene(null));
  }, [jobId, hasScene, textureStamp]);
  const savedDraft = scene ? JSON.stringify(draftFrom(scene.adjust as Partial<Draft>)) : "";
  const dirty = !!draft && JSON.stringify(draft) !== savedDraft;
  // one scene object per (scene, uploads) pair: the viewer rebuilds its stage when the scene identity changes
  const liveScene = useMemo<SceneData | null>(() => (scene ? { ...scene, files: { ...(scene.files ?? {}), ...uploaded } } : null), [scene, uploaded]);
  const uploadArtwork = async (file: File): Promise<Uploaded> => {
    const up = await api.upload<Uploaded>(`/api/jobs/${jobId}/artwork`, { file });
    setUploaded((prev) => ({ ...prev, [String(up.file_id)]: { filename: up.filename, kind: up.kind, preview_url: up.preview_url } }));
    return up;
  };

  const currentPreset = data?.outputs?.build_geometry?.geometry?.preset_key ?? "";
  if (data && !preset && currentPreset) setPreset(currentPreset);
  if (!data) return <div className="muted">Loading…</div>;
  const job = data.job;
  const out: Dict = data.outputs;
  const running = ["QUEUED", "RUNNING"].includes(job.status);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg("");
    try {
      await fn();
      setMsg(ok);
      const poll = async () => { const d = await load(); if (["QUEUED", "RUNNING"].includes(d.job.status)) setTimeout(poll, 2500); };
      poll();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : String(err));
    }
  };
  const rerun = (step: string, latest = false) => act(() => api.post(`/api/jobs/${jobId}/rerun`, { from_step: step, latest_index: latest }), `Rerunning from ${step}…`);
  const rerunNode = (node: string) => act(() => api.post(`/api/jobs/${jobId}/rerun`, { from_node: node }), `Rerunning from node ${node}…`);
  const wf: JobWorkflow | undefined = data?.workflow;
  const applyDraft = (saveDefault: boolean) => {
    if (!draft) return;
    // Panel sources: the select stores "sheet:N" in `source`; the API takes source + sheet_panel.
    const panels = Object.fromEntries(Object.entries(draft.panels).map(([role, p]) => {
      const m = /^sheet:(\d+)$/.exec(String(p.source));
      return [role, m ? { ...p, source: "sheet", sheet_panel: Number(m[1]) } : p];
    }));
    setAdjusting(true);
    act(() => api.post(`/api/jobs/${jobId}/adjust`, { adjust: { ...draft, panels }, save_item_default: saveDefault }), "Adjustments applied; re-rendering…").finally(() => setAdjusting(false));
  };
  const resetDraft = () => {
    setAdjusting(true);
    act(() => api.post(`/api/jobs/${jobId}/adjust`, { reset: true }), "Back to the automatic result; re-running…").finally(() => setAdjusting(false));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="muted small"><Link to="/jobs">Jobs</Link> / #{job.id} · batch {job.batch_id ?? "—"}</div>
          <h1>{job.item_code ?? job.filename} <span className={`badge ${STATUS_BADGE[job.status] ?? ""}`}>{job.status.replace("_", " ")}</span>
            {job.kind === "test" && <span className="badge accent" style={{ marginLeft: 6 }}>workflow test run</span>}
            {job.approved_by && <span className="badge ok" style={{ marginLeft: 6 }}>approved by {job.approved_by}</span>}</h1>
          <div className="muted small">{job.filename} · {job.client_name ?? "client unknown"} · {job.pouch_type ?? "pouch type pending"}
            {data.keyline_template && <> · keyline {data.keyline_template} v{data.keyline_version}</>}
            {wf?.key && <> · workflow <Link to={`/workflows/${wf.key}`}>{wf.key}</Link>{wf.version ? ` v${wf.version}` : " (draft)"}</>} · updated {formatTime(job.updated_at)}</div>
        </div>
        <div className="row">
          {running && <span className="badge accent">working: {job.current_node ? `${job.current_node} / ` : ""}{job.current_step}…</span>}
          <JobControls job={job} onDone={(m) => act(async () => undefined, m)} />
          {job.status === "DONE" && <a className="btn" href={`/api/jobs/${jobId}/download.zip`}>Download all (ZIP)</a>}
          {job.status === "DONE" && hasScene && (
            <button
              className="btn"
              style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 5, background: shareCopied ? "var(--ok)" : undefined, color: shareCopied ? "#fff" : undefined }}
              onClick={async () => {
                if (shareLink) {
                  navigator.clipboard.writeText(window.location.origin + shareLink);
                  setShareCopied(true);
                  setTimeout(() => setShareCopied(false), 2500);
                  return;
                }
                try {
                  const res = await api.get<{ share_url: string }>(`/api/jobs/${jobId}/share-token`);
                  const fullUrl = window.location.origin + res.share_url;
                  setShareLink(res.share_url);
                  navigator.clipboard.writeText(fullUrl);
                  setShareCopied(true);
                  setTimeout(() => setShareCopied(false), 2500);
                } catch (e) {
                  setMsg("Could not generate share link: " + String(e));
                }
              }}
            >
              {shareCopied ? "✓ Link Copied!" : "🔗 Share 3D"}
            </button>
          )}
          {job.status === "DONE" && isAdmin && !job.approved_by && <button className="primary" onClick={() => act(() => api.post(`/api/jobs/${jobId}/approve`), "Approved.")}>Approve</button>}
        </div>
      </div>
      {msg && <div className="msg warn" style={{ marginBottom: 12 }}>{msg}</div>}
      {job.status === "FAILED" && <div className="msg bad" style={{ marginBottom: 12 }}>Failed at {job.current_step}: {job.error} <button className="link" onClick={() => rerun(job.current_step)}>retry this step</button></div>}
      {job.status === "PAUSED" && <div className="msg warn" style={{ marginBottom: 12 }}>Paused after <code>{job.current_step}</code>. Everything done so far is kept; <b>Resume</b> continues with the next step, or rerun from any step on the Steps tab.</div>}
      {job.status === "CANCELLED" && <div className="msg" style={{ marginBottom: 12, background: "var(--panel-2)" }}>Cancelled. A rerun from any step (Steps tab) or node (Workflow tab) starts it again.</div>}
      {job.status === "NEEDS_REVIEW" && data.review && <ReviewPanel jobId={jobId} review={data.review} onDone={() => act(async () => undefined, "Submitted; the job continues.")} />}

      <div className="tabs" style={{ marginTop: 14 }}>
        {(["keyline_workspace", "results", "workflow", "specs", "keyline", "steps", "log"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {{
              keyline_workspace: "📐 Keyline & Dieline Studio",
              results: "📦 3D & Renders",
              workflow: "Workflow",
              specs: "Specs",
              keyline: "Keyline Table",
              steps: "Steps",
              log: "Log",
            }[t]}
          </button>
        ))}
      </div>

      {tab === "keyline_workspace" && (
        <KeylineWorkspace
          jobId={jobId}
          job={job}
          outputs={out}
          liveScene={liveScene}
          onRefresh={load}
          onSwitchTo3D={() => setTab("results")}
        />
      )}

      {tab === "workflow" && wf && (
        <div className="wf-job">
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <WorkflowCanvas graph={wf.graph} path={wf.path} currentNode={running ? job.current_node : null} selectedNode={wfNode} onSelectNode={setWfNode} height={520} />
          </div>
          <aside className="card wf-side">
            <WorkflowInspector data={data} wf={wf} nodeId={wfNode} running={running} onPick={setWfNode} onRerun={rerunNode} />
          </aside>
        </div>
      )}

      {tab === "results" && (
        <div className="stack">
          {liveScene ? (
            <div className="viewer-layout">
              <div className="card"><Viewer scene={liveScene} draft={draft} name={job.item_code} /></div>
              {draft && !running && (
                <AdjustPanel scene={liveScene} job={data} draft={draft} dirty={dirty} busy={adjusting} isAdmin={isAdmin}
                  onChange={setDraft} onApply={applyDraft} onReset={resetDraft} onUpload={uploadArtwork} />
              )}
            </div>
          ) : <div className="card muted">{running ? "The 3D model appears when the textures are ready…" : "No 3D model yet."}</div>}
          {out.render && (
            <div className="card stack">
              <h2>Renders <span className="muted small">{out.render.width_px} × {out.render.height_px} px · preset {out.build_geometry?.geometry.preset_key}</span></h2>
              {out.render.model_mm?.flat && (
                <div className="msg ok small">
                  3D model measured — flat: <b>{out.render.model_mm.flat.x.toFixed(2)} × {out.render.model_mm.flat.y.toFixed(2)} mm</b> (W × H)
                  {" "}vs keyline {out.build_geometry?.geometry.width_mm} × {out.build_geometry?.geometry.height_mm} mm · filled:{" "}
                  {out.render.model_mm.filled.x.toFixed(1)} × {out.render.model_mm.filled.y.toFixed(1)} × {out.render.model_mm.filled.z.toFixed(1)} mm (W × H × D)
                </div>
              )}
              <div className="gallery">
                {Object.entries(out.render.views as Record<string, string>).map(([view, key]) => (
                  <a key={view} href={fileUrl(jobId, key)} target="_blank" rel="noreferrer"><img src={fileUrl(jobId, key)} alt={view} /><span>{view.replace(/_/g, " ")}</span></a>
                ))}
              </div>
              <div className="row">
                {out.render.glb_key && <a className="btn" href={fileUrl(jobId, out.render.glb_key)} download={`${job.item_code}.glb`}>Download GLB</a>}
                {out.render.mp4_key && <a className="btn" href={fileUrl(jobId, out.render.mp4_key)} target="_blank" rel="noreferrer">Turntable video</a>}
                {!running && (
                  <span className="row" style={{ marginLeft: "auto" }}>
                    <select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="output preset">
                      {Object.keys(data.index_snapshot?.output_preset ?? {}).map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                    <button disabled={!preset} onClick={() => act(() => api.post(`/api/jobs/${jobId}/rerun`, { from_step: "render", output_preset: preset }), `Rendering with preset ${preset}…`)}>Render with this preset</button>
                  </span>
                )}
              </div>
              {out.render.mp4_key && <video src={fileUrl(jobId, out.render.mp4_key)} controls loop muted style={{ maxWidth: 480, borderRadius: 8, border: "1px solid var(--border)" }} />}
            </div>
          )}
          {out.texture && (
            <div className="card stack">
              <h2>Panels</h2>
              <div className="gallery">
                {Object.entries(out.texture.textures as Dict).map(([role, t]) => (
                  <a key={role} href={fileUrl(jobId, t.preview_key)} target="_blank" rel="noreferrer">
                    <img src={fileUrl(jobId, t.preview_key)} alt={`${role} keyline`} /><span>{role} · {t.width_mm} × {t.height_mm} mm · {t.source}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "specs" && <SpecsTab out={out} />}
      {tab === "keyline" && <KeylineTab jobId={jobId} out={out} />}

      {tab === "steps" && (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>Step</th><th>Status</th><th>Attempts</th><th>Took</th><th>Error</th><th /></tr></thead>
            <tbody>
              {data.steps.map((s: Dict) => (
                <tr key={s.step}>
                  <td><code>{s.step}</code></td>
                  <td><span className={`badge ${{ done: "ok", failed: "bad", needs_review: "warn", running: "accent" }[s.status as string] ?? ""}`}>{s.status}</span></td>
                  <td className="muted">{s.attempt || ""}</td>
                  <td className="muted small">{duration(s.started_at, s.finished_at)}</td>
                  <td className="small" style={{ maxWidth: 420 }}>{s.error && <details><summary>{s.error.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 120)}</summary><pre className="diff">{s.error}</pre></details>}</td>
                  <td>{!running && <button className="link" onClick={() => rerun(s.step)}>rerun from here</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {isAdmin && !running && (
            <div className="row" style={{ padding: 12 }}>
              <button onClick={() => rerun("resolve_keyline", true)}>Re-render on the latest index</button>
              <span className="muted small">Pins the current index versions and reruns from resolve_keyline. This job used keyline {data.keyline_template} v{data.keyline_version}.</span>
            </div>
          )}
        </div>
      )}

      {tab === "log" && (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>When</th><th>Level</th><th>Step</th><th>Message</th></tr></thead>
            <tbody>
              {data.events.map((e: Dict, i: number) => (
                <tr key={i}><td className="muted small">{formatTime(e.at)}</td>
                  <td><span className={`badge ${{ error: "bad", warning: "warn", audit: "accent" }[e.level as string] ?? ""}`}>{e.level}</span></td>
                  <td className="muted small">{e.step}</td><td>{e.message}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ padding: 12 }}><a href={`/api/jobs/${jobId}/audit`} target="_blank" rel="noreferrer">Audit record (JSON)</a></div>
        </div>
      )}
    </>
  );
}

/** Right-hand panel of the Workflow tab: the path, or the selected node's run (steps, timings, outputs, images) with a rerun button. */
function WorkflowInspector({ data, wf, nodeId, running, onPick, onRerun }: { data: Dict; wf: JobWorkflow; nodeId: string | null; running: boolean; onPick: (id: string) => void; onRerun: (id: string) => void }) {
  const out: Dict = data.outputs ?? {};
  const job = data.job;
  const node = nodeId ? wf.graph.nodes.find((n) => n.id === nodeId) : undefined;
  const path: PathRecord[] = wf.path;
  const url = (key: string) => fileUrl(job.id, key);
  if (!node) {
    return (
      <div className="stack">
        <h2 style={{ margin: 0 }}>{wf.graph.name}</h2>
        <div className="muted small">{wf.graph.description}</div>
        <div className="small"><span className="wf-dot passed" /> passed · <span className="wf-dot review" /> paused for review · <span className="wf-dot failed" /> failed · <span className="wf-dot running" /> running · grey: not on this job's path</div>
        <div><b>Path of the last run</b></div>
        <ol className="small wf-path">
          {path.map((r, i) => (
            <li key={i}><button className="link" onClick={() => onPick(r.parent ?? r.node)}><span className={`wf-dot ${r.status}`} /> {r.label}</button>
              {r.branch && <span className="muted"> → {r.branch}</span>}{r.parent && <span className="muted"> (in {r.parent})</span>}
              {r.steps.length > 0 && <span className="muted"> · {r.steps.map((s) => `${s.step}${s.seconds != null ? ` ${s.seconds}s` : ""}`).join(", ")}</span>}
            </li>
          ))}
          {path.length === 0 && <li className="muted">Not started yet.</li>}
        </ol>
        <div className="muted small">Click a node on the canvas for its steps, timings, outputs and images.</div>
      </div>
    );
  }
  const rec = path.filter((r) => r.node === node.id && !r.parent).slice(-1)[0];
  const stepNames = rec ? rec.steps.map((s) => s.step) : [];
  const images: [string, string][] = [];
  if (node.type === "prepare" && out.extract_specs) images.push(["spec table", out.extract_specs.spec_image_key], ["dimension drawing", out.extract_specs.dimension_image_key]);
  if (node.type === "prepare" && out.trim_artwork?.bleed_key) images.push(["artwork with bleed", out.trim_artwork.bleed_key]);
  if (node.type === "artwork" && out.texture) for (const [role, t] of Object.entries(out.texture.textures as Dict)) images.push([`${role} keyline`, (t as Dict).preview_key]);
  if (node.type === "render" && out.render) for (const [view, key] of Object.entries(out.render.views as Record<string, string>)) images.push([view, key]);
  return (
    <div className="stack">
      <div>
        <div className="muted small">{node.type.replace(/_/g, " ")} · <code>{node.id}</code></div>
        <h2 style={{ margin: 0 }}>{nodeTitle(node)}</h2>
        {node.type === "decision" && <div className="small muted">{wf.graph.edges.filter((e) => e.source === node.id).map((e) => e.otherwise ? "ELSE" : e.label || "(conditions)").join(" · ")}</div>}
        {node.type === "fetch" && <div className="small muted">{node.fields.map((f) => f.key + (f.required ? "" : "?")).join(", ")}</div>}
        {node.type === "set_pouch_type" && <div className="small muted">{node.pouch_type ?? "automatic (match rules)"}</div>}
        {node.type === "review" && node.message && <div className="small muted">{node.message}</div>}
      </div>
      <NodeRun job={data} nodeId={node.id} />
      {stepNames.filter((s) => out[s]).map((s) => (
        <details key={s}><summary className="small">Output of <code>{s}</code></summary><pre className="diff small">{JSON.stringify(out[s], (k, v) => (k === "cells" || k === "evaluated" || k === "labels" ? undefined : v), 1).slice(0, 6000)}</pre></details>
      ))}
      {images.length > 0 && (
        <div className="gallery">{images.map(([label, key]) => <a key={label} href={url(key)} target="_blank" rel="noreferrer"><img src={url(key)} alt={label} /><span>{label}</span></a>)}</div>
      )}
      {!running && node.type !== "end" && <div><button onClick={() => onRerun(node.id)}>Rerun from this node</button></div>}
    </div>
  );
}

function SpecsTab({ out }: { out: Dict }) {
  const sheet = out.validate?.sheet ?? out.extract_specs?.sheet;
  if (!sheet) return <div className="card muted">Specs not extracted yet.</div>;
  const cells: Dict = out.extract_specs?.cells ?? {};
  const corrected: string[] = out.validate?.corrected_fields ?? [];
  const show = (v: unknown) => Array.isArray(v) ? v.map((x) => (typeof x === "object" ? `${x.micron ?? ""} mic ${x.material}` : x)).join(" · ") : v === null || v === undefined ? "—" : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
  const row = (part: string, name: string, f: Dict) => {
    const verified = corrected.includes(`${part}.${name}`);
    return (
      <tr key={part + name}>
        <td><code>{name}</code></td>
        <td>{show(f.value)}</td>
        <td><span className={`badge ${verified ? "accent" : f.confidence >= 0.85 ? "ok" : "warn"}`}>{verified ? "operator" : `${Math.round(f.confidence * 100)}%`}</span></td>
        <td className="muted small">{cells[name]?.source ?? ""}</td>
      </tr>
    );
  };
  return (
    <div className="grid2" style={{ alignItems: "start" }}>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table><thead><tr><th>Spec table</th><th>Value</th><th>Confidence</th><th>Read by</th></tr></thead>
          <tbody>{Object.entries(sheet.spec_table as Dict).map(([n, f]) => row("spec_table", n, f))}</tbody></table>
      </div>
      <div className="stack">
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table><thead><tr><th>Dieline (measured)</th><th>Value</th><th>Confidence</th><th /></tr></thead>
            <tbody>{Object.entries(sheet.measured_keyline as Dict).filter(([n]) => n !== "labels" && n !== "zipper_y_mm").map(([n, f]) => row("measured_keyline", n, f))}</tbody></table>
        </div>
        <div className="card">
          <h2>Linked panels</h2>
          {Object.entries(sheet.linked_codes as Dict).map(([role, code]) => <div key={role}>{role}: <b>{String(code)}</b>
            {out.link_panels?.confirmed_codes?.[role] ? <span className="badge ok" style={{ marginLeft: 6 }}>found in registry</span> : null}</div>)}
          {Object.keys(sheet.linked_codes).length === 0 && <span className="muted">none</span>}
        </div>
        {out.validate?.report && (
          <div className="card">
            <h2>Validation</h2>
            {out.validate.report.issues.length === 0 ? <span className="badge ok">all checks passed</span>
              : out.validate.report.issues.map((i: Dict, k: number) => <div key={k} className="small"><span className={`badge ${i.severity === "review" ? "bad" : "warn"}`}>{i.severity}</span> {i.field}: {i.message}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}

function KeylineTab({ jobId, out }: { jobId: number; out: Dict }) {
  const kl = out.resolve_keyline?.keyline;
  if (!kl) return <div className="card muted">Keyline not resolved yet.</div>;
  return (
    <div className="stack">
      {out.texture && (
        <div className="card">
          <h2>Keyline preview</h2>
          <div className="gallery wide">
            {Object.entries(out.texture.textures as Dict).map(([role, t]) => (
              <a key={role} href={fileUrl(jobId, t.preview_key)} target="_blank" rel="noreferrer"><img src={fileUrl(jobId, t.preview_key)} alt={role} /><span>{role}</span></a>
            ))}
          </div>
        </div>
      )}
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Field</th><th>Value</th><th>Source</th><th>From</th></tr></thead>
          <tbody>
            {Object.entries(kl.fields as Dict).map(([name, f]) => (
              <tr key={name}><td><code>{name}</code></td>
                <td>{f.value === null ? <span className="muted">—</span> : `${String(f.value)}${typeof f.value === "number" && f.unit ? " " + f.unit : ""}`}</td>
                <td><span className={`badge ${SOURCE_BADGE[f.source] ?? ""}`}>{String(f.source).replace("_", " ")}</span></td>
                <td className="muted small"><code>{f.detail}</code></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
