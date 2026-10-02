// PDF profile form: the settings an admin changes most (how sheets are read, panels & artwork rules).
// Everything else in the profile (layer names, ink patterns, OCR template tuning) is on the YAML tab.
type Data = Record<string, unknown>;
interface PanelRule { remark_labels: string[]; bleed_mm: number | null; rotation: number; mirror: boolean }

const ROLES = ["front", "back", "gusset", "bottom", "top", "side", "side_left", "side_right"];
const blank = (): PanelRule => ({ remark_labels: [], bleed_mm: null, rotation: 0, mirror: false });

export default function ProfileEditor({ data, onChange }: { data: Data; onChange: (d: Data) => void }) {
  const set = (k: string, v: unknown) => onChange({ ...data, [k]: v });
  const rules = (data.panel_rules ?? {}) as Record<string, PanelRule>;
  const setRule = (role: string, patch: Partial<PanelRule>) => set("panel_rules", { ...rules, [role]: { ...blank(), ...rules[role], ...patch } });
  const roles = Array.from(new Set([...ROLES, ...Object.keys(rules)]));
  return (
    <div className="stack">
      <div className="card grid2">
        <label className="field">Reading the spec table and dimension labels
          <select value={String(data.ocr ?? "auto")} onChange={(e) => set("ocr", e.target.value)}>
            <option value="auto">PDF text layer first, OCR only where it gives nothing (auto)</option>
            <option value="off">PDF text layer only, never OCR (files without a text layer ask for the details)</option>
            <option value="always">OCR always (diagnostics)</option>
          </select></label>
        <label className="field">How artwork and drawing are told apart
          <select value={String(data.layout_mode ?? "auto")} onChange={(e) => set("layout_mode", e.target.value)}>
            <option value="auto">auto (layers when the file has them, else separation)</option>
            <option value="layers">layers (ArtPro+ exports)</option>
            <option value="separation">separation (Illustrator: dieline in a technical ink)</option>
          </select></label>
        <label className="field">Which of two face-sized panels on a sheet is the front
          <select value={String(data.sheet_front ?? "auto")} onChange={(e) => set("sheet_front", e.target.value)}>
            <option value="auto">auto (the one with less small print)</option><option value="first">first in sheet order</option><option value="last">last in sheet order</option>
          </select></label>
        <label className="field">Largest unprinted gap between panels on one sheet (mm)<input type="number" step="0.5" value={Number(data.sheet_panel_gap_max_mm ?? 8)} onChange={(e) => set("sheet_panel_gap_max_mm", Number(e.target.value))} /></label>
        <label className="field">Dimension label tolerance: a measured line this close to a printed size is confirmed (mm)<input type="number" step="0.05" value={Number(data.label_tolerance_mm ?? 0.15)} onChange={(e) => set("label_tolerance_mm", Number(e.target.value))} /></label>
        <label className="field">Finished texture size tolerance (mm)<input type="number" step="0.1" value={Number(data.finished_size_tolerance_mm ?? 0.5)} onChange={(e) => set("finished_size_tolerance_mm", Number(e.target.value))} /></label>
        <label className="check"><input type="checkbox" checked={Boolean(data.page_fallback ?? true)} onChange={(e) => set("page_fallback", e.target.checked)} /> Plain artwork PDFs (no dieline, no table): ask for the pouch details instead of rejecting</label>
        <label className="check"><input type="checkbox" checked={data.plain_missing_gussets !== false} onChange={(e) => set("plain_missing_gussets", e.target.checked)} /> A gusset or side panel with no artwork PDF is plain film in the front's colour (off: ask for the PDF)</label>
        <label className="check"><input type="checkbox" checked={Boolean(data.include_eyemarks)} onChange={(e) => set("include_eyemarks", e.target.checked)} /> Render eyemarks and print marks in the texture (printed look)</label>
        <label className="field">Texture resolution (dpi)<input type="number" value={Number(data.texture_dpi ?? 300)} onChange={(e) => set("texture_dpi", Number(e.target.value))} /></label>
        <label className="field">Item code in file names (regex)<input value={String(data.filename_code_pattern ?? "")} onChange={(e) => set("filename_code_pattern", e.target.value)} className="code" /></label>
      </div>
      <div className="card stack">
        <h2>Panels &amp; artwork rules</h2>
        <div className="muted small">Per panel: more words that name it before “Code :” in the Remarks, a fixed bleed for its linked PDFs (empty = measured from the dieline / TrimBox), an extra turn and a mirror for artwork printed from the inside.</div>
        <table className="kl-table">
          <thead><tr><th>Panel</th><th>Also named in Remarks as (comma separated)</th><th>Bleed (mm)</th><th>Turn</th><th>Mirror</th></tr></thead>
          <tbody>
            {roles.map((role) => {
              const r = rules[role] ?? blank();
              return (
                <tr key={role}>
                  <td><b>{role}</b></td>
                  <td><input defaultValue={r.remark_labels.join(", ")} onBlur={(e) => setRule(role, { remark_labels: e.target.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) })} placeholder={role === "back" ? "rear, reverse" : ""} /></td>
                  <td className="num"><input type="number" step="0.5" min={0} max={30} value={r.bleed_mm ?? ""} onChange={(e) => setRule(role, { bleed_mm: e.target.value === "" ? null : Number(e.target.value) })} placeholder="auto" /></td>
                  <td><select value={r.rotation} onChange={(e) => setRule(role, { rotation: Number(e.target.value) })}><option value={0}>0°</option><option value={90}>90°</option><option value={180}>180°</option><option value={270}>270°</option></select></td>
                  <td><input type="checkbox" checked={r.mirror} onChange={(e) => setRule(role, { mirror: e.target.checked })} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="muted small">Layer names, ink classification patterns, the OCR template tuning and the technical-colour check are on the YAML tab; the field labels themselves are in the Field dictionary.</div>
      </div>
    </div>
  );
}
