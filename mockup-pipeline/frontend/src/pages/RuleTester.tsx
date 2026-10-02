import { useEffect, useState } from "react";
import { api, ApiError } from "../api";

interface Evaluated { key: string; name: string; priority: number; matched: boolean; groups: { field: string; op: string; value: unknown; actual: unknown; holds: boolean }[][] }
interface Resolved { value: unknown; source: string; detail: string; unit: string }
interface TestOut {
  client: string | null;
  item_override: string | null;
  match: { status: string; pouch_type: string | null; candidates: string[]; evaluated: Evaluated[] };
  keyline: { template: string; pouch_type: string; fields: Record<string, Resolved>; issues: { code: string; field: string; message: string }[] } | null;
  keyline_version: number | null;
  materials: { surfaces: Record<string, Record<string, number>>; applied: Record<string, string[]> };
}

const SOURCE_BADGE: Record<string, string> = {
  item_override: "bad", client_override: "warn", pouch_type: "accent", measured: "ok", spec_table: "ok", default: "", disabled: "",
};

export default function RuleTester() {
  const [sheet, setSheet] = useState("");
  const [forced, setForced] = useState("");
  const [out, setOut] = useState<TestOut | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get<unknown>("/api/index/sample-spec").then((s) => setSheet(JSON.stringify(s, null, 1)));
  }, []);

  const run = async () => {
    setError("");
    try {
      setOut(await api.post<TestOut>("/api/index/test", { spec_sheet: JSON.parse(sheet), pouch_type: forced || null }));
    } catch (err) {
      setOut(null);
      setError(err instanceof ApiError ? err.message : String((err as Error).message));
    }
  };

  const status = out?.match.status;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Rule tester</h1>
          <div className="muted">Run pouch-type matching, keyline resolution and materials for a spec sheet against the current index. Preloaded with FGPO7215 as extracted in Phase 1.</div>
        </div>
      </div>
      <div className="grid2" style={{ alignItems: "start" }}>
        <div className="card stack">
          <h2>Spec sheet (JSON)</h2>
          <textarea className="code" style={{ minHeight: 360 }} value={sheet} onChange={(e) => setSheet(e.target.value)} spellCheck={false} />
          <div className="row">
            <input placeholder="force pouch type (optional)" value={forced} onChange={(e) => setForced(e.target.value)} />
            <button className="primary" onClick={run}>Run</button>
          </div>
          {error && <div className="msg bad">{error}</div>}
        </div>
        {out && (
          <div className="card stack">
            <h2>Pouch type</h2>
            <div className={`msg ${status === "matched" || status === "override" ? "ok" : "bad"}`}>
              {status === "matched" && <>Matched <b>{out.match.pouch_type}</b></>}
              {status === "override" && <>Item override forces <b>{out.match.pouch_type}</b></>}
              {status === "no_match" && <>No type matched → NEEDS_REVIEW with a type picker</>}
              {status === "ambiguous" && <>Several types matched ({out.match.candidates.join(", ")}) → NEEDS_REVIEW with a type picker</>}
            </div>
            <div className="small muted">Client settings: {out.client ?? "none"} · item override: {out.item_override ?? "none"}</div>
            <details>
              <summary>Rule evaluation</summary>
              <table>
                <thead><tr><th>Type</th><th>Prio</th><th>Conditions</th></tr></thead>
                <tbody>
                  {out.match.evaluated.map((e) => (
                    <tr key={e.key}>
                      <td>{e.matched ? <span className="badge ok">match</span> : <span className="badge">no</span>} {e.key}</td>
                      <td>{e.priority}</td>
                      <td className="small">
                        {e.groups.map((g, i) => (
                          <div key={i}>{i > 0 && <b>OR </b>}{g.map((c, j) => (
                            <span key={j} style={{ color: c.holds ? "var(--ok)" : "var(--bad)" }}>
                              {j > 0 && " AND "}{c.field} {c.op} {JSON.stringify(c.value)} <span className="muted">(is {JSON.stringify(c.actual)})</span>
                            </span>
                          ))}</div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        )}
      </div>
      {out?.keyline && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Resolved keyline · {out.keyline.template} v{out.keyline_version}</h2>
          {out.keyline.issues.length > 0 && <div className="msg bad">{out.keyline.issues.map((i) => <div key={i.field + i.code}>{i.field}: {i.message}</div>)}</div>}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Field</th><th>Value</th><th>Source</th><th>From</th></tr></thead>
              <tbody>
                {Object.entries(out.keyline.fields).map(([name, f]) => (
                  <tr key={name}>
                    <td><code>{name}</code></td>
                    <td>{f.value === null ? <span className="muted">—</span> : `${String(f.value)} ${f.unit && f.value !== null && typeof f.value === "number" ? f.unit : ""}`}</td>
                    <td><span className={`badge ${SOURCE_BADGE[f.source] ?? ""}`}>{f.source.replace("_", " ")}</span></td>
                    <td className="muted small"><code>{f.detail}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {out && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Materials</h2>
          <div className="grid2">
            {Object.entries(out.materials.surfaces).map(([surface, s]) => (
              <div key={surface}>
                <h3 style={{ marginTop: 0 }}>{surface} <span className="muted small">({out.materials.applied[surface].join(" → ")})</span></h3>
                <code className="small">{Object.entries(s).map(([k, v]) => `${k} ${v}`).join(" · ")}</code>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
