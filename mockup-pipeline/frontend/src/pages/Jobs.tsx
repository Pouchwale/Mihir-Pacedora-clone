import { useEffect, useState, type MouseEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, type User } from "../api";
import { useSession } from "../App";
import { formatTime, parseTime } from "../util";

export interface JobSummary {
  id: number; batch_id: number | null; filename: string; item_code: string | null; client_name: string | null; status: string;
  current_step: string; pouch_type: string | null; review_message: string | null; error: string | null; approved_by: string | null;
  created_by: string | null; created_at: string; updated_at: string;
}

export const STATUS_BADGE: Record<string, string> = { DONE: "ok", NEEDS_REVIEW: "warn", FAILED: "bad", RUNNING: "accent", QUEUED: "", PAUSED: "warn", CANCELLED: "" };
const PAGE_SIZE = 24;
const STATUSES = ["QUEUED", "RUNNING", "NEEDS_REVIEW", "PAUSED", "FAILED", "DONE", "CANCELLED"];
/** Readable pouch styles (index pouch types); unknown keys fall back to their own words. */
export const POUCH_STYLE: Record<string, string> = {
  stand_up_bottom_gusset: "Stand-up (bottom gusset)", spout_pouch: "Spout pouch", three_side_seal: "Three-side seal",
  center_seal_pillow: "Centre seal (pillow)", center_seal_side_gusset: "Centre seal + side gussets", quad_seal: "Quad seal",
  flat_bottom_box_pouch: "Flat bottom / box", roll_stock: "Roll stock", shaped_diecut: "Shaped die-cut", shrink_sleeve: "Shrink sleeve",
  none: "Not typed yet",
};
export const pouchStyle = (key: string | null | undefined) => (key ? POUCH_STYLE[key] ?? key.replace(/_/g, " ") : "type pending");
const LABEL: Record<string, string> = { QUEUED: "Queued", RUNNING: "Running", NEEDS_REVIEW: "Needs review", PAUSED: "Paused", FAILED: "Failed", DONE: "Done", CANCELLED: "Cancelled" };
// the workflow's steps, for the progress bar of a running job
const STEPS = ["ingest", "trim_artwork", "extract_specs", "validate", "match_pouch_type", "resolve_keyline", "link_panels", "build_geometry", "texture", "render", "export"];

/** "5 min ago" for recent times, the date after a week. */
function ago(iso: string): string {
  const s = (Date.now() - parseTime(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return formatTime(iso);
}

const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const I = {
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  box: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z",
};

/** Pause / resume / cancel controls for one job (used on the list and on the job page). */
export function JobControls({ job, onDone, compact = false }: { job: { id: number; status: string }; onDone: (msg: string) => void; compact?: boolean }) {
  const act = async (e: MouseEvent, path: string, msg: string) => {
    e.stopPropagation();
    try {
      await api.post(`/api/jobs/${job.id}/${path}`);
      onDone(msg);
    } catch (err) {
      onDone(err instanceof Error ? err.message : String(err));
    }
  };
  const cls = compact ? "link small" : "";
  return (
    <span className="row" style={{ gap: compact ? 2 : 8 }}>
      {["QUEUED", "RUNNING"].includes(job.status) && <button className={cls} onClick={(e) => act(e, "pause", job.status === "RUNNING" ? "Pausing after the current step…" : "Paused.")} title="Stop after the current step; resume later from there">Pause</button>}
      {job.status === "PAUSED" && <button className={compact ? cls : "primary"} onClick={(e) => act(e, "resume", "Resumed.")}>Resume</button>}
      {!["DONE", "CANCELLED"].includes(job.status) && <button className={compact ? "link small" : "danger"} onClick={(e) => act(e, "cancel", job.status === "RUNNING" ? "Cancelling after the current step…" : "Cancelled.")} title="Stop the job; a rerun from any step starts it again">{compact ? "Cancel" : "Cancel job"}</button>}
    </span>
  );
}

/** The job's finished render (front view), or a placeholder while it is not rendered yet. */
function Thumb({ job }: { job: JobSummary }) {
  const [view, setView] = useState(0);
  const views = ["front", "three_quarter_left", "three_quarter_right"];
  if (job.status !== "DONE" || view >= views.length) {
    return <div className="job-thumb empty"><Icon d={I.box} size={28} /></div>;
  }
  const key = `jobs/${job.id}/renders/${views[view]}.png`;
  return <div className="job-thumb"><img src={`/api/jobs/${job.id}/file?key=${encodeURIComponent(key)}`} alt="" loading="lazy" onError={() => setView(view + 1)} /></div>;
}

function Status({ job }: { job: JobSummary }) {
  const running = job.status === "RUNNING";
  const step = Math.max(0, STEPS.indexOf(job.current_step));
  return (
    <div className="job-status">
      <span className={`badge dot ${STATUS_BADGE[job.status] ?? ""}`}>{LABEL[job.status] ?? job.status}</span>
      {job.approved_by && <span className="badge ok">approved</span>}
      {running && (
        <div className="progress" title={`Step ${step + 1} of ${STEPS.length}: ${job.current_step}`}>
          <i style={{ width: `${((step + 0.5) / STEPS.length) * 100}%` }} />
        </div>
      )}
      {running && <div className="small muted">{job.current_step.replace(/_/g, " ")}…</div>}
      {job.review_message && <div className="small muted clamp">{job.review_message}</div>}
      {job.error && <div className="small clamp" style={{ color: "var(--bad)" }}>{job.error}</div>}
    </div>
  );
}

export default function Jobs() {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [types, setTypes] = useState<Record<string, number>>({});
  const [style, setStyle] = useState(""); // pouch style filter ("" = all)
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [tests, setTests] = useState(false); // workflow editor test runs instead of real jobs
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [layout, setLayoutState] = useState<"grid" | "list">(() => {
    try { return localStorage.getItem("jobs-layout") === "list" ? "list" : "grid"; } catch { return "grid"; }
  });
  const setLayout = (l: "grid" | "list") => { setLayoutState(l); try { localStorage.setItem("jobs-layout", l); } catch { /* private window */ } };
  const navigate = useNavigate();
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // the admin sees everyone's jobs and can narrow them to one user (?user=<id>, from the Users page too)
  const { can } = useSession();
  const seesAll = can("see_all_jobs");
  const [params, setParams] = useSearchParams();
  const owner = params.get("user") ?? "";
  const setOwner = (id: string) => setParams(id ? { user: id } : {}, { replace: true });
  const [people, setPeople] = useState<User[]>([]);
  useEffect(() => { if (seesAll) api.get<User[]>("/api/users").then(setPeople).catch(() => undefined); }, [seesAll]);

  // a new filter or search starts again at the first page
  useEffect(() => { setPage(0); }, [status, q, tests, style, owner]);

  useEffect(() => {
    let alive = true;
    const load = () => api.get<{ jobs: JobSummary[]; counts: Record<string, number>; types?: Record<string, number>; total: number }>(
      `/api/jobs?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}&kind=${tests ? "test" : "job"}&pouch_type=${encodeURIComponent(style)}${owner ? `&user=${owner}` : ""}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`)
      .then((r) => {
        if (!alive) return;
        setJobs(r.jobs); setCounts(r.counts); setTypes(r.types ?? {}); setTotal(r.total); setLoaded(true);
        if (r.jobs.length === 0 && page > 0) setPage(Math.max(0, Math.ceil(r.total / PAGE_SIZE) - 1)); // the last page emptied (jobs removed)
      });
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [status, q, tests, tick, page, style, owner]);

  const n = (...s: string[]) => s.reduce((a, k) => a + (counts[k] ?? 0), 0);
  const all = n(...STATUSES);
  const stats: { label: string; value: number; filter: string; tone: string; hint: string }[] = [
    { label: "All jobs", value: all, filter: "", tone: "", hint: "Every job" },
    { label: "Done", value: n("DONE"), filter: "DONE", tone: "ok", hint: "3D mockup ready" },
    { label: "In progress", value: n("QUEUED", "RUNNING"), filter: "QUEUED,RUNNING", tone: "accent", hint: "Queued or running" },
    { label: "Need attention", value: n("FAILED", "NEEDS_REVIEW", "PAUSED"), filter: "FAILED,NEEDS_REVIEW,PAUSED", tone: "bad", hint: "Failed, paused or waiting" },
  ];
  const controls = (j: JobSummary) => <JobControls job={j} compact onDone={(m) => { setMsg(m); setTick((t) => t + 1); }} />;

  return (
    <>
      <div className="page-head">
        <div><h1>Jobs</h1><div className="muted">Every approval PDF you upload becomes a job; the list updates live.</div></div>
        <Link className="btn primary" to="/upload"><Icon d={I.upload} /> Upload PDFs</Link>
      </div>

      <div className="stat-row">
        {stats.map((s) => (
          <button key={s.label} className={`stat ${s.tone} ${status === s.filter ? "on" : ""}`} onClick={() => setStatus(s.filter)} title={s.hint}>
            <span className="stat-label">{s.label}</span>
            <span className="stat-value">{s.value}</span>
          </button>
        ))}
      </div>

      <div className="toolbar">
        <div className="pills">
          <button className={`pill ${status === "" ? "on" : ""}`} onClick={() => setStatus("")}>All</button>
          {STATUSES.map((s) => (
            <button key={s} className={`pill ${status === s ? "on" : ""}`} onClick={() => setStatus(s)}>{LABEL[s]} <span className="pill-count">{counts[s] ?? 0}</span></button>
          ))}
        </div>
        <div className="row" style={{ marginLeft: "auto" }}>
          {seesAll && (
            <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Uploaded by" title="Uploaded by">
              <option value="">Everyone's jobs</option>
              {people.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
            </select>
          )}
          <label className="search"><Icon d={I.search} /><input placeholder="Search item code or client" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <div className="seg-toggle" role="group" aria-label="Layout">
            <button className={layout === "grid" ? "on" : ""} onClick={() => setLayout("grid")} title="Cards" aria-label="Cards"><Icon d={I.grid} /></button>
            <button className={layout === "list" ? "on" : ""} onClick={() => setLayout("list")} title="List" aria-label="List"><Icon d={I.list} /></button>
          </div>
          <label className="check small muted"><input type="checkbox" checked={tests} onChange={(e) => setTests(e.target.checked)} /> test runs</label>
        </div>
      </div>
      <div className="style-row" role="group" aria-label="Pouch style">
        <span className="style-row-label">Pouch style</span>
        <button className={`pill ${style === "" ? "on" : ""}`} onClick={() => setStyle("")}>All styles</button>
        {[...Object.keys(POUCH_STYLE), ...Object.keys(types).filter((k) => !(k in POUCH_STYLE))].map((k) => {
          const n = types[k] ?? 0;
          if (!n && k === "none") return null;
          return (
            <button key={k} className={`pill ${style === k ? "on" : ""}`} disabled={!n && style !== k} onClick={() => setStyle(style === k ? "" : k)}
              title={n ? `Show only ${pouchStyle(k)} jobs` : "No jobs of this style yet"}>
              {POUCH_STYLE[k] ?? pouchStyle(k)} <span className="pill-count">{n}</span>
            </button>
          );
        })}
      </div>
      {msg && <div className="msg warn" style={{ marginBottom: 12 }}>{msg}</div>}

      {loaded && jobs.length === 0 && (
        <div className="card empty-state">
          <div className="dropzone-icon"><Icon d={I.box} size={26} /></div>
          <b>{q || status || style ? "No jobs match" : "No jobs yet"}</b>
          <span className="muted">{q || status || style ? "Try another filter or search." : "Upload approval PDFs and each one becomes a 3D mockup automatically."}</span>
          {!q && !status && !style && <Link className="btn primary" to="/upload"><Icon d={I.upload} /> Upload PDFs</Link>}
        </div>
      )}

      {layout === "grid" ? (
        <div className="job-grid">
          {jobs.map((j) => (
            <div key={j.id} className="job-card" onClick={() => navigate(`/jobs/${j.id}`)} role="link" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && navigate(`/jobs/${j.id}`)}>
              <Thumb job={j} />
              <div className="job-card-body">
                <div className="job-card-title">
                  <b>{j.item_code ?? j.filename}</b>
                  <span className="muted small">#{j.id}</span>
                </div>
                <div className="muted small ellipsis">{j.client_name ?? "Client unknown"} · {pouchStyle(j.pouch_type)}</div>
                {seesAll && <div className="muted small ellipsis" title="Uploaded by">by {j.created_by ?? "unknown"}</div>}
                <Status job={j} />
                <div className="job-card-foot">
                  <span className="muted small" title={formatTime(j.updated_at)}>{ago(j.updated_at)}</span>
                  {controls(j)}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : jobs.length > 0 && (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="job-table">
            <thead><tr><th /><th>Item</th><th>Client</th><th>Pouch type</th><th>Status</th>{seesAll && <th>Uploaded by</th>}<th>Batch</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="clickable" onClick={() => navigate(`/jobs/${j.id}`)}>
                  <td style={{ width: 64 }}><Thumb job={j} /></td>
                  <td><b>{j.item_code ?? "—"}</b> <span className="muted small">#{j.id}</span><div className="muted small">{j.filename}</div></td>
                  <td>{j.client_name ?? <span className="muted">—</span>}</td>
                  <td>{j.pouch_type ? pouchStyle(j.pouch_type) : <span className="muted">—</span>}</td>
                  <td style={{ minWidth: 160 }}><Status job={j} /></td>
                  {seesAll && <td className="small">{j.created_by ?? <span className="muted">—</span>}</td>}
                  <td className="muted">{j.batch_id ?? "—"}</td>
                  <td className="muted small" title={formatTime(j.updated_at)}>{ago(j.updated_at)}</td>
                  <td>{controls(j)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="pager">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>‹ Previous</button>
          <span className="muted small">Page {page + 1} of {pages} · {page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total}</span>
          <button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next ›</button>
        </div>
      )}
    </>
  );
}
