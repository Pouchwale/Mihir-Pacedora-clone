// The job page's adjustments as a live preview: `applyDraft` turns the scene the server sent plus
// the operator's draft into the geometry / textures the viewer builds. The same numbers go to
// POST /api/jobs/{id}/adjust, where the workflow applies them for real (renders, GLB, video).
// Mirrors app/workflow/adjust.py.
import type { GeometrySpec, Overlay, PanelBake, PanelTransform, SceneData, SceneFile, SceneTexture, WindowShape } from "./types";

export interface PanelDraft extends PanelTransform {
  source: "auto" | "sheet" | "file" | "front" | "plain" | `sheet:${number}`;
  sheet_panel: number | null;
  file_id: number | null;
  fit: "cover" | "contain" | "stretch";
  background: string | null;
  color: string | null;
  brightness: number;
  contrast: number;
  saturation: number;
  overlays: Overlay[];
}

export interface Draft {
  panels: Record<string, PanelDraft>;
  swap_front_back: boolean;
  specs: Record<string, number | string | null>;
  keyline: Record<string, number | string | boolean | null>;
  material: { finish: "auto" | "matt" | "gloss"; metallic: "auto" | "on" | "off"; plain_color: string | null };
  scene: { lighting: GeometrySpec["preset"]["lighting"] | null; background: GeometrySpec["preset"]["background"] | null; shadow: boolean | null; views: string[] | null };
  windows: WindowShape[]; // clear windows marked on the pouch in the 3D viewer
}

export const IDENTITY_PANEL: PanelDraft = {
  source: "auto", sheet_panel: null, file_id: null, fit: "cover", background: null, color: null,
  rotation: 0, flip_x: false, flip_y: false, offset_x_mm: 0, offset_y_mm: 0, scale: 1,
  brightness: 0, contrast: 0, saturation: 0, overlays: [],
};

export const DEFAULT_OVERLAY: Overlay = {
  id: "", kind: "text", file_id: null, text: "", x_mm: 0, y_mm: 0, width_mm: 30, height_mm: null, size_mm: 8,
  rotation: 0, opacity: 1, color: "#000000", background: null, font: "sans", bold: false, align: "center",
};

export function emptyDraft(): Draft {
  return { panels: {}, swap_front_back: false, specs: {}, keyline: {}, material: { finish: "auto", metallic: "auto", plain_color: null }, scene: { lighting: null, background: null, shadow: null, views: null }, windows: [] };
}

/** The saved adjustments of a job (from /scene) as a draft to edit. */
export function draftFrom(saved: Partial<Draft> | null | undefined): Draft {
  const d = emptyDraft();
  if (!saved) return d;
  for (const [role, p] of Object.entries(saved.panels ?? {})) {
    d.panels[role] = { ...IDENTITY_PANEL, ...p, overlays: (p.overlays ?? []).map((o) => ({ ...DEFAULT_OVERLAY, ...o })) };
  }
  d.swap_front_back = !!saved.swap_front_back;
  d.specs = { ...(saved.specs ?? {}) };
  d.keyline = { ...(saved.keyline ?? {}) };
  d.material = { ...d.material, ...(saved.material ?? {}) };
  d.scene = { ...d.scene, ...(saved.scene ?? {}) };
  d.windows = saved.windows ?? [];
  return d;
}

export function panelOf(d: Draft, role: string): PanelDraft {
  return d.panels[role] ?? IDENTITY_PANEL;
}

/** Whether a panel's draft differs from "as the pipeline decided" (for the per-panel reset link). */
export function panelChanged(p: PanelDraft): boolean {
  return p.source !== "auto" || !!p.rotation || p.flip_x || p.flip_y || !!p.offset_x_mm || !!p.offset_y_mm || p.scale !== 1
    || !!p.brightness || !!p.contrast || !!p.saturation || p.overlays.length > 0;
}

function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : null;
}

function solidColourUrl(color: string): string {
  const c = document.createElement("canvas");
  c.width = c.height = 8;
  const x = c.getContext("2d")!;
  x.fillStyle = color;
  x.fillRect(0, 0, 8, 8);
  return c.toDataURL("image/png");
}

const FINISH: Record<string, Record<string, number>> = {
  matt: { roughness: 0.85, clearcoat: 0, specular_intensity: 0.25 },
  gloss: { roughness: 0.2, clearcoat: 1, clearcoat_roughness: 0.05, specular_intensity: 0.8 },
};

/** The preview URL of an upload the draft refers to (from the scene's file list, or a fresh upload's). */
export function previewUrl(fileId: number | null, files: Record<string, SceneFile> | undefined): string | null {
  if (!fileId) return null;
  return files?.[String(fileId)]?.preview_url ?? `/api/uploads/${fileId}/preview`;
}

/** What the preview has to draw into a panel's texture (null: nothing beyond the texture matrix). */
export function bakeOf(p: PanelDraft | undefined, files: Record<string, SceneFile> | undefined): PanelBake | null {
  if (!p) return null;
  const source_url = p.source === "file" ? previewUrl(p.file_id, files) : null;
  if (!source_url && !p.brightness && !p.contrast && !p.saturation && p.overlays.length === 0) return null;
  return {
    source_url, fit: p.fit, background: p.background, brightness: p.brightness, contrast: p.contrast, saturation: p.saturation,
    overlays: p.overlays.map((o) => ({ ...o, url: o.kind === "image" ? previewUrl(o.file_id, files) : null })),
  };
}

/** Geometry and textures with the draft applied (a deep copy; the scene itself is never changed). */
export function applyDraft(scene: SceneData, draft: Draft | null): { geometry: GeometrySpec; textures: Record<string, SceneTexture> } {
  const g: GeometrySpec = JSON.parse(JSON.stringify(scene.geometry));
  const textures: Record<string, SceneTexture> = JSON.parse(JSON.stringify(scene.textures));
  if (!draft) return { geometry: g, textures };

  // --- size (spec table values)
  const w = num(draft.specs.pouch_closed_width_mm), h = num(draft.specs.pouch_height_mm), gf = num(draft.specs.gusset_full_width_mm);
  if (w) g.width_mm = w;
  if (h) g.height_mm = h;
  if (gf !== null && g.shape === "stand_up_bottom_gusset") {
    g.gusset_full_mm = gf;
    g.gusset_depth_mm = gf / 2;
  }
  for (const role of Object.keys(g.panels)) {
    if (["front", "back"].includes(role)) g.panels[role] = { width_mm: g.width_mm, height_mm: g.height_mm };
    if (role === "gusset") g.panels[role] = { width_mm: g.width_mm, height_mm: g.gusset_full_mm };
  }

  // --- keyline values
  const k = draft.keyline;
  const set = (key: string, fn: (v: number) => void) => { const v = num(k[key]); if (v !== null) fn(v); };
  set("top_seal_mm", (v) => { g.seals.top = v; });
  set("bottom_seal_mm", (v) => { g.seals.bottom = v; });
  set("side_seal_mm", (v) => { g.seals.side = v; });
  set("fin_seal_mm", (v) => { g.seals.fin = v; });
  set("crimp_height_mm", (v) => { g.seals.crimp = v; });
  set("zipper_offset_from_top_mm", (v) => { g.zipper.enabled = true; g.zipper.y_from_top_mm = v; });
  set("zipper_ridge_height_mm", (v) => { g.zipper.ridge_height_mm = v; });
  set("tear_notch_offset_mm", (v) => { g.tear_notch.y_from_top_mm = v; });
  set("corner_radius_mm", (v) => { g.corner_radius_mm = v; });
  set("gusset_depth_mm", (v) => { g.gusset_depth_mm = v; if (!gf) g.gusset_full_mm = 2 * v; });
  set("side_gusset_depth_mm", (v) => { g.side_gusset_depth_mm = v; g.side_gusset_full_mm = 2 * v; });
  set("body_bulge_percent", (v) => { g.body_bulge_percent = v; });
  set("fill_level_percent", (v) => { g.fill_level_percent = v; });
  set("hang_hole_size_mm", (v) => { g.hang_hole.size_mm = v; });
  set("hang_hole_offset_mm", (v) => { g.hang_hole.offset_mm = v; });
  set("window_x_mm", (v) => { g.window.x_mm = v; });
  set("window_y_mm", (v) => { g.window.y_mm = v; });
  set("window_width_mm", (v) => { g.window.width_mm = v; });
  set("window_height_mm", (v) => { g.window.height_mm = v; });
  set("window_corner_radius_mm", (v) => { g.window.radius_mm = v; });
  if (typeof k.tear_notch_type === "string") g.tear_notch.type = k.tear_notch_type;
  if (typeof k.hang_hole_type === "string") g.hang_hole.type = k.hang_hole_type;
  if (typeof k.butterfly_notch === "boolean") g.butterfly_notch = k.butterfly_notch;
  if (typeof k.window_enabled === "boolean") g.window.enabled = k.window_enabled && g.window.width_mm > 0 && g.window.height_mm > 0;
  if (k.zipper_offset_from_top_mm === null) g.zipper.enabled = false;
  for (const d of g.dimensions) {
    if (d.kind === "width") d.value_mm = g.width_mm;
    if (d.kind === "height") d.value_mm = g.height_mm;
    if (d.kind === "gusset") d.value_mm = g.gusset_full_mm;
  }

  // --- material
  const base = g.materials.surfaces.base ?? {};
  if (draft.material.finish !== "auto") g.materials.surfaces.base = { ...base, ...FINISH[draft.material.finish] };
  if (draft.material.metallic === "on") g.materials.surfaces.white_less = { metalness: 1, roughness: 0.3, specular_intensity: 1 };
  if (draft.material.metallic === "off") delete g.materials.surfaces.white_less;

  // --- scene
  if (draft.scene.lighting) g.preset.lighting = draft.scene.lighting;
  if (draft.scene.shadow !== null) g.preset.shadow = draft.scene.shadow;
  if (draft.scene.background) g.preset.background = draft.scene.background;
  if (draft.scene.views) g.preset.views = draft.scene.views;
  g.window.shapes = draft.windows ?? [];

  // --- artwork
  // the scene's textures already have the saved swap applied (link_panels): swap only what changed since
  const savedSwap = !!(scene.adjust as { swap_front_back?: boolean } | undefined)?.swap_front_back;
  if (draft.swap_front_back !== savedSwap && textures.front && textures.back) [textures.front, textures.back] = [textures.back, textures.front];
  const frontBake = bakeOf(draft.panels.front, scene.files);
  for (const [role, t] of Object.entries(textures)) {
    const p = draft.panels[role];
    if (p?.source === "front" && textures.front && role !== "front") {
      // the front's artwork as the front will look (its own picture / overlays), placed as this panel says
      textures[role] = { ...scene.textures.front, transform: null, bake: frontBake, masks: frontBake?.source_url ? {} : scene.textures.front.masks };
      if (!p.overlays.length && !p.brightness && !p.contrast && !p.saturation) {
        if (p.rotation || p.flip_x || p.flip_y || p.offset_x_mm || p.offset_y_mm || p.scale !== 1) {
          textures[role] = { ...textures[role], transform: { rotation: p.rotation, flip_x: p.flip_x, flip_y: p.flip_y, offset_x_mm: p.offset_x_mm, offset_y_mm: p.offset_y_mm, scale: p.scale } };
        }
        continue;
      }
      // this panel's own overlays go on top of the front's artwork
      const own = bakeOf(p, scene.files)!;
      textures[role] = { ...textures[role], bake: { ...own, source_url: frontBake?.source_url ?? null, fit: frontBake?.fit ?? own.fit, background: frontBake?.background ?? own.background,
        overlays: [...(frontBake?.overlays ?? []), ...own.overlays] } };
      if (p.rotation || p.flip_x || p.flip_y || p.offset_x_mm || p.offset_y_mm || p.scale !== 1) {
        textures[role] = { ...textures[role], transform: { rotation: p.rotation, flip_x: p.flip_x, flip_y: p.flip_y, offset_x_mm: p.offset_x_mm, offset_y_mm: p.offset_y_mm, scale: p.scale } };
      }
      continue;
    }
    const colour = p?.source === "plain" ? p.color ?? draft.material.plain_color : t.color ? draft.material.plain_color ?? t.color : null;
    if (colour && (p?.source === "plain" || t.color)) textures[role] = { ...textures[role], url: solidColourUrl(colour), color: colour, masks: {} };
    if (p && (p.rotation || p.flip_x || p.flip_y || p.offset_x_mm || p.offset_y_mm || p.scale !== 1)) {
      textures[role] = { ...textures[role], transform: { rotation: p.rotation, flip_x: p.flip_x, flip_y: p.flip_y, offset_x_mm: p.offset_x_mm, offset_y_mm: p.offset_y_mm, scale: p.scale } };
    } else if (p) {
      textures[role] = { ...textures[role], transform: null };
    }
    // a replacement picture, colour correction and overlays: drawn into the texture by the viewer
    // (the texture step bakes the same into the finished image when applied)
    const bake = bakeOf(p, scene.files);
    if (bake) textures[role] = { ...textures[role], bake, masks: bake.source_url ? {} : textures[role].masks };
  }
  return { geometry: g, textures };
}
