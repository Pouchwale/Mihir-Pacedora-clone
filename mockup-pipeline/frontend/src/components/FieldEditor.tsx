// Field dictionary entry (index kind field): what is printed, how it is read, what it means for a
// job, and a tester that reads a PDF with the current dictionary plus this unsaved entry.
import { useState } from "react";
import { useParams } from "react-router-dom";

type Data = Record<string, unknown>;
type Dict = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const KINDS = ["text", "number", "integer", "yes_no", "option", "film", "code", "date"];
const SOURCES: [string, string][] = [["spec_table", "Spec table (printed label)"], ["ink_row", "Ink row (colour dots)"], ["dieline", "Dieline"], ["derived", "Derived from other fields"]];

const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : "");
const parseList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export default function FieldEditor({ data, onChange }: { data: Data; onChange: (d: Data) => void }) {
  const { key = "" } = useParams();
  const set = (k: string, v: unknown) => onChange({ ...data, [k]: v });
  const num = (k: string) => (data[k] === null || data[k] === undefined ? "" : String(data[k]));
  const setNum = (k: string, s: string) => set(k, s.trim() === "" ? null : Number(s));
  const options = (data.options ?? []) as string[];
  const synonyms = (data.synonyms ?? {}) as Record<string, string[]>;
  const stop = Boolean(data.stop);
  const source = String(data.source ?? "spec_table");

  return (
    <div className="stack">
      <div className="card grid2">
        <label className="field">Name (admin UI)<input value={String(data.name ?? "")} onChange={(e) => set("name", e.target.value)} /></label>
        <label className="field">Printed label (as on the sheet)<input value={String(data.label ?? "")} onChange={(e) => set("label", e.target.value)} placeholder="Pouch height:" disabled={source !== "spec_table" && !stop} /></label>
        <label className="field" style={{ gridColumn: "1 / -1" }}>Label variants (other printings, comma separated)
          <input defaultValue={list(data.aliases)} onBlur={(e) => set("aliases", parseList(e.target.value))} placeholder="Inside B2B Width:, In-B2B Width:" /></label>
        <label className="field">Where it comes from
          <select value={source} onChange={(e) => set("source", e.target.value)}>{SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="field">Order in the table (top to bottom)<input type="number" value={num("order")} onChange={(e) => setNum("order", e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={stop} onChange={(e) => set("stop", e.target.checked)} /> Stop label only (ends the previous value, stores nothing)</label>
        <label className="check"><input type="checkbox" checked={Boolean(data.section)} onChange={(e) => set("section", e.target.checked)} /> Starts a block of the table</label>
      </div>

      {!stop && (
        <div className="card grid2">
          <label className="field">Value kind<select value={String(data.kind ?? "text")} onChange={(e) => set("kind", e.target.value)}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></label>
          <label className="field">Unit<input value={String(data.unit ?? "")} onChange={(e) => set("unit", e.target.value)} placeholder="mm" /></label>
          <label className="field">Minimum<input type="number" value={num("min")} onChange={(e) => setNum("min", e.target.value)} /></label>
          <label className="field">Maximum<input type="number" value={num("max")} onChange={(e) => setNum("max", e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={Boolean(data.required)} onChange={(e) => set("required", e.target.checked)} /> Required: a job cannot continue without it</label>
          <label className="check"><input type="checkbox" checked={Boolean(data.optional ?? true)} onChange={(e) => set("optional", e.target.checked)} /> A blank cell is a valid answer</label>
          <label className="field">Minimum confidence (empty = validation rules)<input type="number" step="0.01" min={0} max={1} value={num("min_confidence")} onChange={(e) => setNum("min_confidence", e.target.value)} /></label>
          <label className="field">Confirm with the file name
            <select value={String(data.confirm_with_filename ?? "")} onChange={(e) => set("confirm_with_filename", e.target.value || null)}>
              <option value="">no</option><option value="stem">equals the file name</option><option value="code">equals the item code</option>
            </select></label>
          <label className="check"><input type="checkbox" checked={Boolean(data.multiline)} onChange={(e) => set("multiline", e.target.checked)} /> Value continues on following rows</label>
          <label className="field">Characters to keep (normally stripped)<input value={String(data.keep_chars ?? "")} onChange={(e) => set("keep_chars", e.target.value)} /></label>
          <label className="field" style={{ gridColumn: "1 / -1" }}>Description<input value={String(data.description ?? "")} onChange={(e) => set("description", e.target.value)} /></label>
        </div>
      )}

      {!stop && data.kind === "option" && (
        <div className="card stack">
          <h2>Options and synonyms</h2>
          <label className="field">Canonical options (comma separated; what rules and the 3D build see)
            <input defaultValue={list(options)} onBlur={(e) => { const opts = parseList(e.target.value); set("options", opts); }} /></label>
          <table className="kl-table">
            <thead><tr><th>Option</th><th>Also printed as (comma separated)</th></tr></thead>
            <tbody>
              {options.map((o) => (
                <tr key={o}><td><code>{o}</code></td>
                  <td><input defaultValue={list(synonyms[o])} onBlur={(e) => { const next = { ...synonyms }; const v = parseList(e.target.value); if (v.length) next[o] = v; else delete next[o]; set("synonyms", next); }} placeholder="e.g. Standy, Stand up" /></td></tr>
              ))}
            </tbody>
          </table>
          <div className="muted small">A cell that reads as a synonym is stored as its canonical option.</div>
        </div>
      )}

      <FieldTester entryKey={key} entry={data} />
    </div>
  );
}

interface TestRow { key: string; name: string; label: string; value: unknown; confidence: number; raw: string | null; source: string; format_ok: boolean; reason: string; crop: string | null; threshold: number; required: boolean }
interface TestOut { filename: string; mode: string; text_source: string; roll_form: boolean; fields: TestRow[]; linked_codes: Record<string, string>; inks: string[]; issues: Dict[] }

export function FieldTester({ entryKey, entry }: { entryKey?: string; entry?: Data }) {
  const [out, setOut] = useState<TestOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [onlyMine, setOnlyMine] = useState(!!entryKey);

  const run = async (file: File) => {
    setBusy(true);
    setError("");
    const form = new FormData();
    form.append("file", file);
    if (entryKey && entry && !entry.stop) form.append("fields", JSON.stringify({ [entryKey]: entry }));
    try {
      const res = await fetch("/api/index/test-fields", { method: "POST", body: form, headers: { "X-Requested-With": "fetch" }, credentials: "same-origin" });
      const body = await res.json();
      if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : (body.detail?.problems ?? []).join("; ") || JSON.stringify(body.detail));
      setOut(body);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const rows = out ? out.fields.filter((r) => !onlyMine || !entryKey || r.key === entryKey) : [];
  const show = (v: unknown) => (v === null || v === undefined ? "—" : Array.isArray(v) ? v.join(" / ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Test with a PDF</h2>
        <label className="btn" style={{ cursor: "pointer" }}>{busy ? "Reading…" : "Choose an approval PDF"}<input type="file" accept=".pdf" hidden disabled={busy} onChange={(e) => e.target.files?.[0] && run(e.target.files[0])} /></label>
      </div>
      <div className="muted small">Reads the spec table with the current dictionary{entryKey ? " plus this entry as edited (unsaved)" : ""}: value, confidence and the cell as printed, for every field.</div>
      {error && <div className="msg bad">{error}</div>}
      {out && (
        <>
          <div className="row small">
            <span className="badge">{out.mode}</span><span className="badge">{out.text_source}</span>{out.roll_form && <span className="badge accent">roll form</span>}
            <span className="muted">{out.filename} · inks: {out.inks.join(", ") || "—"} · linked codes: {Object.entries(out.linked_codes).map(([r, c]) => `${r}=${c}`).join(", ") || "—"}</span>
            {entryKey && <label className="check small" style={{ marginLeft: "auto" }}><input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> only this field</label>}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Field</th><th>As printed</th><th>Read</th><th>Value</th><th>Source</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} style={r.key === entryKey ? { outline: "2px solid var(--accent)" } : undefined}>
                    <td><b>{r.name}</b><div className="muted small"><code>{r.key}</code>{r.required && " · required"}</div></td>
                    <td>{r.crop ? <img src={r.crop} alt={r.key} style={{ maxWidth: 320, maxHeight: 64, border: "1px solid var(--border)", borderRadius: 4, background: "#fff" }} /> : <span className="muted small">{r.label || "no label"}</span>}</td>
                    <td><span className={`badge ${r.confidence >= r.threshold ? "ok" : "warn"}`}>{Math.round(r.confidence * 100)}%</span>{!r.format_ok && <div className="small" style={{ color: "var(--bad)" }}>{r.reason || "format"}</div>}</td>
                    <td>{show(r.value)}{r.raw && r.raw !== String(r.value) && <div className="muted small">raw: {r.raw}</div>}</td>
                    <td className="muted small">{r.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {out.issues.length > 0 && <div className="small muted">Validation: {out.issues.map((i) => `${i.field} ${i.code}`).join(" · ")}</div>}
        </>
      )}
    </div>
  );
}
