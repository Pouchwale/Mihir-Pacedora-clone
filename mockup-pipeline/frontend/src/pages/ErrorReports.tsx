import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { formatTime } from "../util";

interface Report {
  id: number; job_id: number | null; item_code: string | null; user: string | null; message: string; page: string;
  context: { status?: string; step?: string; error?: string | null; review?: string | null; pouch_type?: string | null } | null;
  status: "open" | "resolved"; admin_note: string; resolved_by: string | null; resolved_at: string | null; created_at: string;
}

/** The admin's list of problems users raised: open first, each with its job's state at the time. */
export default function ErrorReports({ onChange }: { onChange?: () => void }) {
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const [data, setData] = useState<{ reports: Report[]; counts: { open: number; resolved: number } } | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [error, setError] = useState("");

  const load = () => api.get<typeof data>(`/api/errors?status=${status}`).then(setData).catch((e) => setError(String(e)));
  useEffect(() => { load(); }, [status]);

  const update = async (r: Report, body: Record<string, unknown>) => {
    setError("");
    try {
      await api.patch(`/api/errors/${r.id}`, body);
      await load();
      onChange?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Error reports</h1><div className="muted">Problems users raised with "Raise an error". Mark each resolved once handled.</div></div>
      </div>
      {error && <div className="msg bad" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="pills" style={{ marginBottom: 12 }}>
        {(["open", "resolved", "all"] as const).map((s) => (
          <button key={s} className={`pill ${status === s ? "on" : ""}`} onClick={() => setStatus(s)}>
            {s === "open" ? "Open" : s === "resolved" ? "Resolved" : "All"}
            {s !== "all" && data && <span className="pill-count">{data.counts[s]}</span>}
          </button>
        ))}
      </div>
      {data && data.reports.length === 0 && <div className="card muted">Nothing here. {status === "open" && "No open problems."}</div>}
      <div className="stack">
        {data?.reports.map((r) => (
          <div key={r.id} className="card error-report">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="row">
                <span className={`badge ${r.status === "open" ? "bad" : "ok"}`}>{r.status}</span>
                <b>#{r.id}</b>
                <span>{r.user ?? "unknown user"}</span>
                <span className="muted small">{formatTime(r.created_at)}</span>
              </div>
              {r.job_id
                ? <Link to={`/jobs/${r.job_id}`}>Job #{r.job_id}{r.item_code ? ` · ${r.item_code}` : ""}</Link>
                : <span className="muted small">no job · from {r.page || "the app"}</span>}
            </div>
            <p style={{ margin: "10px 0", whiteSpace: "pre-wrap" }}>{r.message || <span className="muted">No note written.</span>}</p>
            {r.context && (
              <div className="muted small">
                Job then: <b>{r.context.status}</b> at {r.context.step}{r.context.pouch_type ? ` · ${r.context.pouch_type}` : ""}
                {r.context.review && <> · review: {r.context.review}</>}
                {r.context.error && <details><summary>error</summary><pre className="diff">{r.context.error}</pre></details>}
              </div>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <input style={{ flex: 1, minWidth: 200 }} placeholder="Note for the record (what was done)" value={notes[r.id] ?? r.admin_note}
                onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} aria-label={`Note on report ${r.id}`} />
              {(notes[r.id] ?? r.admin_note) !== r.admin_note && <button onClick={() => update(r, { admin_note: notes[r.id] })}>Save note</button>}
              {r.status === "open"
                ? <button className="primary" onClick={() => update(r, { status: "resolved", admin_note: notes[r.id] ?? r.admin_note })}>Mark resolved</button>
                : <button onClick={() => update(r, { status: "open" })}>Reopen</button>}
            </div>
            {r.resolved_by && <div className="muted small" style={{ marginTop: 6 }}>Resolved by {r.resolved_by}{r.resolved_at ? `, ${formatTime(r.resolved_at)}` : ""}</div>}
          </div>
        ))}
      </div>
    </>
  );
}
