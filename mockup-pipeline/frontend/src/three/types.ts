// Mirrors app/geometry/spec.py (GeometrySpec). All lengths in millimetres; 1 three.js unit = 1 mm.

export interface Preset {
  name: string;
  views: string[];
  width_px: number;
  height_px: number;
  background: { type: "studio_white" | "transparent" | "gradient" | "custom_image"; colors: string[]; image: string | null };
  shadow: boolean;
  shadow_opacity: number;
  lighting: "exact" | "studio_soft" | "studio_hard" | "daylight" | "product_dramatic";
  formats: string[];
  turntable_seconds: number;
  turntable_fps: number;
  naming_pattern: string;
}

/** A shrink sleeve and the container it is shrunk onto (app/geometry/sleeve.py). */
export interface Sleeve {
  container: string; name: string; shape: "can" | "tin" | "bottle" | "jar" | "pot"; chosen_by: "job" | "words" | "default";
  diameter_mm: number; container_height_mm: number; sleeve_height_mm: number; printed_width_mm: number;
  layflat_mm: number; circumference_mm: number; overlap_mm: number; sleeve_from: number; sleeve_to: number;
  front_center_pct: number; lid: boolean; neck_ratio: number; body_color: string; cap_color: string; material: "metal" | "plastic" | "glass" | "clear";
}

export interface GeometrySpec {
  version: number;
  template: string;
  shape: string;
  width_mm: number;
  height_mm: number;
  gusset_full_mm: number;
  gusset_depth_mm: number;
  side_gusset_full_mm: number;
  side_gusset_depth_mm: number;
  seals: { top: number; bottom: number; side: number; fin: number; crimp: number };
  zipper: { enabled: boolean; y_from_top_mm: number; ridge_height_mm: number };
  tear_notch: { type: string; y_from_top_mm: number; depth_mm: number };
  butterfly_notch: boolean;
  corner_radius_mm: number;
  hang_hole: { type: string; size_mm: number; offset_mm: number };
  window: { enabled: boolean; x_mm: number; y_mm: number; width_mm: number; height_mm: number; radius_mm: number; shapes?: WindowShape[] };
  spout: { position: string; diameter_mm: number; cap_diameter_mm: number; cap_height_mm: number } | null;
  valve?: { panel: "front" | "back"; x_mm: number; y_from_top_mm: number; diameter_mm: number } | null;
  roll: { repeat_mm: number; web_width_mm: number; outer_diameter_mm: number; core_diameter_mm: number } | null;
  sleeve?: Sleeve | null;
  body_bulge_percent: number;
  fill_level_percent: number;
  outline_svg: string | null;
  panels: Record<string, { width_mm: number; height_mm: number }>;
  materials: { surfaces: Record<string, Record<string, number>>; applied: Record<string, string[]> };
  preset: Preset;
  preset_key: string;
  dimensions: { label: string; value_mm: number; kind: string }[];
}

/** Job-page adjustment of one panel's artwork placement (mirrors app/workflow/adjust.py PanelAdjust). */
export interface PanelTransform {
  rotation: number; // degrees, 0 or 180 (90 / 270 only for square panels)
  flip_x: boolean;
  flip_y: boolean;
  offset_x_mm: number; // move the artwork right (+) / left (-)
  offset_y_mm: number; // move the artwork up (+) / down (-)
  scale: number; // 1 = as printed
}

/** A logo or text drawn on a panel (mirrors app/workflow/adjust.py Overlay); mm from the panel's top-left. */
export interface Overlay {
  id: string;
  kind: "image" | "text";
  file_id: number | null;
  text: string;
  x_mm: number;
  y_mm: number;
  width_mm: number;
  height_mm: number | null;
  size_mm: number;
  rotation: number;
  opacity: number;
  color: string;
  background: string | null;
  font: "sans" | "serif" | "mono";
  bold: boolean;
  align: "left" | "center" | "right";
}

/** What the preview draws into a panel's texture on a canvas (the texture step bakes the same
 *  things server-side): a replacement picture fitted to the panel, colour correction, overlays. */
export interface PanelBake {
  source_url: string | null; // a replacement picture (an upload's preview); null = the panel's own texture
  fit: "cover" | "contain" | "stretch";
  background: string | null;
  brightness: number;
  contrast: number;
  saturation: number;
  overlays: (Overlay & { url?: string | null })[];
}

export interface SceneTexture {
  url: string;
  width_mm: number;
  height_mm: number;
  color: string | null;
  clear?: boolean; // transparent unprinted film
  masks: { metal?: string; spot?: string; window?: string }; // window: alpha mask, clear film where dark
  transform?: PanelTransform | null;
  bake?: PanelBake | null;
  raw_url?: string | null; // the texture before the job's overlays / colour correction were baked in
}

export interface SceneFile {
  filename: string;
  kind: "image" | "pdf";
  preview_url: string;
}

export interface SceneData {
  job_id: number;
  geometry: GeometrySpec;
  textures: Record<string, SceneTexture>;
  adjust?: Record<string, unknown>; // the job's saved adjustments (app/workflow/adjust.py)
  files?: Record<string, SceneFile>; // the uploads those adjustments use (panel pictures, logos)
  // other designs printed on the same sheet (FGPO6443: three flavours), each a full set of textures;
  // empty for a one-design sheet
  designs?: { index: number; name: string; textures: Record<string, SceneTexture> }[];
}

/** A see-through window the operator marks on the front or back face (app/workflow/adjust.py
 *  WindowShape). Points are texture coordinates, 0..1 from the face texture's top-left: a free
 *  shape's outline, a rectangle's two corners, or the one point a "pick area" window grows from. */
export interface WindowShape {
  face: "front" | "back";
  kind: "free" | "rect" | "wand";
  points: [number, number][];
  tolerance?: number;
}
