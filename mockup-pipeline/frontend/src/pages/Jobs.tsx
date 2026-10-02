import { useEffect, useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { formatTime } from "../util";

export interface JobSummary {
  id: number; batch_id: number | null; filename: string; item_code: string | null; client_name: string | null; status: string;
  current_step: string; pouch_type: string | null; review_message: string | null; error: string | null; approved_by: string | null;
  created_at: string; updated_at: string;
}

export const STATUS_BADGE: Record<string, string> = { DONE: "ok", NEEDS_REVIEW: "warn", FAILED: "bad", RUNNING: "accent", QUEUED: "", PAUSED: "warn", CANCELLED: "" };
const PAGE_SIZE = 20;
const STATUSES = ["QUEUED", "RUNNING", "NEEDS_REVIEW", "PAUSED", "FAILED", "DONE", "CANCELLED"];

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

export default function Jobs() {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [tests, setTests] = useState(false); // workflow editor test runs instead of real jobs
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const navigate = useNavigate();
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // a new filter or search starts again at the first page
  useEffect(() => { setPage(0); }, [status, q, tests]);

  useEffect(() => {
    let alive = true;
    const load = () => api.get<{ jobs: JobSummary[]; counts: Record<string, number>; total: number }>(
      `/api/jobs?status=${status}&q=${encodeURIComponent(q)}&kind=${tests ? "test" : "job"}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`)
      .then((r) => {
        if (!alive) return;
        setJobs(r.jobs); setCounts(r.counts); setTotal(r.total);
        if (r.jobs.length === 0 && page > 0) setPage(Math.max(0, Math.ceil(r.total / PAGE_SIZE) - 1)); // the last page emptied (jobs removed)
      });
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [status, q, tests, tick, page]);

  return (
    <>
      <div className="page-head">
        <div><h1>Jobs</h1><div className="muted">Grouped by upload batch; updates live.</div></div>
        <Link className="btn" to="/upload">Upload PDFs</Link>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className={`chip ${status === "" ? "on" : ""}`} onClick={() => setStatus("")}>All</span>
        {STATUSES.map((s) => (
          <span key={s} className={`chip ${status === s ? "on" : ""}`} onClick={() => setStatus(s)}>{s.replace("_", " ").toLowerCase()} {counts[s] ?? 0}</span>
        ))}
        <input placeholder="Search item code or client" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginLeft: "auto" }} />
        <label className="check small muted"><input type="checkbox" checked={tests} onChange={(e) => setTests(e.target.checked)} /> workflow test runs</label>
      </div>
      {msg && <div className="msg warn" style={{ marginBottom: 12 }}>{msg}</div>}
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>#</th><th>Item</th><th>Client</th><th>Pouch type</th><th>Status</th><th>Step</th><th>Batch</th><th>Updated</th><th /></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="clickable" onClick={() => navigate(`/jobs/${j.id}`)}>
                <td>{j.id}</td>
                <td><b>{j.item_code ?? "—"}</b><div className="muted small">{j.filename}</div></td>
                <td>{j.client_name ?? <span className="muted">—</span>}</td>
                <td>{j.pouch_type ?? <span className="muted">—</span>}</td>
                <td>
                  <span className={`badge ${STATUS_BADGE[j.status] ?? ""}`}>{j.status.replace("_", " ")}</span>
                  {j.approved_by && <span className="badge ok" style={{ marginLeft: 4 }}>approved</span>}
                  {j.review_message && <div className="small muted" style={{ maxWidth: 320 }}>{j.review_message}</div>}
                  {j.error && <div className="small" style={{ color: "var(--bad)", maxWidth: 320 }}>{j.error}</div>}
                </td>
                <td className="muted">{j.current_step}</td>
                <td className="muted">{j.batch_id ?? "—"}</td>
                <td className="muted small">{formatTime(j.updated_at)}</td>
                <td><JobControls job={j} compact onDone={(m) => { setMsg(m); setTick((t) => t + 1); }} /></td>
              </tr>
            ))}
            {jobs.length === 0 && <tr><td colSpan={9} className="muted">No jobs yet. <Link to="/upload">Upload PDFs</Link>.</td></tr>}
          </tbody>
        </table>
      </div>
      {total > PAGE_SIZE && (
        <div className="row" style={{ marginTop: 12, justifyContent: "center" }}>
          <button disabled={page === 0} onClick={() => setPage(0)}>« First</button>
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>‹ Previous</button>
          <span className="muted small">Page {page + 1} of {pages} · jobs {page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total}</span>
          <button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next ›</button>
          <button disabled={page + 1 >= pages} onClick={() => setPage(pages - 1)}>Last »</button>
        </div>
      )}
    </>
  );
}
