import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Sleeve } from "../three/types";

const BODY_TOP: Record<string, number> = { bottle: 0.9, jar: 0.88, pot: 0.8 }; // a sleeve moved up stops under the cap / lid
const MATERIALS: [Sleeve["material"], string][] = [["metal", "Metal"], ["plastic", "Plastic (opaque)"], ["clear", "Clear PET"], ["glass", "Glass"]];

type Look = Pick<Sleeve, "front_center_pct" | "sleeve_from" | "cap_color" | "body_color" | "material" | "container_height_mm">;
const lookOf = (s: Sleeve): Look => ({ front_center_pct: s.front_center_pct, sleeve_from: s.sleeve_from, cap_color: s.cap_color, body_color: s.body_color, material: s.material, container_height_mm: s.container_height_mm });

/** A shrink sleeve job's own controls (the team's, on the job page; a share link has none): what it goes
 *  on, which part of the print faces the front, where the sleeve sits, and the container's top and base.
 *  Changes preview live (onPreview); Apply rebuilds the model and the renders. */
export default function SleeveControls({ jobId, sleeve, running, onPreview, onDone }: {
  jobId: number; sleeve: Sleeve; running: boolean;
  onPreview: (patch: Partial<Sleeve> | null) => void; onDone: (message: string) => void;
}) {
  const [containers, setContainers] = useState<{ key: string; name: string }[]>([]);
  const own = sleeve.chosen_by === "job" ? sleeve.container : "";
  const [container, setContainer] = useState(own);
  const [look, setLook] = useState<Look>(lookOf(sleeve));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { api.get<{ key: string; name: string }[]>("/api/index/container").then(setContainers).catch(() => undefined); }, []);
  useEffect(() => { setLook(lookOf(sleeve)); setContainer(sleeve.chosen_by === "job" ? sleeve.container : ""); }, [sleeve]);

  // the container round the sleeve, in mm: what shows below it and above it (its height is their sum with
  // the sleeve's own, which never changes); a cap or lid stays above the body, so a bottle / jar / pot keeps
  // at least that much above
  const bodyTop = BODY_TOP[sleeve.shape] ?? 1;
  const sh = sleeve.sleeve_height_mm;
  const below = look.sleeve_from * look.container_height_mm;
  const above = look.container_height_mm - below - sh;
  const minAbove = (b: number) => Math.max(0, (b + sh) / bodyTop - b - sh);
  const maxGap = Math.max(40, Math.round(sh));
  const base = lookOf(sleeve);
  const lookChanged = (Object.keys(base) as (keyof Look)[]).some((k) => k !== "front_center_pct" && look[k] !== base[k]);
  const changed = container !== own || look.front_center_pct !== base.front_center_pct || lookChanged;
  const edit = (patch: Partial<Look>) => {
    const next = { ...look, ...patch };
    setLook(next);
    onPreview({ ...next, sleeve_to: next.sleeve_from + Math.min(1, sh / next.container_height_mm) });
  };
  const resize = (b: number, a: number) => { // below / above the sleeve, mm
    const h = b + sh + Math.max(a, minAbove(b));
    edit({ container_height_mm: h, sleeve_from: b / h });
  };
  const send = async (style: Record<string, unknown> | undefined, front: number | null, message: string) => {
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/jobs/${jobId}/container`, { container: container || null, front_center_pct: front, style });
      onPreview(null);
      onDone(message);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const apply = () => send(lookChanged ? { sleeve_from: look.sleeve_from, cap_color: look.cap_color, body_color: look.body_color, material: look.material,
    height_mm: look.container_height_mm } : undefined,
    look.front_center_pct !== base.front_center_pct ? look.front_center_pct : null, "Sleeve updated; re-rendering…");
  const off = running || busy;

  return (
    <div className="card adjust stack">
      <h3 style={{ margin: 0 }}>Shrink sleeve</h3>
      <div className="muted small">
        On a {sleeve.name.toLowerCase()} Ø {sleeve.diameter_mm.toFixed(1)} × {sleeve.container_height_mm.toFixed(0)} mm
        {sleeve.chosen_by === "words" ? " (picked from the item name)" : sleeve.chosen_by === "default" ? " (the default container)" : " (chosen for this job)"}.
        Sleeve {sleeve.sleeve_height_mm.toFixed(1)} mm tall, lay-flat {sleeve.layflat_mm.toFixed(1)} mm, seam {sleeve.overlap_mm.toFixed(1)} mm.
      </div>
      <label className="field">Goes on
        <select value={container} onChange={(e) => setContainer(e.target.value)} disabled={off}>
          <option value="">Automatic{sleeve.chosen_by !== "job" ? ` (${sleeve.name})` : ""}</option>
          {containers.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
        </select>
      </label>
      <label className="field">Front of the sleeve <span className="muted small">— the point of the print that faces you: {look.front_center_pct.toFixed(0)} %</span>
        <input type="range" min={0} max={100} step={1} value={look.front_center_pct} disabled={off}
          onChange={(e) => edit({ front_center_pct: Number(e.target.value) })} aria-label="Front of the sleeve" />
      </label>
      <h4 style={{ margin: "6px 0 0" }}>Height <span className="muted small" style={{ fontWeight: 400 }}>— {look.container_height_mm.toFixed(0)} mm overall, the sleeve {sh.toFixed(0)} mm</span></h4>
      <label className="field">Above the sleeve <span className="muted small">— {above.toFixed(1)} mm to the top{bodyTop < 1 ? " (cap / lid included)" : ""}</span>
        <input type="range" min={Math.floor(minAbove(below) * 2) / 2} max={maxGap} step={0.5} value={Math.round(above * 2) / 2} disabled={off}
          onChange={(e) => resize(below, Number(e.target.value))} aria-label="Height above the sleeve" />
      </label>
      <label className="field">Below the sleeve <span className="muted small">— {below.toFixed(1)} mm to the base</span>
        <input type="range" min={0} max={maxGap} step={0.5} value={Math.round(below * 2) / 2} disabled={off}
          onChange={(e) => resize(Number(e.target.value), above)} aria-label="Height below the sleeve" />
      </label>
      <div className="row">
        <label className="field">{sleeve.shape === "tin" || sleeve.shape === "can" ? "Top (can end)" : "Cap / lid"}
          <input type="color" value={look.cap_color} disabled={off} onChange={(e) => edit({ cap_color: e.target.value })} aria-label="Top colour" />
        </label>
        <label className="field">Body and base
          <input type="color" value={look.body_color} disabled={off} onChange={(e) => edit({ body_color: e.target.value })} aria-label="Body colour" />
        </label>
        <label className="field">Material
          <select value={look.material} disabled={off} onChange={(e) => edit({ material: e.target.value as Sleeve["material"] })}>
            {MATERIALS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
      </div>
      {error && <div className="msg bad">{error}</div>}
      <div className="row">
        <button className="primary" onClick={apply} disabled={!changed || off}>{busy ? "Applying…" : "Apply and re-render"}</button>
        {changed && <button onClick={() => { setLook(base); setContainer(own); onPreview(null); }} disabled={busy}>Undo</button>}
        <button onClick={() => send({}, null, "Container look reset; re-rendering…")} disabled={off} title="The container's own colours, material and height">Reset look</button>
      </div>
    </div>
  );
}
