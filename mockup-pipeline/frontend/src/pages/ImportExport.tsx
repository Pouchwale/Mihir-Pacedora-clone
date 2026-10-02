import { useState } from "react";
import { api, ApiError } from "../api";
import { useSession } from "../App";
import { Diff } from "../components/History";

interface Plan { applied: boolean; created: string[]; updated: string[]; unchanged: string[]; archived: string[]; diffs: Record<string, string> }

export default function ImportExport() {
  const { isAdmin, refreshKinds } = useSession();
  const [text, setText] = useState("");
  const [archiveMissing, setArchiveMissing] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reason, setReason] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setProblems([]);
    try {
      const p = await api.post<Plan>("/api/index/import", { yaml: text, archive_missing: archiveMissing, dry_run: dryRun, reason });
      setPlan(p);
      if (!dryRun) refreshKinds();
    } catch (err) {
      setPlan(null);
      setProblems(err instanceof ApiError && err.problems.length ? err.problems : [String((err as Error).message)]);
    } finally {
      setBusy(false);
    }
  };

  const changed = plan ? plan.created.length + plan.updated.length + plan.archived.length : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>YAML import / export</h1>
          <div className="muted">Export the whole current index as one YAML file. Importing validates the entire file first; nothing is written unless every entry is valid and consistent.</div>
        </div>
        <a className="btn" href="/api/index/export" download>Download index.yaml</a>
      </div>
      {isAdmin ? (
        <div className="card stack">
          <div className="row">
            <input type="file" accept=".yaml,.yml" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setText(await f.text()); setPlan(null); } }} />
            <label className="check small"><input type="checkbox" checked={archiveMissing} onChange={(e) => setArchiveMissing(e.target.checked)} /> Archive entries that are not in the file</label>
          </div>
          <textarea className="code" style={{ minHeight: 260 }} placeholder="…or paste YAML here" value={text} onChange={(e) => { setText(e.target.value); setPlan(null); }} spellCheck={false} />
          <div className="row"><button onClick={() => run(true)} disabled={!text.trim() || busy}>Check (dry run)</button></div>
          {problems.length > 0 && <div className="msg bad">Import rejected:<ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
          {plan && (
            <div className="stack">
              <div className={`msg ${plan.applied ? "ok" : "warn"}`}>
                {plan.applied ? "Imported: " : "Would change: "}
                {plan.created.length} new, {plan.updated.length} updated, {plan.archived.length} archived, {plan.unchanged.length} unchanged.
              </div>
              {Object.entries(plan.diffs).map(([name, d]) => (
                <details key={name}><summary><code>{name}</code></summary><Diff text={d} /></details>
              ))}
              {!plan.applied && changed > 0 && (
                <div className="savebar">
                  <input placeholder="Reason (required; stored on every new version)" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <button className="primary" disabled={!reason.trim() || busy} onClick={() => run(false)}>Apply import</button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="msg warn">Only administrators can import.</div>
      )}
    </>
  );
}
