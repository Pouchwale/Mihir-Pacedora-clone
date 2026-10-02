// Standard size (size rules): a finished size validation compares jobs against.
import { useEffect, useState } from "react";
import { api, EntrySummary } from "../api";

type Data = Record<string, unknown>;

export default function SizeEditor({ data, onChange }: { data: Data; onChange: (d: Data) => void }) {
  const [types, setTypes] = useState<EntrySummary[]>([]);
  useEffect(() => { api.get<EntrySummary[]>("/api/index/pouch_type").then(setTypes); }, []);
  const set = (k: string, v: unknown) => onChange({ ...data, [k]: v });
  const num = (k: string) => (data[k] === null || data[k] === undefined ? "" : String(data[k]));
  return (
    <div className="card grid2">
      <label className="field">Name<input value={String(data.name ?? "")} onChange={(e) => set("name", e.target.value)} placeholder="Stand-up 240 x 312" /></label>
      <label className="field">Pouch type (empty = any)
        <select value={String(data.pouch_type ?? "")} onChange={(e) => set("pouch_type", e.target.value || null)}>
          <option value="">any</option>{types.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
        </select></label>
      <label className="field">Closed width (mm)<input type="number" value={num("width_mm")} onChange={(e) => set("width_mm", Number(e.target.value))} /></label>
      <label className="field">Height (mm)<input type="number" value={num("height_mm")} onChange={(e) => set("height_mm", Number(e.target.value))} /></label>
      <label className="field">Gusset full width (mm, optional)<input type="number" value={num("gusset_mm")} onChange={(e) => set("gusset_mm", e.target.value === "" ? null : Number(e.target.value))} /></label>
      <label className="field">Tolerance (mm)<input type="number" step="0.5" value={num("tolerance_mm")} onChange={(e) => set("tolerance_mm", Number(e.target.value))} /></label>
      <label className="field" style={{ gridColumn: "1 / -1" }}>Notes<input value={String(data.notes ?? "")} onChange={(e) => set("notes", e.target.value)} /></label>
      <div className="muted small" style={{ gridColumn: "1 / -1" }}>Validation warns when a job's size matches no standard size (within tolerance) and names the nearest one. Tolerances for seals, dimensions and the open/closed width check live in Validation rules.</div>
    </div>
  );
}
