import { VIEWS } from "../api";
import { Chips } from "./PouchTypeEditor";

type Data = Record<string, unknown>;
interface Background { type: string; colors: string[]; image: string | null }

export default function PresetEditor({ data, onChange }: { data: Data; onChange: (d: Data) => void }) {
  const set = (k: string, v: unknown) => onChange({ ...data, [k]: v });
  const bg = { type: "studio_white", colors: [], image: null, ...(data.background as Partial<Background>) } as Background;
  const setBg = (patch: Partial<Background>) => set("background", { ...bg, ...patch });
  const pattern = String(data.naming_pattern ?? "{item_no}_{client}_{view}.png");
  const example = pattern
    .replace("{item_no}", "FGPO7215").replace("{client}", "crystal-enterprises").replace("{view}", "front")
    .replace("{pouch_type}", "stand_up_bottom_gusset").replace("{item_name}", "FGPO7215_Dog_Food_Front_App")
    .replace("{date}", "2026-09-24").replace("{format}", "png");

  return (
    <div className="stack">
      <div className="card grid2">
        <label className="field">Name<input value={String(data.name ?? "")} onChange={(e) => set("name", e.target.value)} /></label>
        <label className="check" style={{ alignSelf: "end" }}><input type="checkbox" checked={Boolean(data.is_default)} onChange={(e) => set("is_default", e.target.checked)} /> Default preset (exactly one)</label>
        <label className="field">Width (px)<input type="number" value={Number(data.width_px ?? 2000)} onChange={(e) => set("width_px", Number(e.target.value))} /></label>
        <label className="field">Height (px)<input type="number" value={Number(data.height_px ?? 2000)} onChange={(e) => set("height_px", Number(e.target.value))} /></label>
      </div>
      <div className="card stack">
        <h2>Camera views</h2>
        <Chips options={VIEWS} value={(data.views ?? []) as string[]} onChange={(v) => set("views", v)} />
        <h2>File formats</h2>
        <Chips options={["png", "glb", "mp4"]} value={(data.formats ?? []) as string[]} onChange={(v) => set("formats", v)} />
        {((data.views as string[]) ?? []).includes("turntable") && (
          <div className="grid2">
            <label className="field">Turntable length (s)<input type="number" value={Number(data.turntable_seconds ?? 6)} onChange={(e) => set("turntable_seconds", Number(e.target.value))} /></label>
            <label className="field">Frames per second<input type="number" value={Number(data.turntable_fps ?? 30)} onChange={(e) => set("turntable_fps", Number(e.target.value))} /></label>
          </div>
        )}
      </div>
      <div className="card grid2">
        <label className="field">Background
          <select value={bg.type} onChange={(e) => setBg({ type: e.target.value, colors: e.target.value === "gradient" && bg.colors.length < 2 ? ["#f4f5f7", "#d9dde3"] : bg.colors })}>
            <option value="studio_white">Studio white</option><option value="transparent">Transparent</option>
            <option value="gradient">Gradient</option><option value="custom_image">Custom image</option>
          </select>
        </label>
        {bg.type === "gradient" && (
          <div className="row">
            {bg.colors.map((c, i) => (
              <input key={i} type="color" value={c} onChange={(e) => setBg({ colors: bg.colors.map((x, j) => (j === i ? e.target.value : x)) })} aria-label={`gradient color ${i + 1}`} />
            ))}
          </div>
        )}
        {bg.type === "custom_image" && <label className="field">Image storage key<input value={bg.image ?? ""} onChange={(e) => setBg({ image: e.target.value || null })} placeholder="uploads in Phase 5" /></label>}
        <label className="field">Lighting
          <select value={String(data.lighting ?? "studio_soft")} onChange={(e) => set("lighting", e.target.value)}>
            <option value="studio_soft">Studio soft</option><option value="studio_hard">Studio hard</option>
            <option value="daylight">Daylight</option><option value="product_dramatic">Product dramatic</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={Boolean(data.shadow ?? true)} onChange={(e) => set("shadow", e.target.checked)} /> Soft contact shadow</label>
        {Boolean(data.shadow ?? true) && (
          <label className="field">Shadow opacity {Number(data.shadow_opacity ?? 0.35).toFixed(2)}
            <input type="range" min={0} max={1} step={0.05} value={Number(data.shadow_opacity ?? 0.35)} onChange={(e) => set("shadow_opacity", Number(e.target.value))} />
          </label>
        )}
      </div>
      <div className="card stack">
        <label className="field">File naming pattern — {"{item_no} {client} {view} {pouch_type} {item_name} {date} {format}"}
          <input className="code" value={pattern} onChange={(e) => set("naming_pattern", e.target.value)} />
        </label>
        <div className="muted small">Example: <code>{example}</code></div>
      </div>
    </div>
  );
}
