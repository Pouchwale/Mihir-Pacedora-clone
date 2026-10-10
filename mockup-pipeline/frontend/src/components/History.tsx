import { useEffect, useState } from "react";
import { api, ApiError, VersionMeta } from "../api";
import { useSession } from "../App";
import { formatTime } from "../util";
import Changes from "./Changes";

export default function History({ kind, entryKey, current, onRestored }: { kind: string; entryKey: string; current: number; onRestored: () => void }) {
  const { canEdit } = useSession();
  const editable = canEdit(kind);
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [diff, setDiff] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.get<VersionMeta[]>(`/api/index/${kind}/${entryKey}/history`).then(setVersions);
  }, [kind, entryKey, current]);

  useEffect(() => {
    if (selected === null) return;
    const base = selected === current ? Math.max(1, current - 1) : selected;
    api.get<string>(`/api/index/${kind}/${entryKey}/diff?a=${base}&b=${current}`).then(setDiff);
  }, [selected, kind, entryKey, current]);

  const restore = async () => {
    setError("");
    try {
      await api.post(`/api/index/${kind}/${entryKey}/restore`, { version: selected, reason: reason || `restore version ${selected}` });
      setSelected(null);
      setReason("");
      onRestored();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <div className="grid2" style={{ alignItems: "start" }}>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Version</th><th>Change</th><th>By</th><th>When</th></tr></thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version} className="clickable" onClick={() => setSelected(v.version)} style={selected === v.version ? { outline: "2px solid var(--accent)" } : undefined}>
                <td>v{v.version} {v.version === current && <span className="badge ok">current</span>}</td>
                <td>
                  <span className="badge">{v.action}</span> {v.reason}
                  {!!v.changes?.length && <div className="small muted">{v.changes.length} value{v.changes.length === 1 ? "" : "s"} changed</div>}
                </td>
                <td className="muted">{v.author}</td>
                <td className="muted small">{formatTime(v.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card stack">
        {selected === null ? (
          <span className="muted">Select a version to compare it with the current one.</span>
        ) : (
          <>
            <h2>{selected === current ? `Changes in v${current}` : `v${selected} → current (v${current})`}</h2>
            {(() => {
              const v = versions.find((x) => x.version === selected);
              return v?.changes ? (
                <div>
                  <div className="small muted" style={{ marginBottom: 4 }}>What v{selected} changed (new values in bold), by {v.author}:</div>
                  <Changes changes={v.changes} />
                </div>
              ) : null;
            })()}
            <details><summary className="small muted">Full YAML diff</summary><Diff text={diff} /></details>
            {editable && selected !== current && (
              <div className="row">
                <input style={{ flex: 1 }} placeholder={`Reason (default: restore version ${selected})`} value={reason} onChange={(e) => setReason(e.target.value)} />
                <button className="primary" onClick={restore}>Restore v{selected}</button>
              </div>
            )}
            {error && <div className="msg bad">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}

export function Diff({ text }: { text: string }) {
  if (!text) return <span className="muted">No differences.</span>;
  return (
    <pre className="diff">
      {text.split("\n").map((line, i) => (
        <div key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : ""}>{line || " "}</div>
      ))}
    </pre>
  );
}
