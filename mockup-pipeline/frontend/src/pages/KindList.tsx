import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { api, EntrySummary } from "../api";
import { useSession } from "../App";
import { formatTime } from "../util";

type Dict = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const HELP: Record<string, string> = {
  field: "Every value read from an approval PDF: its printed label and variants, how it is read (kind, options, synonyms, range), whether a job needs it and the confidence it must reach. The OCR template is built from this list.",
  pouch_catalog: "The hierarchy Form → Style → Sealing type that groups the pouch types.",
  pouch_type: "Match rules decide the pouch type of a job, in priority order. A type = geometry template + rules + required panels + keyline template, placed in the catalog.",
  keyline_template: "Keyline values per pouch type: unit, default, range, and where each value comes from (formula, measured dieline, spec table).",
  standard_size: "Standard finished sizes. Validation warns when a job matches none and names the nearest; tolerances live in Validation rules.",
  output_preset: "Camera views, resolution, background, lighting, file formats and naming of the renders. One preset is the default.",
  material: "Finish and film layers → PBR material settings per surface (base, white-less metal, window, spot varnish), with a preview sphere.",
  client: "Per-client settings: default output preset, eyemarks in the texture, keyline overrides.",
  item_override: "Per-item overrides (key = item code in lowercase, e.g. fgpo7215): forced pouch type, keyline values, preset, saved job-page adjustments.",
};

export default function KindList() {
  const { kind = "" } = useParams();
  const { kinds, isAdmin } = useSession();
  const info = kinds.find((k) => k.kind === kind);
  const [rows, setRows] = useState<EntrySummary[]>([]);
  const [catalog, setCatalog] = useState<Dict | null>(null);
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    if (kind === "workflow") return;
    api.get<EntrySummary[]>(`/api/index/${kind}?include_archived=${archived}`).then(setRows);
    setCreating(false);
    if (kind === "pouch_type") api.get<Dict>("/api/index/pouch_catalog/default").then((e) => setCatalog(e.data)).catch(() => setCatalog(null));
  }, [kind, archived]);

  if (info?.page) return <Navigate to={info.page} replace />;

  const create = () => {
    const key = newKey.trim().toLowerCase().replace(/\s+/g, "_");
    if (!key) return;
    navigate(`/index/${kind}/${key}`, { state: { isNew: true, copyFrom: copyFrom || null } });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{info?.label ?? kind}</h1>
          <div className="muted">{HELP[kind]}</div>
        </div>
        <div className="row">
          <label className="check small muted"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> show archived</label>
          {isAdmin && <button className="primary" onClick={() => setCreating(!creating)}>New</button>}
        </div>
      </div>
      {creating && (
        <div className="card row" style={{ marginBottom: 14 }}>
          <label className="field">Key (lowercase, _ or -)<input autoFocus value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder={kind === "item_override" ? "fgpo7215" : kind === "field" ? "pouch_height_mm (a spec table column)" : "my_new_entry"} /></label>
          <label className="field">Start from
            <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
              <option value="">{kind === "keyline_template" || kind === "pouch_type" ? "— pick one to copy —" : "empty"}</option>
              {rows.map((r) => <option key={r.key} value={r.key}>{r.name} ({r.key})</option>)}
            </select>
          </label>
          <button className="primary" style={{ alignSelf: "flex-end" }} onClick={create} disabled={!newKey.trim()}>Continue</button>
        </div>
      )}
      {kind === "pouch_type" && catalog ? <CatalogGroups rows={rows} catalog={catalog} onOpen={(k) => navigate(`/index/${kind}/${k}`)} />
        : kind === "field" ? <FieldTable rows={rows} onOpen={(k) => navigate(`/index/${kind}/${k}`)} />
          : (
            <div className="card table-wrap" style={{ padding: 0 }}>
              <table>
                <thead><tr><th>Name</th><th>Key</th>{kind === "standard_size" && <th>Size</th>}<th>Version</th><th>Last change</th><th>By</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="clickable" onClick={() => navigate(`/index/${kind}/${r.key}`)}>
                      <td>{r.name} {r.archived && <span className="badge warn">archived</span>}</td>
                      <td><code>{r.key}</code></td>
                      {kind === "standard_size" && <td className="muted">{r.extra?.width_mm as number} × {r.extra?.height_mm as number} mm{r.extra?.gusset_mm ? `, gusset ${r.extra.gusset_mm}` : ""}{r.extra?.pouch_type ? ` · ${r.extra.pouch_type}` : ""}</td>}
                      <td>v{r.version}</td>
                      <td className="muted">{formatTime(r.updated_at)}</td>
                      <td className="muted">{r.author}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={6} className="muted">No entries yet.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
    </>
  );
}

function CatalogGroups({ rows, catalog, onOpen }: { rows: EntrySummary[]; catalog: Dict; onOpen: (key: string) => void }) {
  const forms: Dict[] = catalog.forms ?? [];
  const styles: Dict[] = catalog.styles ?? [];
  const sealing: Dict[] = catalog.sealing_types ?? [];
  const placed = new Set<string>();
  const card = (r: EntrySummary) => {
    placed.add(r.key);
    const x = r.extra ?? {};
    return (
      <div key={r.key} className="catalog-card clickable" onClick={() => onOpen(r.key)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(r.key)}>
        {x.thumbnail ? <img src={String(x.thumbnail)} alt="" /> : <div className="catalog-thumb">{String(x.geometry_template ?? "").replace(/_/g, " ")}</div>}
        <div><b>{r.name}</b> {r.archived && <span className="badge warn">archived</span>}{x.active === false && <span className="badge">inactive</span>}
          <div className="muted small"><code>{r.key}</code> · priority {String(x.priority ?? "")} · v{r.version}</div></div>
      </div>
    );
  };
  return (
    <div className="stack">
      {forms.map((f) => (
        <div key={f.key} className="card stack">
          <h2>{f.name} <span className="muted small">{f.description}</span></h2>
          {styles.filter((s) => s.form === f.key).map((s) => (
            <div key={s.key} className="catalog-style">
              <h3 style={{ margin: "4px 0" }}>{s.name}</h3>
              {sealing.filter((t) => t.style === s.key).map((t) => {
                const types = rows.filter((r) => r.extra?.sealing_type === t.key);
                return (
                  <div key={t.key} className="catalog-sealing">
                    <div className="small muted">{t.name}{t.printed?.length ? <> · printed as {t.printed.join(", ")}</> : null}</div>
                    <div className="catalog-grid">{types.map(card)}{types.length === 0 && <span className="muted small">no pouch type yet</span>}</div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}
      {rows.some((r) => !placed.has(r.key)) && (
        <div className="card stack">
          <h2>Not placed in the catalog <span className="muted small">set form / style / sealing type on the pouch type</span></h2>
          <div className="catalog-grid">{rows.filter((r) => !placed.has(r.key)).map(card)}</div>
        </div>
      )}
    </div>
  );
}

function FieldTable({ rows, onOpen }: { rows: EntrySummary[]; onOpen: (key: string) => void }) {
  const sorted = [...rows].sort((a, b) => Number(a.extra?.order ?? 100) - Number(b.extra?.order ?? 100) || a.key.localeCompare(b.key));
  return (
    <div className="card table-wrap" style={{ padding: 0 }}>
      <table>
        <thead><tr><th>#</th><th>Field</th><th>Printed label</th><th>Kind</th><th>Required</th><th>Min. confidence</th><th>Version</th></tr></thead>
        <tbody>
          {sorted.map((r) => {
            const x = r.extra ?? {};
            return (
              <tr key={r.key} className="clickable" onClick={() => onOpen(r.key)} style={x.stop ? { opacity: 0.7 } : undefined}>
                <td className="muted small">{String(x.order ?? "")}</td>
                <td><b>{r.name}</b> {x.section ? <span className="badge">block start</span> : null} {x.stop ? <span className="badge">stop label</span> : null} {r.archived && <span className="badge warn">archived</span>}<div className="muted small"><code>{r.key}</code></div></td>
                <td>{String(x.label ?? "") || <span className="muted small">{String(x.source ?? "")}</span>}</td>
                <td className="muted">{x.stop ? "" : String(x.kind ?? "text")}</td>
                <td>{x.required ? <span className="badge accent">required</span> : ""}</td>
                <td className="muted">{x.min_confidence != null ? String(x.min_confidence) : ""}</td>
                <td className="muted">v{r.version}</td>
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={7} className="muted">The dictionary is empty: the built-in template is used. Run <code>python -m app.cli seed-apply</code> to load it.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
