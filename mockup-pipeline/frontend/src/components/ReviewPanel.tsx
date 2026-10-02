// NEEDS_REVIEW forms (spec 4 / 6): the operator fixes the input, the job resumes from that step.
import { useState } from "react";
import { api, ApiError } from "../api";

type Dict = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Props { jobId: number; review: Dict; onDone: () => void }

const fileUrl = (jobId: number, key: string) => `/api/jobs/${jobId}/file?key=${encodeURIComponent(key)}`;

export default function ReviewPanel({ jobId, review, onDone }: Props) {
  const details: Dict = review.details ?? {};
  const form = details.form as string | undefined;
  return (
    <div className="card stack review">
      <div>
        <span className="badge warn">NEEDS REVIEW</span> <b>{review.message}</b>
        <div className="muted small">Paused at {review.node ? <>workflow node <code>{review.node}</code>{review.step && review.step !== review.node ? <> (step <code>{review.step}</code>)</> : null}</> : <>step <code>{review.step}</code></>}. Fix the input below; the job continues from there.</div>
      </div>
      {form === "workflow_review" && <WorkflowReviewForm jobId={jobId} d={details} onDone={onDone} />}
      {form === "specs" && <SpecsForm jobId={jobId} d={details} onDone={onDone} />}
      {form === "details" && (
        <>
          <div className="msg warn small">No dieline and no spec table were found in this PDF, so the whole page is used as the front artwork.
            Enter the pouch details below (type, width, height, gusset); the page's extra size around the pouch is treated as bleed.</div>
          <SpecsForm jobId={jobId} d={details} onDone={onDone} details />
        </>
      )}
      {form === "pouch_type" && <PouchTypeForm jobId={jobId} d={details} onDone={onDone} />}
      {form === "keyline" && <KeylineForm jobId={jobId} d={details} onDone={onDone} />}
      {form === "panels" && <PanelsForm jobId={jobId} d={details} onDone={onDone} />}
      {form === "texture" && <TextureForm jobId={jobId} d={details} onDone={onDone} />}
      {!form && (
        <div className="msg warn">
          This PDF cannot be processed as it is ({review.code}). Re-export it from ArtPro+ with the expected layers and TrimBox, then upload it again.
          {details.problems && <ul>{details.problems.map((p: Dict) => <li key={p.code}>{p.message}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}

function useSubmit(jobId: number, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (body: Dict) => {
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/jobs/${jobId}/review`, body);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

// ---------------------------------------------------------------- workflow REVIEW node
function WorkflowReviewForm({ jobId, d, onDone }: { jobId: number; d: Dict; onDone: () => void }) {
  const choices: { edge: string; label: string }[] = d.choices ?? [];
  const [edge, setEdge] = useState(choices.length === 1 ? choices[0].edge : "");
  const [note, setNote] = useState("");
  const { busy, error, submit } = useSubmit(jobId, onDone);
  return (
    <div className="stack">
      {d.message && <div className="msg warn">{d.message}</div>}
      <div className="muted small">A person checks the job here{choices.length > 1 ? " and picks how it continues" : ""}. Look at the tabs below (specs, keyline, panels), then continue.</div>
      {choices.length > 1 && (
        <div className="stack">
          {choices.map((c) => <label key={c.edge} className="check"><input type="radio" name="branch" checked={edge === c.edge} onChange={() => setEdge(c.edge)} /> {c.label}</label>)}
        </div>
      )}
      <input placeholder="Note (kept in the log)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="row"><button className="primary" disabled={busy || (choices.length > 1 && !edge)} onClick={() => submit({ action: "workflow_review", node: d.node, edge: edge || null, note })}>{choices.length ? "Continue" : "Reviewed, finish the job"}</button></div>
      {error && <div className="msg bad">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- specs
const BOOL_FIELDS = new Set(["zipper", "round_corner", "transparent_window", "butterfly_notch", "zipper_line_drawn"]);
const OPTIONS: Record<string, string[]> = {
  gusset_type: ["Bottom", "Side", "None", "Yes"],
  finish: ["matt", "gloss", "matt+spot gloss", "gloss+spot matt"],
  pouch_or_roll_form: ["Pouch Form", "Roll Form"],
  sealing_type: ["Stand-up", "3 Side Seal", "Center Seal", "Pillow", "Side Gusset", "Flat Bottom", "Quad Seal", "Spout", "Shaped", "NA"],
  tear_notch: ["V Notch", "Straight Notch", "Laser Score", "Yes", "No", "NA"],
};

function display(name: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (name === "layers" && Array.isArray(value)) return value.map((l: Dict) => `${l.micron ?? ""} mic ${l.material}`.trim()).join(" / ");
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function parse(name: string, text: string, kind: "num" | "bool" | "list" | "text"): unknown {
  if (text.trim() === "") return kind === "list" || name === "layers" ? [] : null; // a blank list field is an empty list, never null
  if (name === "layers") {
    return text.split("/").map((part) => {
      const m = part.trim().match(/^(\d+(?:[.,]\d+)?)\s*mic\w*\s+(.+)$/i);
      return m ? { micron: Number(m[1].replace(",", ".")), material: m[2].trim() } : { micron: null, material: part.trim() };
    });
  }
  if (kind === "bool") return text === "true";
  if (kind === "num") return Number(text);
  if (kind === "list") return text.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s));
  return text;
}

function kindOf(name: string, value: unknown): "num" | "bool" | "list" | "text" {
  if (BOOL_FIELDS.has(name) || typeof value === "boolean") return "bool";
  if (Array.isArray(value) || name.endsWith("segments_mm") || name === "inks") return "list";
  if (typeof value === "number" || name.endsWith("_mm") || ["teeth", "colour_count", "ar_ups", "ac_ups"].includes(name)) return "num";
  return "text";
}

function CellCrop({ jobId, imageKey, bbox }: { jobId: number; imageKey: string; bbox: number[] | null }) {
  if (!bbox) return null;
  const [x0, y0, x1, y1] = bbox;
  const pad = 12, w = x1 - x0 + 2 * pad, h = y1 - y0 + 2 * pad;
  const scale = Math.min(1, 320 / w, 60 / h);
  return (
    <div className="cellcrop" style={{ width: w * scale, height: h * scale }}>
      <div style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: "0 0",
        backgroundImage: `url(${fileUrl(jobId, imageKey)})`, backgroundPosition: `${-(x0 - pad)}px ${-(y0 - pad)}px` }} />
    </div>
  );
}

// The pouch details an operator enters for a plain artwork PDF (no table to read them from).
const DETAIL_FIELDS = [
  "client_name", "item_no", "pouch_or_roll_form", "sealing_type", "gusset_type", "pouch_closed_width_mm", "pouch_height_mm",
  "gusset_full_width_mm", "pouch_open_width_mm", "sealing_width_mm", "zipper", "tear_notch", "round_corner", "finish",
];

function SpecsForm({ jobId, d, onDone, details = false }: { jobId: number; d: Dict; onDone: () => void; details?: boolean }) {
  const issues: Dict[] = d.issues ?? [];
  const sheet: Dict = d.sheet;
  const cells: Dict = d.cells ?? {};
  const flagged = new Set(issues.filter((i) => i.severity === "review").map((i) => i.field));
  // Every flagged field of the sheet, plus fields named in issues (a details form: the pouch details in order)
  const fields: { path: string; part: string; name: string; value: unknown; confidence: number }[] = [];
  for (const part of ["spec_table", "measured_keyline"]) {
    for (const [name, f] of Object.entries(sheet[part] as Dict)) {
      if (!f || typeof f !== "object" || !("value" in f)) continue;
      const path = part === "spec_table" ? name : `measured_keyline.${name}`;
      const wanted = details ? part === "spec_table" && DETAIL_FIELDS.includes(name)
        : flagged.has(path) || (part === "spec_table" && issues.some((i) => i.field === name));
      if (wanted) fields.push({ path: `${part}.${name}`, part, name, value: f.value, confidence: f.confidence });
    }
  }
  if (details) fields.sort((a, b) => DETAIL_FIELDS.indexOf(a.name) - DETAIL_FIELDS.indexOf(b.name));
  // Checks a value edit may not resolve (TrimBox vs size, dieline vs table, ...): the operator accepts them explicitly.
  const structural = issues.filter((i) => i.severity === "review" && !["low_confidence", "missing"].includes(i.code));
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.path, display(f.name, f.value)])));
  const [ack, setAck] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  const { busy, error, submit } = useSubmit(jobId, onDone);

  const allFields = Object.entries(sheet.spec_table as Dict).filter(([n]) => !fields.some((f) => f.name === n));
  const send = () => {
    const corrections: Dict = {};
    for (const [path, text] of Object.entries(values)) {
      const name = path.split(".")[1];
      const orig = fields.find((f) => f.path === path)?.value ?? (sheet.spec_table as Dict)[name]?.value;
      corrections[path] = parse(name, text, kindOf(name, orig));
    }
    const acknowledge = structural.filter((i) => ack[`${i.code}@${i.field}`]).map((i) => `${i.code}@${i.field}`);
    submit({ action: "specs", corrections, acknowledge });
  };
  const missingAck = structural.some((i) => !ack[`${i.code}@${i.field}`]);

  const input = (path: string, name: string, orig: unknown) => {
    const kind = kindOf(name, orig);
    const v = values[path] ?? "";
    const set = (s: string) => setValues({ ...values, [path]: s });
    if (kind === "bool") return <select value={v} onChange={(e) => set(e.target.value)}><option value="">—</option><option value="true">Yes</option><option value="false">No</option></select>;
    if (OPTIONS[name]) return <select value={v} onChange={(e) => set(e.target.value)}><option value="">—</option>{OPTIONS[name].map((o) => <option key={o}>{o}</option>)}</select>;
    return <input value={v} onChange={(e) => set(e.target.value)} />;
  };

  return (
    <div className="stack">
      <div className="table-wrap">
        <table>
          <thead><tr><th>Field</th><th>As printed</th><th>Read</th><th>Value (confirm or correct)</th><th>Problem</th></tr></thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.path}>
                <td><code>{f.name}</code>{f.part === "measured_keyline" && <div className="muted small">dieline</div>}</td>
                <td>{cells[f.name] ? <CellCrop jobId={jobId} imageKey={d.spec_image_key} bbox={cells[f.name].bbox_px} /> : <span className="muted small">see dimension drawing</span>}</td>
                <td className="small"><span className={`badge ${f.confidence >= 0.85 ? "ok" : "warn"}`}>{Math.round(f.confidence * 100)}%</span></td>
                <td style={{ minWidth: 200 }}>{input(f.path, f.name, f.value)}</td>
                <td className="small">{issues.filter((i) => f.path.endsWith(i.field) || i.field === f.name).map((i) => <div key={i.code}>{i.message}</div>)}</td>
              </tr>
            ))}
            {showAll && allFields.map(([name, f]: [string, Dict]) => (
              <tr key={name}>
                <td><code>{name}</code></td>
                <td>{cells[name] ? <CellCrop jobId={jobId} imageKey={d.spec_image_key} bbox={cells[name].bbox_px} /> : null}</td>
                <td className="small"><span className="badge ok">{Math.round((f.confidence ?? 0) * 100)}%</span></td>
                <td>{values[`spec_table.${name}`] === undefined
                  ? <button className="link" onClick={() => setValues({ ...values, [`spec_table.${name}`]: display(name, f.value) })}>{display(name, f.value) || "—"} ✎</button>
                  : input(`spec_table.${name}`, name, f.value)}</td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="link" style={{ alignSelf: "flex-start" }} onClick={() => setShowAll(!showAll)}>{showAll ? "Hide" : "Show"} all other fields</button>
      {structural.length > 0 && (
        <div className="stack">
          <b>Checks that cannot be corrected by editing a value</b>
          {structural.map((i) => (
            <label key={i.code + i.field} className="check"><input type="checkbox" checked={!!ack[`${i.code}@${i.field}`]} onChange={(e) => setAck({ ...ack, [`${i.code}@${i.field}`]: e.target.checked })} /> Accept: {i.message}</label>
          ))}
        </div>
      )}
      <div className="row">
        <a className="small" href={fileUrl(jobId, d.spec_image_key)} target="_blank" rel="noreferrer">Open spec table image</a>
        <a className="small" href={fileUrl(jobId, d.dimension_image_key)} target="_blank" rel="noreferrer">Open dimension drawing</a>
        <button className="primary" style={{ marginLeft: "auto" }} disabled={busy || missingAck} onClick={send}>Confirm values and continue</button>
      </div>
      {error && <div className="msg bad">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- pouch type
function PouchTypeForm({ jobId, d, onDone }: { jobId: number; d: Dict; onDone: () => void }) {
  const all: Record<string, string> = d.all_types ?? {};
  const candidates: string[] = d.candidates ?? [];
  const [pick, setPick] = useState(candidates[0] ?? "");
  const { busy, error, submit } = useSubmit(jobId, onDone);
  return (
    <div className="stack">
      <div className="grid2">
        {Object.entries(all).map(([key, name]) => (
          <label key={key} className="check card" style={{ padding: 10 }}>
            <input type="radio" name="pt" checked={pick === key} onChange={() => setPick(key)} />
            <span><b>{name}</b> <code className="small">{key}</code> {candidates.includes(key) && <span className="badge accent">matched</span>}</span>
          </label>
        ))}
      </div>
      <div className="row"><button className="primary" disabled={!pick || busy} onClick={() => submit({ action: "pouch_type", pouch_type: pick })}>Use this pouch type</button></div>
      {error && <div className="msg bad">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- keyline
function KeylineForm({ jobId, d, onDone }: { jobId: number; d: Dict; onDone: () => void }) {
  const issues: Dict[] = d.issues ?? [];
  const names = issues.map((i) => String(i.field).replace("keyline.", ""));
  const fields: Dict = d.keyline?.fields ?? {};
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(names.map((n) => [n, String(fields[n]?.value ?? "")])));
  const { busy, error, submit } = useSubmit(jobId, onDone);
  return (
    <div className="stack">
      <table>
        <thead><tr><th>Field</th><th>Resolved</th><th>Problem</th><th>Value for this job</th></tr></thead>
        <tbody>
          {issues.map((i, k) => (
            <tr key={k}><td><code>{names[k]}</code></td><td>{String(fields[names[k]]?.value)} <span className="muted small">{fields[names[k]]?.source}</span></td>
              <td className="small">{i.message}</td>
              <td><input value={values[names[k]]} onChange={(e) => setValues({ ...values, [names[k]]: e.target.value })} /></td></tr>
          ))}
        </tbody>
      </table>
      <div className="muted small">To fix it for every job, change the keyline template in the index and rerun from resolve_keyline.</div>
      <div className="row"><button className="primary" disabled={busy} onClick={() => submit({
        action: "keyline", keyline_overrides: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === "" ? null : isNaN(Number(v)) ? v : Number(v)])),
      })}>Use these values</button></div>
      {error && <div className="msg bad">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- panels
function PanelsForm({ jobId, d, onDone }: { jobId: number; d: Dict; onDone: () => void }) {
  const missing: Dict[] = d.missing ?? [];
  const [choices, setChoices] = useState<Record<string, Dict>>(() =>
    Object.fromEntries(missing.map((m) => [m.role, m.role === "back" ? { substitute: "front" } : { substitute: "plain", color: d.default_color ?? "#dddddd" }])));
  const [uploading, setUploading] = useState("");
  const { busy, error, submit } = useSubmit(jobId, onDone);

  const uploadPanel = async (role: string, file: File) => {
    setUploading(role);
    const form = new FormData();
    form.append("role", role);
    form.append("file", file);
    const res = await fetch(`/api/jobs/${jobId}/panel-file`, { method: "POST", body: form, headers: { "X-Requested-With": "fetch" }, credentials: "same-origin" });
    setUploading("");
    if (res.ok) onDone();
  };

  return (
    <div className="stack">
      <div className="muted small">Upload the missing panel PDF, or continue with a substitute. Uploading the PDF from the Upload page also resumes this job automatically.</div>
      <table>
        <thead><tr><th>Panel</th><th>Linked code</th><th>Size</th><th>Upload PDF</th><th>…or substitute</th></tr></thead>
        <tbody>
          {missing.map((m) => {
            const c = choices[m.role];
            return (
              <tr key={m.role}>
                <td><b>{m.role}</b></td>
                <td>{m.code ?? <span className="muted">not in remarks</span>}</td>
                <td className="muted small">{m.expected_mm ? `${m.expected_mm[0]} × ${m.expected_mm[1]} mm` : ""}</td>
                <td><input type="file" accept=".pdf" disabled={!!uploading} onChange={(e) => e.target.files?.[0] && uploadPanel(m.role, e.target.files[0])} />{uploading === m.role && " uploading…"}</td>
                <td className="row">
                  <select value={c.substitute} onChange={(e) => setChoices({ ...choices, [m.role]: { ...c, substitute: e.target.value } })}>
                    <option value="front">Same artwork as front</option>
                    <option value="plain">Plain film colour</option>
                  </select>
                  {c.substitute === "plain" && <input type="color" value={c.color ?? "#dddddd"} onChange={(e) => setChoices({ ...choices, [m.role]: { ...c, color: e.target.value } })} aria-label="colour" />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row"><button className="primary" disabled={busy} onClick={() => submit({ action: "panels", panel_choices: choices, note: "substitutes for missing panels" })}>Continue with substitutes</button></div>
      {error && <div className="msg bad">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- technical marks
function TextureForm({ jobId, d, onDone }: { jobId: number; d: Dict; onDone: () => void }) {
  const issues: Dict[] = d.issues ?? [];
  const previews: Record<string, string> = d.previews ?? {};
  const { busy, error, submit } = useSubmit(jobId, onDone);
  return (
    <div className="stack">
      <div className="grid2">
        {Object.entries(previews).map(([role, key]) => (
          <figure key={role} style={{ margin: 0 }}>
            <img src={fileUrl(jobId, key)} alt={`${role} technical marks`} style={{ width: "100%", borderRadius: 6 }} />
            <figcaption className="small muted">{role}: flagged pixels in magenta (already masked in the texture)</figcaption>
          </figure>
        ))}
      </div>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => submit({ action: "texture", acknowledge: issues.map((i) => `${i.code}@${i.field}`) })}>Masked result is fine, continue</button>
        <span className="muted small">Otherwise fix the artwork layer in ArtPro+ and upload the PDF again.</span>
      </div>
      {error && <div className="msg bad">{error}</div>}
    </div>
  );
}
