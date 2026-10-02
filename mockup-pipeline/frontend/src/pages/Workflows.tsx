import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type WorkflowOut } from "../api";
import { useSession } from "../App";
import { formatTime } from "../util";

export default function Workflows() {
  const { isAdmin } = useSession();
  const [rows, setRows] = useState<WorkflowOut[]>([]);
  const [newKey, setNewKey] = useState("");
  const navigate = useNavigate();

  useEffect(() => { api.get<WorkflowOut[]>("/api/workflows").then(setRows); }, []);

  const create = () => {
    const key = newKey.trim().toLowerCase().replace(/\s+/g, "_");
    if (key) navigate(`/workflows/${key}`);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Workflows</h1>
          <div className="muted">What happens to a job, as a flowchart: prepare, decide, fetch fields, set the pouch type, validate, build, render. Jobs run <b>default</b>; other workflows serve as sub-workflows or for tests.</div>
        </div>
        {isAdmin && (
          <div className="row">
            <input placeholder="new workflow key (e.g. spout_only)" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
            <button className="primary" onClick={create} disabled={!newKey.trim()}>New workflow</button>
          </div>
        )}
      </div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Name</th><th>Key</th><th>Published</th><th>Draft</th><th>State</th></tr></thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.key} className="clickable" onClick={() => navigate(`/workflows/${w.key}`)}>
                <td><b>{w.name}</b>{w.archived && <span className="badge warn" style={{ marginLeft: 6 }}>archived</span>}<div className="muted small">{w.draft?.graph.description || w.published?.graph.description}</div></td>
                <td><code>{w.key}</code></td>
                <td>{w.published ? <>v{w.published.version} <span className="muted small">by {w.published.author}, {formatTime(w.published.created_at)}</span></> : <span className="muted">—</span>}</td>
                <td>{w.draft ? <span className="badge accent">draft by {w.draft.updated_by}</span> : <span className="muted">—</span>}</td>
                <td>{w.problems.length ? <span className="badge bad">{w.problems.length} problem(s)</span> : <span className="badge ok">valid</span>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="muted">No workflow yet: open <button className="link" onClick={() => navigate("/workflows/default")}>default</button> to start from the built-in order.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
