import { useEffect, useState } from "react";
import { api, ApiError, Role, ROLE_LABELS } from "../api";
import { formatTime } from "../util";

interface Entry { ts: string; action: string; user: string | null; role: string | null; ip?: string; method?: string; path?: string; status?: number; [k: string]: unknown }
interface Log { day: string; days: string[]; users: string[]; entries: Entry[]; total: number; page: number; page_size: number; pages: number; folder: string }
const PAGE_SIZES = [50, 100, 250, 500];

const SHOWN = new Set(["ts", "action", "user", "role", "ip", "method", "path", "status", "ms", "page"]);

/** What happened, in words: the request line, the page, or the event's own fields. */
function describe(e: Entry): string {
  if (e.action === "request") return `${e.method} ${e.path}${e.status ? ` → ${e.status}` : ""}`;
  if (e.action === "page") return String(e.page ?? "");
  const rest = Object.fromEntries(Object.entries(e).filter(([k]) => !SHOWN.has(k)));
  return Object.keys(rest).length ? JSON.stringify(rest) : "";
}

export default function Activity() {
  const today = new Date().toLocaleDateString("en-CA");  // YYYY-MM-DD in local time, as the server names files
  const [day, setDay] = useState(today);
  const [user, setUser] = useState("");
  const [action, setAction] = useState("");
  const [reads, setReads] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState("");

  useEffect(() => setPage(1), [day, user, action, reads, pageSize]);  // a new filter starts at page 1
  useEffect(() => {
    const q = new URLSearchParams({ day, reads: String(reads), page: String(page), page_size: String(pageSize) });
    if (user) q.set("user", user);
    if (action) q.set("action", action);
    let stale = false;  // a reply for filters already changed again is dropped
    const t = setTimeout(() => {
      api.get<Log>(`/api/activity?${q}`)
        .then((l) => { if (!stale) { setLog(l); setError(""); } })
        .catch((e) => { if (!stale) setError(e instanceof ApiError ? e.message : String(e)); });
    }, action ? 300 : 0);
    return () => { stale = true; clearTimeout(t); };
  }, [day, user, action, reads, page, pageSize]);

  const days = log ? Array.from(new Set([today, ...log.days])) : [today];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Activity log</h1>
          <div className="muted">Every sign-in, page, upload and change, by user. Kept on disk one file a day{log ? <> in <code>{log.folder}</code></> : null}.</div>
        </div>
      </div>
      {error && <div className="msg bad" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="card row" style={{ marginBottom: 12 }}>
        <label className="field">Day<select value={day} onChange={(e) => setDay(e.target.value)}>{days.map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
        <label className="field">User<select value={user} onChange={(e) => setUser(e.target.value)}><option value="">Everyone</option>{log?.users.map((u) => <option key={u} value={u}>{u}</option>)}</select></label>
        <label className="field">Search<input value={action} placeholder="signed in, uploaded, /api/index …" onChange={(e) => setAction(e.target.value)} /></label>
        <label className="check" title="Also list every page-data read (GET requests): many lines"><input type="checkbox" checked={reads} onChange={(e) => setReads(e.target.checked)} /> include reads</label>
      </div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Details</th><th>Address</th></tr></thead>
          <tbody>
            {log?.entries.map((e, i) => (
              <tr key={i}>
                <td className="small" style={{ whiteSpace: "nowrap" }}>{formatTime(e.ts, true)}</td>
                <td className="small">{e.user ?? <span className="muted">not signed in</span>}{e.role && <div className="muted">{ROLE_LABELS[e.role as Role] ?? e.role}</div>}</td>
                <td><span className={`badge ${e.action.includes("failed") ? "bad" : e.action === "request" || e.action === "page" ? "" : "accent"}`}>{e.action}</span></td>
                <td className="small" style={{ maxWidth: 560, wordBreak: "break-word" }}>{describe(e)}</td>
                <td className="small muted">{e.ip}</td>
              </tr>
            ))}
            {log && log.entries.length === 0 && <tr><td colSpan={5} className="muted">Nothing logged for this day and filter.</td></tr>}
          </tbody>
        </table>
      </div>
      {log && log.total > 0 && (
        <div className="row pager">
          <span className="muted small">
            {(log.page - 1) * log.page_size + 1}–{Math.min(log.page * log.page_size, log.total)} of {log.total}
          </span>
          <span style={{ flex: 1 }} />
          <label className="small muted">Rows <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>{PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          <button onClick={() => setPage(1)} disabled={log.page <= 1} aria-label="First page">«</button>
          <button onClick={() => setPage(log.page - 1)} disabled={log.page <= 1}>‹ Newer</button>
          <span className="small">Page {log.page} of {log.pages}</span>
          <button onClick={() => setPage(log.page + 1)} disabled={log.page >= log.pages}>Older ›</button>
          <button onClick={() => setPage(log.pages)} disabled={log.page >= log.pages} aria-label="Last page">»</button>
        </div>
      )}
    </>
  );
}
