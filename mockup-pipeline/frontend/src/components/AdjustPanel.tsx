// Job-page adjustments (the Pacdora-style controls) next to the 3D viewer: artwork per panel (a
// new picture, placement, colour, logos and text), size and shape, features (zipper, notch, hang
// hole, window), material, scene. Edits preview instantly; "Apply" reruns the job so the renders,
// GLB and video match; an admin can save them as the item's default.
import { useEffect, useRef, useState } from "react";
import { DEFAULT_OVERLAY, IDENTITY_PANEL, panelChanged, panelOf, previewUrl, type Draft, type PanelDraft } from "../three/draft";
import type { Overlay, SceneData, SceneFile } from "../three/types";

type Dict = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Uploaded extends SceneFile { file_id: number; width_px: number; height_px: number }

interface Props {
  scene: SceneData;
  job: Dict; // GET /api/jobs/{id}
  draft: Draft;
  dirty: boolean;
  busy: boolean;
  isAdmin: boolean;
  onChange: (d: Draft) => void;
  onApply: (saveDefault: boolean) => void;
  onReset: () => void;
  onUpload: (file: File) => Promise<Uploaded>;
}

const LIGHTING = [
  ["exact", "Exact print colours (no shading)"], ["studio_soft", "Studio soft"], ["studio_hard", "Studio hard"], ["daylight", "Daylight"], ["product_dramatic", "Product dramatic"],
];
const VIEWS = ["front", "back", "three_quarter_left", "three_quarter_right", "top_down", "turntable"];
const KEYLINE_FIELDS: [string, string, string][] = [
  ["top_seal_mm", "Top seal", "mm"], ["bottom_seal_mm", "Bottom seal", "mm"], ["side_seal_mm", "Side seal", "mm"],
  ["zipper_offset_from_top_mm", "Zipper from top", "mm"], ["tear_notch_offset_mm", "Tear notch from top", "mm"],
  ["corner_radius_mm", "Corner radius", "mm"], ["gusset_depth_mm", "Gusset depth", "mm"], ["side_gusset_depth_mm", "Side gusset depth", "mm"],
  ["fill_level_percent", "Fill level", "%"], ["body_bulge_percent", "Bulge", "%"],
];
const NOTCHES = [["none", "None"], ["v_notch", "V notch"], ["straight", "Straight"], ["laser_score", "Laser score"]];
const HANG_HOLES = [["none", "None"], ["round", "Round"], ["euro", "Euro slot"]];
const WINDOW_FIELDS: [string, string][] = [["window_x_mm", "From left"], ["window_y_mm", "From top"], ["window_width_mm", "Width"], ["window_height_mm", "Height"], ["window_corner_radius_mm", "Corner radius"]];
const FIT = [["cover", "Fill the panel (crop)"], ["contain", "Fit inside (show all)"], ["stretch", "Stretch to the panel"]];
const FONT_CSS: Record<Overlay["font"], string> = { sans: "Arial, Helvetica, sans-serif", serif: '"Times New Roman", serif', mono: '"Courier New", monospace' };

function Section({ title, children, open = false }: { title: string; children: React.ReactNode; open?: boolean }) {
  return <details open={open} className="adjust-section"><summary><b>{title}</b></summary><div className="stack" style={{ marginTop: 8 }}>{children}</div></details>;
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

/** A hidden file input opened by a button; `accept` images and PDFs. */
function UploadButton({ label, busy, onFile, title }: { label: string; busy: boolean; onFile: (f: File) => void; title?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" disabled={busy} title={title} onClick={() => input.current?.click()}>{busy ? "Uploading…" : label}</button>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp,application/pdf,.pdf" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
    </>
  );
}

export default function AdjustPanel({ scene, job, draft, dirty, busy, isAdmin, onChange, onApply, onReset, onUpload }: Props) {
  const [saveDefault, setSaveDefault] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null); // "<role>" or "<role>:logo"
  const [uploadError, setUploadError] = useState("");
  const [selected, setSelected] = useState<{ role: string; id: string } | null>(null);
  const g = scene.geometry;
  const kl: Dict = job.outputs?.resolve_keyline?.keyline?.fields ?? {};
  const layout: Dict | undefined = job.outputs?.extract_specs?.layout;
  const sheetPanels: Dict[] = layout?.kind === "multi" ? layout.panels : [];
  const roles = Object.keys(scene.textures).filter((r) => r !== "roll");
  const hasPlain = Object.values(scene.textures).some((t) => t.color) || Object.values(draft.panels).some((p) => p.source === "plain");
  const files = scene.files ?? {};

  const setPanel = (role: string, patch: Partial<PanelDraft>) => onChange({ ...draft, panels: { ...draft.panels, [role]: { ...panelOf(draft, role), ...patch } } });
  const setSpec = (key: string, text: string) => onChange({ ...draft, specs: { ...draft.specs, [key]: text === "" ? null : Number(text) } });
  const setKey = (key: string, value: number | string | boolean | null) => onChange({ ...draft, keyline: { ...draft.keyline, [key]: value } });
  const setKeyNum = (key: string, text: string) => setKey(key, text === "" ? null : Number(text));
  const specValue = (key: string, fallback: number | undefined) => draft.specs[key] ?? fallback ?? "";
  const keyValue = (key: string) => draft.keyline[key] ?? kl[key]?.value ?? "";
  const keyBool = (key: string, fallback = false) => (typeof draft.keyline[key] === "boolean" ? (draft.keyline[key] as boolean) : kl[key]?.value ?? fallback);
  const keyText = (key: string, fallback = "none") => String(draft.keyline[key] ?? kl[key]?.value ?? fallback);

  const upload = async (role: string, what: "art" | "logo", file: File) => {
    setUploading(`${role}:${what}`);
    setUploadError("");
    try {
      const up = await onUpload(file);
      if (what === "art") setPanel(role, { source: "file", file_id: up.file_id, sheet_panel: null });
      else addOverlay(role, { kind: "image", file_id: up.file_id, width_mm: Math.min(40, scene.textures[role].width_mm / 3) });
    } catch (err) {
      setUploadError(String((err as Error).message ?? err));
    } finally {
      setUploading(null);
    }
  };

  const addOverlay = (role: string, patch: Partial<Overlay>) => {
    const t = scene.textures[role];
    const p = panelOf(draft, role);
    const o: Overlay = { ...DEFAULT_OVERLAY, id: newId(), x_mm: t.width_mm / 2, y_mm: t.height_mm / 2, size_mm: Math.max(4, Math.round(t.height_mm / 25)), ...patch };
    setPanel(role, { overlays: [...p.overlays, o] });
    setSelected({ role, id: o.id });
  };
  const setOverlay = (role: string, id: string, patch: Partial<Overlay>) => {
    const p = panelOf(draft, role);
    setPanel(role, { overlays: p.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)) });
  };
  const removeOverlay = (role: string, id: string) => {
    const p = panelOf(draft, role);
    setPanel(role, { overlays: p.overlays.filter((o) => o.id !== id) });
    if (selected?.id === id) setSelected(null);
  };
  const moveOverlay = (role: string, id: string, dir: -1 | 1) => {
    const list = [...panelOf(draft, role).overlays];
    const i = list.findIndex((o) => o.id === id);
    if (i < 0 || i + dir < 0 || i + dir >= list.length) return;
    [list[i], list[i + dir]] = [list[i + dir], list[i]];
    setPanel(role, { overlays: list });
  };

  const windowOn = keyBool("window_enabled");
  const zipperOn = draft.keyline.zipper_offset_from_top_mm !== null && (draft.keyline.zipper_offset_from_top_mm !== undefined || kl.zipper_offset_from_top_mm?.value != null);
  const bg = draft.scene.background ?? g.preset.background;

  return (
    <div className="card stack adjust">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Adjust</h2>
        {dirty && <span className="badge warn">preview · not applied</span>}
      </div>
      {uploadError && <div className="msg bad small">{uploadError}</div>}

      <Section title="Artwork per panel" open>
        {roles.length > 1 && (
          <label className="check"><input type="checkbox" checked={draft.swap_front_back} onChange={(e) => onChange({ ...draft, swap_front_back: e.target.checked })} /> Swap front and back</label>
        )}
        {roles.map((role) => {
          const p = panelOf(draft, role);
          const t = scene.textures[role];
          const span = Math.max(20, Math.min(t.width_mm, t.height_mm) / 2);
          const square = Math.abs(t.width_mm - t.height_mm) < 0.5;
          const fileName = p.file_id ? files[String(p.file_id)]?.filename ?? `upload #${p.file_id}` : null;
          const sel = selected?.role === role ? p.overlays.find((o) => o.id === selected.id) ?? null : null;
          const isUploading = uploading === `${role}:art`;
          return (
            <div key={role} className="adjust-panel">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <b>{role.replace(/_/g, " ")}</b> <span className="muted small">{t.width_mm} × {t.height_mm} mm</span>
              </div>
              <div className="row">
                <label className="small" style={{ flex: 1 }}>Artwork
                  <select value={p.source === "sheet" && p.sheet_panel !== null ? `sheet:${p.sheet_panel}` : p.source} onChange={(e) => {
                    const v = e.target.value as PanelDraft["source"];
                    if (v === "file") return; // chosen through the upload button
                    setPanel(role, { source: v, sheet_panel: null });
                  }}>
                    <option value="auto">Automatic</option>
                    {sheetPanels.map((sp, i) => <option key={i} value={`sheet:${i}`}>{`Sheet panel ${i + 1} (${sp.role ?? sp.kind}, ${sp.width_mm} × ${sp.height_mm} mm)`}</option>)}
                    {role !== "front" && <option value="front">Same as front</option>}
                    <option value="plain">Plain colour</option>
                    {p.source === "file" && <option value="file">Uploaded picture{fileName ? `: ${fileName}` : ""}</option>}
                  </select>
                </label>
                {p.source === "plain" && <input type="color" value={p.color ?? draft.material.plain_color ?? "#dddddd"} onChange={(e) => setPanel(role, { color: e.target.value })} aria-label={`${role} colour`} />}
              </div>
              <div className="row">
                <UploadButton label={p.source === "file" ? "Replace picture…" : "Use my own picture / PDF…"} busy={isUploading} onFile={(f) => upload(role, "art", f)}
                  title="PNG, JPEG, WebP or a PDF page: fitted to this panel" />
                {p.source === "file" && (
                  <select value={p.fit} onChange={(e) => setPanel(role, { fit: e.target.value as PanelDraft["fit"] })} aria-label={`${role} fit`}>
                    {FIT.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                )}
                {p.source === "file" && p.fit === "contain" && (
                  <input type="color" value={p.background ?? "#ffffff"} onChange={(e) => setPanel(role, { background: e.target.value })} title="colour around the picture" aria-label={`${role} background`} />
                )}
              </div>
              <div className="row">
                <button onClick={() => setPanel(role, { rotation: (p.rotation + 180) % 360 })}>Turn 180°</button>
                {square && <button onClick={() => setPanel(role, { rotation: (p.rotation + 90) % 360 })}>Turn 90°</button>}
                <label className="check"><input type="checkbox" checked={p.flip_x} onChange={(e) => setPanel(role, { flip_x: e.target.checked })} /> Mirror</label>
                <label className="check"><input type="checkbox" checked={p.flip_y} onChange={(e) => setPanel(role, { flip_y: e.target.checked })} /> Flip</label>
                <span className="muted small">{p.rotation ? `${p.rotation}°` : ""}</span>
              </div>
              <label className="small">Move ↔ {p.offset_x_mm} mm
                <input type="range" min={-span} max={span} step={0.5} value={p.offset_x_mm} onChange={(e) => setPanel(role, { offset_x_mm: Number(e.target.value) })} />
              </label>
              <label className="small">Move ↕ {p.offset_y_mm} mm
                <input type="range" min={-span} max={span} step={0.5} value={p.offset_y_mm} onChange={(e) => setPanel(role, { offset_y_mm: Number(e.target.value) })} />
              </label>
              <label className="small">Scale {Math.round(p.scale * 100)}%
                <input type="range" min={0.5} max={2} step={0.01} value={p.scale} onChange={(e) => setPanel(role, { scale: Number(e.target.value) })} />
              </label>

              <details className="adjust-sub" open={!!(p.brightness || p.contrast || p.saturation)}>
                <summary className="small">Colour correction{p.brightness || p.contrast || p.saturation ? " · on" : ""}</summary>
                {(["brightness", "contrast", "saturation"] as const).map((k) => (
                  <label key={k} className="small">{k[0].toUpperCase() + k.slice(1)} {p[k] > 0 ? "+" : ""}{p[k]}
                    <input type="range" min={-100} max={100} step={1} value={p[k]} onChange={(e) => setPanel(role, { [k]: Number(e.target.value) } as Partial<PanelDraft>)} />
                  </label>
                ))}
                {(p.brightness || p.contrast || p.saturation) ? <button className="link" onClick={() => setPanel(role, { brightness: 0, contrast: 0, saturation: 0 })}>as printed</button> : null}
              </details>

              <details className="adjust-sub" open={p.overlays.length > 0}>
                <summary className="small">Logos and text{p.overlays.length ? ` · ${p.overlays.length}` : ""}</summary>
                <div className="row">
                  <button onClick={() => addOverlay(role, { kind: "text", text: "Your text" })}>+ Text</button>
                  <UploadButton label="+ Logo / picture…" busy={uploading === `${role}:logo`} onFile={(f) => upload(role, "logo", f)} title="PNG (transparent works), JPEG, WebP or a PDF page" />
                </div>
                {p.overlays.length > 0 && (
                  <PanelArtEditor role={role} panel={p} texture={t} files={files} plainColour={p.source === "plain" ? p.color ?? draft.material.plain_color ?? "#dddddd" : t.color ? draft.material.plain_color ?? t.color : null}
                    selected={sel?.id ?? null} onSelect={(id) => setSelected(id ? { role, id } : null)} onMove={(id, x, y) => setOverlay(role, id, { x_mm: x, y_mm: y })} />
                )}
                {sel && (
                  <OverlayControls o={sel} panel={t} files={files}
                    onChange={(patch) => setOverlay(role, sel.id, patch)} onRemove={() => removeOverlay(role, sel.id)}
                    onOrder={(dir) => moveOverlay(role, sel.id, dir)} />
                )}
                {p.overlays.length > 0 && !sel && <div className="muted small">Click a logo or text in the panel to edit it; drag to move.</div>}
              </details>

              {panelChanged(p) && (
                <button className="link" onClick={() => { onChange({ ...draft, panels: { ...draft.panels, [role]: { ...IDENTITY_PANEL } } }); if (selected?.role === role) setSelected(null); }}>reset {role}</button>
              )}
            </div>
          );
        })}
      </Section>

      <Section title="Size and shape">
        <div className="grid3">
          <label className="small">Width (mm)<input type="number" step={0.5} value={specValue("pouch_closed_width_mm", g.width_mm)} onChange={(e) => setSpec("pouch_closed_width_mm", e.target.value)} /></label>
          <label className="small">Height (mm)<input type="number" step={0.5} value={specValue("pouch_height_mm", g.height_mm)} onChange={(e) => setSpec("pouch_height_mm", e.target.value)} /></label>
          {g.shape === "stand_up_bottom_gusset" && <label className="small">Gusset full (mm)<input type="number" step={0.5} value={specValue("gusset_full_width_mm", g.gusset_full_mm)} onChange={(e) => setSpec("gusset_full_width_mm", e.target.value)} /></label>}
          {KEYLINE_FIELDS.filter(([k]) => k in kl && kl[k]?.value !== null && (k !== "zipper_offset_from_top_mm" || zipperOn)).map(([k, label, unit]) => (
            <label key={k} className="small">{label} ({unit})<input type="number" step={unit === "%" ? 1 : 0.5} value={keyValue(k)} onChange={(e) => setKeyNum(k, e.target.value)} /></label>
          ))}
        </div>
        <div className="muted small">Width, height and gusset re-read the sheet (the panels are cut by these sizes); seals, zipper, notch, corners, fill and bulge preview instantly.</div>
      </Section>

      <Section title="Features: zipper, notch, hang hole, window">
        <div className="grid3">
          {"zipper_offset_from_top_mm" in kl && (
            <label className="check" style={{ alignSelf: "end" }}>
              <input type="checkbox" checked={zipperOn} onChange={(e) => setKey("zipper_offset_from_top_mm", e.target.checked ? (kl.zipper_offset_from_top_mm?.value ?? 30) : null)} /> Zipper
            </label>
          )}
          {"tear_notch_type" in kl && (
            <label className="small">Tear notch
              <select value={keyText("tear_notch_type")} onChange={(e) => setKey("tear_notch_type", e.target.value)}>{NOTCHES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </label>
          )}
          {"butterfly_notch" in kl && (
            <label className="check" style={{ alignSelf: "end" }}><input type="checkbox" checked={!!keyBool("butterfly_notch")} onChange={(e) => setKey("butterfly_notch", e.target.checked)} /> Butterfly notch</label>
          )}
          {"hang_hole_type" in kl && (
            <label className="small">Hang hole
              <select value={keyText("hang_hole_type")} onChange={(e) => setKey("hang_hole_type", e.target.value)}>{HANG_HOLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </label>
          )}
          {"hang_hole_type" in kl && keyText("hang_hole_type") !== "none" && (
            <>
              <label className="small">Hole size (mm)<input type="number" step={0.5} value={keyValue("hang_hole_size_mm")} onChange={(e) => setKeyNum("hang_hole_size_mm", e.target.value)} /></label>
              <label className="small">Hole from top (mm)<input type="number" step={0.5} value={keyValue("hang_hole_offset_mm")} onChange={(e) => setKeyNum("hang_hole_offset_mm", e.target.value)} /></label>
            </>
          )}
        </div>
        {"window_enabled" in kl && (
          <>
            <label className="check"><input type="checkbox" checked={!!windowOn} onChange={(e) => {
              const on = e.target.checked;
              const region: Record<string, number> = {};
              for (const [k] of WINDOW_FIELDS) {
                const v = draft.keyline[k] ?? kl[k]?.value;
                if (on && (v === null || v === undefined)) region[k] = { window_x_mm: Math.round(g.width_mm / 4), window_y_mm: Math.round(g.height_mm / 3), window_width_mm: Math.round(g.width_mm / 2), window_height_mm: Math.round(g.height_mm / 3), window_corner_radius_mm: 5 }[k]!;
              }
              onChange({ ...draft, keyline: { ...draft.keyline, ...region, window_enabled: on } });
            }} /> Transparent window</label>
            {windowOn && (
              <div className="grid3">
                {WINDOW_FIELDS.map(([k, label]) => (
                  <label key={k} className="small">{label} (mm)<input type="number" step={0.5} value={keyValue(k)} onChange={(e) => setKeyNum(k, e.target.value)} /></label>
                ))}
              </div>
            )}
          </>
        )}
        <div className="muted small">Positions are from the finished pouch's top-left corner. The window shows the film as clear where it sits.</div>
      </Section>

      <Section title="Material and finish">
        <div className="grid3">
          <label className="small">Finish
            <select value={draft.material.finish} onChange={(e) => onChange({ ...draft, material: { ...draft.material, finish: e.target.value as Draft["material"]["finish"] } })}>
              <option value="auto">Automatic ({job.outputs?.validate?.sheet?.spec_table?.finish?.value ?? "not stated"})</option><option value="matt">Matt</option><option value="gloss">Gloss</option>
            </select>
          </label>
          <label className="small">Metallic film
            <select value={draft.material.metallic} onChange={(e) => onChange({ ...draft, material: { ...draft.material, metallic: e.target.value as Draft["material"]["metallic"] } })}>
              <option value="auto">Automatic</option><option value="on">Show metal where unprinted</option><option value="off">No metal</option>
            </select>
          </label>
          {hasPlain && <label className="small">Plain panel colour<input type="color" value={draft.material.plain_color ?? "#dddddd"} onChange={(e) => onChange({ ...draft, material: { ...draft.material, plain_color: e.target.value } })} /></label>}
        </div>
        <div className="muted small">Finish and metal show under studio lighting; with exact print colours the artwork is drawn as printed.</div>
      </Section>

      <Section title="Scene and views">
        <div className="grid3">
          <label className="small">Colours / lighting
            <select value={draft.scene.lighting ?? g.preset.lighting} onChange={(e) => onChange({ ...draft, scene: { ...draft.scene, lighting: e.target.value as Draft["scene"]["lighting"] } })}>
              {LIGHTING.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
          <label className="small">Background (renders)
            <select value={bg.type === "gradient" && bg.colors.length >= 2 && bg.colors[0] === bg.colors[1] ? "solid" : bg.type} onChange={(e) => {
              const v = e.target.value;
              const type = (v === "solid" ? "gradient" : v) as "studio_white" | "transparent" | "gradient";
              const colors = v === "solid" ? ["#e9ecef", "#e9ecef"] : type === "gradient" ? ["#f4f5f7", "#d9dde3"] : [];
              onChange({ ...draft, scene: { ...draft.scene, background: { type, colors, image: null } } });
            }}>
              <option value="studio_white">White studio</option><option value="transparent">Transparent</option><option value="solid">One colour</option><option value="gradient">Gradient</option>
            </select>
          </label>
          {bg.type === "gradient" && bg.colors.length >= 2 && (
            <label className="small">{bg.colors[0] === bg.colors[1] ? "Colour" : "Top / bottom"}
              <span className="row">
                <input type="color" value={bg.colors[0]} onChange={(e) => onChange({ ...draft, scene: { ...draft.scene, background: { ...bg, colors: bg.colors[0] === bg.colors[1] ? [e.target.value, e.target.value] : [e.target.value, bg.colors[1]] } } })} />
                {bg.colors[0] !== bg.colors[1] && <input type="color" value={bg.colors[1]} onChange={(e) => onChange({ ...draft, scene: { ...draft.scene, background: { ...bg, colors: [bg.colors[0], e.target.value] } } })} />}
              </span>
            </label>
          )}
          <label className="check" style={{ alignSelf: "end" }}><input type="checkbox" checked={draft.scene.shadow ?? g.preset.shadow} onChange={(e) => onChange({ ...draft, scene: { ...draft.scene, shadow: e.target.checked } })} /> Contact shadow</label>
        </div>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <span className="small muted">Rendered views:</span>
          {VIEWS.map((v) => {
            const views = draft.scene.views ?? g.preset.views;
            return <label key={v} className="check small"><input type="checkbox" checked={views.includes(v)} onChange={(e) => onChange({ ...draft, scene: { ...draft.scene, views: e.target.checked ? [...views, v] : views.filter((x) => x !== v) } })} /> {v.replace(/_/g, " ")}</label>;
          })}
        </div>
        <div className="muted small">The viewer keeps a white background; the chosen background is used for the renders and the video. Snapshot buttons under the viewer save the current view.</div>
      </Section>

      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className="primary" disabled={busy || !dirty} onClick={() => onApply(saveDefault)}>Apply and re-render</button>
        <button disabled={busy} onClick={onReset}>Reset to automatic</button>
        {isAdmin && job.job?.item_code && <label className="check small"><input type="checkbox" checked={saveDefault} onChange={(e) => setSaveDefault(e.target.checked)} /> also save as default for {job.job.item_code}</label>}
      </div>
    </div>
  );
}

/** The flat panel with its logos and text: click to select, drag to move (positions in mm). */
function PanelArtEditor({ role, panel, texture, files, plainColour, selected, onSelect, onMove }: {
  role: string; panel: PanelDraft; texture: SceneData["textures"][string]; files: Record<string, SceneFile>; plainColour: string | null;
  selected: string | null; onSelect: (id: string | null) => void; onMove: (id: string, x: number, y: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pxPerMm, setPxPerMm] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPxPerMm(el.clientWidth / texture.width_mm));
    ro.observe(el);
    setPxPerMm(el.clientWidth / texture.width_mm);
    return () => ro.disconnect();
  }, [texture.width_mm]);
  const drag = useRef<{ id: string; x0: number; y0: number; ox: number; oy: number } | null>(null);
  const source = panel.source === "file" ? previewUrl(panel.file_id, files) : plainColour ? null : texture.raw_url ?? texture.url;
  const filter = [panel.brightness ? `brightness(${1 + panel.brightness / 100})` : "", panel.contrast ? `contrast(${1 + panel.contrast / 100})` : "", panel.saturation ? `saturate(${1 + panel.saturation / 100})` : ""].filter(Boolean).join(" ") || undefined;
  const fit = panel.source === "file" ? panel.fit : "stretch";
  return (
    <div ref={box} className="art-editor" style={{ aspectRatio: `${texture.width_mm} / ${texture.height_mm}` }} onPointerDown={() => onSelect(null)} title={`${role}: drag a logo or text to move it`}>
      <div className="art-base" style={{
        backgroundColor: plainColour ?? panel.background ?? "#ffffff",
        backgroundImage: source ? `url("${source}")` : undefined,
        backgroundSize: fit === "cover" ? "cover" : fit === "contain" ? "contain" : "100% 100%",
        filter,
      }} />
      {panel.overlays.map((o) => {
        const url = o.kind === "image" ? previewUrl(o.file_id, files) : null;
        const style: React.CSSProperties = {
          left: `${(o.x_mm / texture.width_mm) * 100}%`, top: `${(o.y_mm / texture.height_mm) * 100}%`,
          transform: `translate(-50%, -50%) rotate(${-o.rotation}deg)`, opacity: o.opacity,
        };
        return (
          <div key={o.id} className={`art-ov ${selected === o.id ? "on" : ""}`} style={style}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelect(o.id);
              drag.current = { id: o.id, x0: e.clientX, y0: e.clientY, ox: o.x_mm, oy: o.y_mm };
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || d.id !== o.id) return;
              onMove(o.id, Math.round((d.ox + (e.clientX - d.x0) / pxPerMm) * 2) / 2, Math.round((d.oy + (e.clientY - d.y0) / pxPerMm) * 2) / 2);
            }}
            onPointerUp={() => { drag.current = null; }}>
            {o.kind === "text" ? (
              <div className="art-text" style={{
                fontSize: o.size_mm * pxPerMm, fontFamily: FONT_CSS[o.font], fontWeight: o.bold ? 700 : 400, color: o.color, textAlign: o.align,
                background: o.background ?? "transparent", padding: o.background ? `${0.2 * o.size_mm * pxPerMm}px` : 0, lineHeight: 1.2,
              }}>{o.text || " "}</div>
            ) : url ? (
              <img src={url} alt="" draggable={false} style={{ width: o.width_mm * pxPerMm, height: o.height_mm ? o.height_mm * pxPerMm : "auto", display: "block" }} />
            ) : <div className="muted small">picture</div>}
          </div>
        );
      })}
    </div>
  );
}

function OverlayControls({ o, panel, files, onChange, onRemove, onOrder }: {
  o: Overlay; panel: SceneData["textures"][string]; files: Record<string, SceneFile>;
  onChange: (patch: Partial<Overlay>) => void; onRemove: () => void; onOrder: (dir: -1 | 1) => void;
}) {
  const name = o.file_id ? files[String(o.file_id)]?.filename ?? `upload #${o.file_id}` : "";
  return (
    <div className="stack art-controls">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b className="small">{o.kind === "text" ? "Text" : `Logo ${name}`}</b>
        <span className="row">
          <button className="link" title="behind the next one" onClick={() => onOrder(-1)}>↓ back</button>
          <button className="link" title="in front of the next one" onClick={() => onOrder(1)}>↑ front</button>
          <button className="link" onClick={onRemove}>remove</button>
        </span>
      </div>
      {o.kind === "text" && (
        <>
          <textarea rows={2} value={o.text} onChange={(e) => onChange({ text: e.target.value })} placeholder="Text (Enter for a new line)" />
          <div className="grid3">
            <label className="small">Size (mm)<input type="number" step={0.5} min={1} value={o.size_mm} onChange={(e) => onChange({ size_mm: Math.max(0.5, Number(e.target.value)) })} /></label>
            <label className="small">Font
              <select value={o.font} onChange={(e) => onChange({ font: e.target.value as Overlay["font"] })}><option value="sans">Sans</option><option value="serif">Serif</option><option value="mono">Mono</option></select>
            </label>
            <label className="small">Align
              <select value={o.align} onChange={(e) => onChange({ align: e.target.value as Overlay["align"] })}><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select>
            </label>
            <label className="small">Colour<input type="color" value={o.color} onChange={(e) => onChange({ color: e.target.value })} /></label>
            <label className="check" style={{ alignSelf: "end" }}><input type="checkbox" checked={o.bold} onChange={(e) => onChange({ bold: e.target.checked })} /> Bold</label>
            <label className="check" style={{ alignSelf: "end" }}>
              <input type="checkbox" checked={o.background !== null} onChange={(e) => onChange({ background: e.target.checked ? "#ffffff" : null })} /> Box
              {o.background !== null && <input type="color" value={o.background} onChange={(e) => onChange({ background: e.target.value })} />}
            </label>
          </div>
        </>
      )}
      {o.kind === "image" && (
        <div className="grid3">
          <label className="small">Width (mm)<input type="number" step={0.5} min={1} value={o.width_mm} onChange={(e) => onChange({ width_mm: Math.max(0.5, Number(e.target.value)) })} /></label>
          <label className="small">Height (mm)<input type="number" step={0.5} min={0} value={o.height_mm ?? ""} placeholder="keeps proportions" onChange={(e) => onChange({ height_mm: e.target.value === "" || Number(e.target.value) <= 0 ? null : Number(e.target.value) })} /></label>
        </div>
      )}
      <div className="grid3">
        <label className="small">From left (mm)<input type="number" step={0.5} value={o.x_mm} onChange={(e) => onChange({ x_mm: Number(e.target.value) })} /></label>
        <label className="small">From top (mm)<input type="number" step={0.5} value={o.y_mm} onChange={(e) => onChange({ y_mm: Number(e.target.value) })} /></label>
        <button className="small" onClick={() => onChange({ x_mm: Math.round(panel.width_mm / 2 * 2) / 2, y_mm: Math.round(panel.height_mm / 2 * 2) / 2 })} style={{ alignSelf: "end" }}>Centre</button>
      </div>
      <label className="small">Rotation {o.rotation}°
        <input type="range" min={-180} max={180} step={1} value={o.rotation} onChange={(e) => onChange({ rotation: Number(e.target.value) })} />
      </label>
      <label className="small">Opacity {Math.round(o.opacity * 100)}%
        <input type="range" min={0.05} max={1} step={0.05} value={o.opacity} onChange={(e) => onChange({ opacity: Number(e.target.value) })} />
      </label>
    </div>
  );
}
