import { useEffect, useState } from "react";
import { api, EntrySummary, GEOMETRY_TEMPLATES, PANELS, RuleGroup } from "../api";
import RuleGroups from "./RuleGroups";

type Data = Record<string, unknown>;

export function Chips({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="chips">
      {options.map((o) => (
        <span key={o} role="checkbox" aria-checked={value.includes(o)} tabIndex={0} className={`chip ${value.includes(o) ? "on" : ""}`}
          onClick={() => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])}
          onKeyDown={(e) => e.key === " " && onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])}>{o}</span>
      ))}
    </div>
  );
}

type Dict = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A small picture for the catalog: scaled to 160 px and stored inline (data URL, well under 96 kB). */
function thumbnailOf(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 160 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

export default function PouchTypeEditor({ data, onChange }: { data: Data; onChange: (d: Data) => void }) {
  const [keylines, setKeylines] = useState<EntrySummary[]>([]);
  const [materials, setMaterials] = useState<EntrySummary[]>([]);
  const [presets, setPresets] = useState<EntrySummary[]>([]);
  const [catalog, setCatalog] = useState<Dict | null>(null);
  useEffect(() => {
    api.get<EntrySummary[]>("/api/index/keyline_template").then(setKeylines);
    api.get<EntrySummary[]>("/api/index/material").then(setMaterials);
    api.get<EntrySummary[]>("/api/index/output_preset").then(setPresets);
    api.get<Dict>("/api/index/pouch_catalog/default").then((e) => setCatalog(e.data)).catch(() => setCatalog(null));
  }, []);
  const set = (k: string, v: unknown) => onChange({ ...data, [k]: v });
  const geometry = String(data.geometry_template ?? "");
  const aliases = (data.panel_aliases ?? {}) as Record<string, string[]>;
  const aliasText = Object.entries(aliases).map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n");
  const svg = (data.outline_svg as string | null) ?? "";
  const styles: Dict[] = (catalog?.styles ?? []).filter((s: Dict) => !data.form || s.form === data.form);
  const sealing: Dict[] = (catalog?.sealing_types ?? []).filter((t: Dict) => !data.style || t.style === data.style);
  // picking a sealing type fills in its style and form
  const pickSealing = (key: string) => {
    const t = (catalog?.sealing_types ?? []).find((x: Dict) => x.key === key);
    const s = t && (catalog?.styles ?? []).find((x: Dict) => x.key === t.style);
    onChange({ ...data, sealing_type: key || null, style: s?.key ?? data.style ?? null, form: s?.form ?? data.form ?? null });
  };

  return (
    <div className="stack">
      {catalog && (
        <div className="card grid2">
          <label className="field">Form
            <select value={String(data.form ?? "")} onChange={(e) => onChange({ ...data, form: e.target.value || null, style: null, sealing_type: null })}>
              <option value="">—</option>{(catalog.forms ?? []).map((f: Dict) => <option key={f.key} value={f.key}>{f.name}</option>)}
            </select></label>
          <label className="field">Style
            <select value={String(data.style ?? "")} onChange={(e) => onChange({ ...data, style: e.target.value || null, sealing_type: null })}>
              <option value="">—</option>{styles.map((s: Dict) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </select></label>
          <label className="field">Sealing type
            <select value={String(data.sealing_type ?? "")} onChange={(e) => pickSealing(e.target.value)}>
              <option value="">—</option>{sealing.map((t: Dict) => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select></label>
          <label className="field">Catalog picture
            <input type="file" accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; if (f) set("thumbnail", await thumbnailOf(f)); }} />
            {data.thumbnail ? <span className="row"><img src={String(data.thumbnail)} alt="" style={{ height: 48, borderRadius: 4 }} /><button className="link small" onClick={() => set("thumbnail", null)}>remove</button></span> : null}
          </label>
          <label className="field">Default material (base finish for this type)
            <select value={String(data.default_material ?? "")} onChange={(e) => set("default_material", e.target.value || null)}>
              <option value="">— by the material rules only —</option>{materials.map((m) => <option key={m.key} value={m.key}>{m.name} ({m.key})</option>)}
            </select></label>
          <label className="field">Default output preset
            <select value={String(data.default_output_preset ?? "")} onChange={(e) => set("default_output_preset", e.target.value || null)}>
              <option value="">— the index default —</option>{presets.map((p) => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}
            </select></label>
        </div>
      )}
      <div className="card grid2">
        <label className="field">Name<input value={String(data.name ?? "")} onChange={(e) => set("name", e.target.value)} /></label>
        <label className="field">Geometry template
          <select value={geometry} onChange={(e) => set("geometry_template", e.target.value)}>
            {GEOMETRY_TEMPLATES.map((g) => <option key={g}>{g}</option>)}
          </select>
        </label>
        {(geometry === "spout_pouch" || geometry === "shaped_diecut") && (
          <label className="field">Base shape
            <select value={String(data.base_geometry ?? "")} onChange={(e) => set("base_geometry", e.target.value || null)}>
              <option value="">—</option>
              <option value="stand_up_bottom_gusset">stand_up_bottom_gusset</option>
              <option value="three_side_seal">three_side_seal (flat)</option>
              <option value="auto">auto (stand-up if bottom gusset)</option>
            </select>
          </label>
        )}
        <label className="field">Keyline template
          <select value={String(data.keyline_template ?? "")} onChange={(e) => set("keyline_template", e.target.value)}>
            {keylines.map((k) => <option key={k.key} value={k.key}>{k.name} ({k.key})</option>)}
          </select>
        </label>
        <label className="field">Priority (lower = checked first)<input type="number" value={Number(data.priority ?? 100)} onChange={(e) => set("priority", Number(e.target.value))} /></label>
        <label className="check" style={{ alignSelf: "end" }}><input type="checkbox" checked={Boolean(data.active ?? true)} onChange={(e) => set("active", e.target.checked)} /> Active</label>
        <label className="field" style={{ gridColumn: "1 / -1" }}>Description<input value={String(data.description ?? "")} onChange={(e) => set("description", e.target.value)} /></label>
      </div>

      <div className="card">
        <h2>Match rules</h2>
        <p className="muted small" style={{ marginTop: 0 }}>The type matches when any group has all its conditions true. Types are checked by priority; the first priority level with a match decides, and two matches at that level send the job to review with a type picker.</p>
        <RuleGroups groups={(data.match_rules ?? []) as RuleGroup[]} onChange={(g) => set("match_rules", g)} />
      </div>

      <div className="card grid2">
        <div className="stack"><h2>Required panels</h2><Chips options={PANELS} value={(data.required_panels ?? []) as string[]} onChange={(v) => set("required_panels", v)} /></div>
        <div className="stack"><h2>Optional panels</h2><Chips options={PANELS} value={(data.optional_panels ?? []) as string[]} onChange={(v) => set("optional_panels", v)} /></div>
        <label className="field" style={{ gridColumn: "1 / -1" }}>Panel aliases: one linked PDF serving several roles (one per line, e.g. “side: side_left, side_right”)
          <textarea rows={3} className="code" style={{ minHeight: 0 }} defaultValue={aliasText} onBlur={(e) => set("panel_aliases", parseAliases(e.target.value))} />
        </label>
      </div>

      {geometry === "shaped_diecut" && (
        <div className="card grid2">
          <label className="field">Die-cut outline (SVG, 1 unit = 1 mm)
            <input type="file" accept=".svg,image/svg+xml" onChange={async (e) => { const f = e.target.files?.[0]; if (f) set("outline_svg", await f.text()); }} />
          </label>
          <div>{svg ? <img alt="outline" style={{ maxHeight: 180, background: "#fff", borderRadius: 6 }} src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} /> : <span className="muted">No outline uploaded.</span>}</div>
        </div>
      )}
    </div>
  );
}

function parseAliases(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of text.split("\n")) {
    const [k, v] = line.split(":");
    if (k?.trim() && v) out[k.trim()] = v.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}
