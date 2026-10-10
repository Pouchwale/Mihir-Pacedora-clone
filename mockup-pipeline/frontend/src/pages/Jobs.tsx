import { useEffect, useRef, useState, type MouseEvent } from "react";
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
  close: "M18 6 6 18M6 6l12 12",
  layers: "M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  check: "M20 6 9 17l-5-5",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
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
  const [qInput, setQInput] = useState(""); // what is typed; the search runs a moment after typing stops
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { const t = window.setTimeout(() => setQ(qInput.trim()), 250); return () => window.clearTimeout(t); }, [qInput]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === "/" && !el.closest("input, textarea, select, [contenteditable]")) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
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
  const stats: { label: string; value: number; filter: string; tone: string; hint: string; icon: string }[] = [
    { label: "All jobs", value: all, filter: "", tone: "", icon: I.layers, hint: n("CANCELLED") ? `${n("CANCELLED")} cancelled included` : "Every upload" },
    { label: "Done", value: n("DONE"), filter: "DONE", tone: "ok", icon: I.check, hint: "3D mockup ready" },
    { label: "In progress", value: n("QUEUED", "RUNNING"), filter: "QUEUED,RUNNING", tone: "accent", icon: I.clock, hint: n("QUEUED", "RUNNING") ? `${n("RUNNING")} running, ${n("QUEUED")} queued` : "Nothing running" },
    { label: "Need attention", value: n("FAILED", "NEEDS_REVIEW", "PAUSED"), filter: "FAILED,NEEDS_REVIEW,PAUSED", tone: "bad", icon: I.alert,
      hint: n("FAILED", "NEEDS_REVIEW", "PAUSED") ? [["FAILED", "failed"], ["NEEDS_REVIEW", "to review"], ["PAUSED", "paused"]].filter(([k]) => n(k)).map(([k, w]) => `${n(k)} ${w}`).join(", ") : "All clear" },
  ];
  const group = stats.find((x) => x.filter === status && status.includes(","));
  const styleKeys = [...Object.keys(POUCH_STYLE), ...Object.keys(types).filter((k) => !(k in POUCH_STYLE))].filter((k) => (types[k] ?? 0) > 0 || style === k);
  const filtered = !!(q || status || style || owner);
  const clearAll = () => { setQInput(""); setQ(""); setStatus(""); setStyle(""); setOwner(""); };
  const controls = (j: JobSummary) => <JobControls job={j} compact onDone={(m) => { setMsg(m); setTick((t) => t + 1); }} />;

  return (
    <>
      <div className="page-head">
        <div><h1>Jobs</h1><div className="muted">Every approval PDF you upload becomes a job; the list updates live.</div></div>
        <Link className="btn primary" to="/upload"><Icon d={I.upload} /> Upload PDFs</Link>
      </div>

      <div className="stat-row">
        {stats.map((s) => (
          <button key={s.label} className={`stat ${s.tone} ${status === s.filter ? "on" : ""}`} onClick={() => setStatus(status === s.filter ? "" : s.filter)} aria-pressed={status === s.filter}>
            <span className="stat-top"><span className="stat-label">{s.label}</span><span className="stat-icon"><Icon d={s.icon} size={15} /></span></span>
            <span className="stat-value">{s.value}</span>
            <span className="stat-hint">{s.hint}</span>
          </button>
        ))}
      </div>

      <div className="filter-bar">
        <div className="filter-main">
          <label className="search filter-search">
            <Icon d={I.search} />
            <input ref={searchRef} placeholder="Search item code, client or file" value={qInput} onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setQInput(""); }} aria-label="Search jobs" />
            {qInput ? <button className="search-clear" onClick={() => setQInput("")} aria-label="Clear search"><Icon d={I.close} size={14} /></button> : <kbd>/</kbd>}
          </label>
          <select value={group ? status : status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">Any status</option>
            {group && <option value={group.filter}>{group.label}</option>}
            {STATUSES.map((k) => <option key={k} value={k}>{LABEL[k]} ({counts[k] ?? 0})</option>)}
          </select>
          {seesAll && (
            <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Uploaded by">
              <option value="">Everyone</option>
              {people.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
            </select>
          )}
          <div className="filter-end">
            <label className="switch-inline" title="Workflow editor test runs instead of real jobs">
              <input type="checkbox" checked={tests} onChange={(e) => setTests(e.target.checked)} /> Test runs
            </label>
            <div className="seg-toggle" role="group" aria-label="Layout">
              <button className={layout === "grid" ? "on" : ""} onClick={() => setLayout("grid")} title="Cards" aria-label="Cards" aria-pressed={layout === "grid"}><Icon d={I.grid} /></button>
              <button className={layout === "list" ? "on" : ""} onClick={() => setLayout("list")} title="List" aria-label="List" aria-pressed={layout === "list"}><Icon d={I.list} /></button>
            </div>
          </div>
        </div>
        <div className="style-chips" role="group" aria-label="Pouch style">
          <button className={`chip ${style === "" ? "on" : ""}`} onClick={() => setStyle("")} aria-pressed={style === ""}>All styles</button>
          {styleKeys.map((k) => (
            <button key={k} className={`chip ${style === k ? "on" : ""}`} onClick={() => setStyle(style === k ? "" : k)} aria-pressed={style === k} title={`Show only ${pouchStyle(k)} jobs`}>
              {POUCH_STYLE[k] ?? pouchStyle(k)} <span className="chip-count">{types[k] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="result-line">
        <span className="muted small">{loaded ? `${total} ${total === 1 ? "job" : "jobs"}${filtered ? " match" : ""}` : "Loading…"}</span>
        {filtered && <button className="link small" onClick={clearAll}>Clear filters</button>}
      </div>
      {msg && <div className="msg warn" style={{ marginBottom: 12 }}>{msg}</div>}

      {loaded && jobs.length === 0 && (
        <div className="card empty-state">
          <div className="dropzone-icon"><Icon d={I.box} size={26} /></div>
          <b>{filtered ? "No jobs match" : "No jobs yet"}</b>
          <span className="muted">{filtered ? "Try another filter or search." : "Upload approval PDFs and each one becomes a 3D mockup automatically."}</span>
          {filtered && <button onClick={clearAll}>Clear filters</button>}
          {!filtered && <Link className="btn primary" to="/upload"><Icon d={I.upload} /> Upload PDFs</Link>}
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
