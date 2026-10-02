import { Fragment, useState } from "react";
import { KeylineField, RuleGroup } from "../api";
import RuleGroups from "./RuleGroups";

type Data = Record<string, unknown>;
const STANDARD = new Set([
  "bleed_left_mm", "bleed_right_mm", "bleed_top_mm", "bleed_bottom_mm", "top_seal_mm", "bottom_seal_mm", "side_seal_mm",
  "fin_seal_mm", "crimp_height_mm", "zipper_offset_from_top_mm", "zipper_ridge_height_mm", "tear_notch_type",
  "tear_notch_offset_mm", "butterfly_notch", "corner_radius_mm", "gusset_depth_mm", "gusset_shape", "side_gusset_depth_mm",
  "body_bulge_percent", "fill_level_percent", "spout_position", "spout_diameter_mm", "spout_cap_diameter_mm",
  "spout_cap_height_mm", "hang_hole_type", "hang_hole_size_mm", "hang_hole_offset_mm", "window_enabled", "window_x_mm",
  "window_y_mm", "window_width_mm", "window_height_mm", "window_corner_radius_mm", "texture_dpi",
]);

const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));
const textOrNull = (s: string) => (s.trim() === "" ? null : s);

function parseDefault(f: KeylineField, s: string): unknown {
  if (f.type === "number") return numOrNull(s);
  if (f.type === "bool") return s === "true";
  return s === "" ? null : s;
}

export default function KeylineEditor({ data, onChange }: { data: Data; onChange: (d: Data) => void }) {
  const fields = (data.fields ?? {}) as Record<string, KeylineField>;
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const set = (k: string, v: unknown) => onChange({ ...data, [k]: v });
  const setField = (name: string, patch: Partial<KeylineField>) => set("fields", { ...fields, [name]: { ...fields[name], ...patch } });

  const addField = () => {
    const name = window.prompt("New field name (lowercase, e.g. hang_hole_depth_mm)");
    if (!name || fields[name]) return;
    set("fields", { ...fields, [name]: { type: "number", unit: "mm", default: 0, pin: false, min: null, max: null, options: [], formula: null, from_measured: null, from_spec: null, value_map: {}, enabled_when: [], description: "" } });
    setOpen(name);
  };
  const removeField = (name: string) => {
    const next = { ...fields };
    delete next[name];
    set("fields", next);
  };

  const names = Object.keys(fields).filter((n) => n.includes(filter.trim().toLowerCase()));

  return (
    <div className="stack">
      <div className="card grid2">
        <label className="field">Name<input value={String(data.name ?? "")} onChange={(e) => set("name", e.target.value)} /></label>
        <label className="field">Description<input value={String(data.description ?? "")} onChange={(e) => set("description", e.target.value)} /></label>
      </div>
      <div className="card">
        <div className="page-head" style={{ marginBottom: 8 }}>
          <div>
            <h2>Fields</h2>
            <div className="muted small">
              Resolution order: item override → client override → <b>formula</b> or <b>pinned</b> default (this pouch type's rule) → <b>measured</b> from the PDF dieline → <b>spec table</b> → default.
              Formulas use <code>spec.&lt;field&gt;</code>, <code>measured.&lt;field&gt;</code> and other field names, e.g. <code>spec.gusset_full_width_mm / 2</code>.
            </div>
          </div>
          <div className="row">
            <input placeholder="Filter fields" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button onClick={addField}>+ Custom field</button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="kl-table">
            <thead>
              <tr><th>Field</th><th>Unit</th><th>Default</th><th>Min</th><th>Max</th><th>Pin</th><th>Formula (pouch type)</th><th>Measured</th><th>Spec table</th><th /></tr>
            </thead>
            <tbody>
              {names.map((name) => {
                const f = fields[name];
                return (
                  <Fragment key={name}>
                    <tr>
                      <td><code>{name}</code>{f.enabled_when?.length > 0 && <span className="badge" title="Only when its conditions hold"> conditional</span>}</td>
                      <td style={{ width: 60 }}><input value={f.unit} onChange={(e) => setField(name, { unit: e.target.value })} /></td>
                      <td className="num">
                        {f.type === "enum" ? (
                          <select value={String(f.default ?? "")} onChange={(e) => setField(name, { default: e.target.value })}>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
                        ) : f.type === "bool" ? (
                          <select value={String(Boolean(f.default))} onChange={(e) => setField(name, { default: e.target.value === "true" })}><option>true</option><option>false</option></select>
                        ) : (
                          <input value={f.default === null || f.default === undefined ? "" : String(f.default)} onChange={(e) => setField(name, { default: parseDefault(f, e.target.value) })} />
                        )}
                      </td>
                      <td className="num"><input value={f.min ?? ""} disabled={f.type !== "number"} onChange={(e) => setField(name, { min: numOrNull(e.target.value) })} /></td>
                      <td className="num"><input value={f.max ?? ""} disabled={f.type !== "number"} onChange={(e) => setField(name, { max: numOrNull(e.target.value) })} /></td>
                      <td><input type="checkbox" checked={f.pin} onChange={(e) => setField(name, { pin: e.target.checked })} title="Default beats measured and spec-table values" /></td>
                      <td><input className="code" title={f.formula ?? ""} value={f.formula ?? ""} onChange={(e) => setField(name, { formula: textOrNull(e.target.value) })} /></td>
                      <td><input className="code" title={f.from_measured ?? ""} value={f.from_measured ?? ""} onChange={(e) => setField(name, { from_measured: textOrNull(e.target.value) })} /></td>
                      <td><input className="code" title={f.from_spec ?? ""} value={f.from_spec ?? ""} onChange={(e) => setField(name, { from_spec: textOrNull(e.target.value) })} /></td>
                      <td><button className="link" onClick={() => setOpen(open === name ? null : name)}>{open === name ? "less" : "more"}</button></td>
                    </tr>
                    {open === name && (
                      <tr>
                        <td colSpan={10} style={{ background: "var(--panel-2)" }}>
                          <div className="grid2">
                            <label className="field">Type
                              <select value={f.type} disabled={STANDARD.has(name)} onChange={(e) => setField(name, { type: e.target.value as KeylineField["type"] })}>
                                <option>number</option><option>bool</option><option>enum</option><option>text</option>
                              </select>
                            </label>
                            <label className="field">Description<input value={f.description} onChange={(e) => setField(name, { description: e.target.value })} /></label>
                            {f.type === "enum" && (
                              <label className="field">Options (comma separated)
                                <input defaultValue={f.options.join(", ")} onBlur={(e) => setField(name, { options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
                              </label>
                            )}
                            <label className="field">Spec text → value (one “text: value” per line)
                              <textarea rows={3} className="code" style={{ minHeight: 0 }}
                                defaultValue={Object.entries(f.value_map ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n")}
                                onBlur={(e) => setField(name, { value_map: parseMap(e.target.value) })} />
                            </label>
                          </div>
                          <h3>Only applies when</h3>
                          <RuleGroups groups={(f.enabled_when ?? []) as RuleGroup[]} onChange={(g) => setField(name, { enabled_when: g })} emptyText="Always applies." />
                          {!STANDARD.has(name) && <div style={{ marginTop: 8 }}><button className="danger" onClick={() => removeField(name)}>Remove custom field</button></div>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function parseMap(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split("\n")) {
    const i = line.lastIndexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
