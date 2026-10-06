// The flat dieline of a job, drawn in the browser from the same geometry and textures the 3D viewer
// builds (applyDraft), so the studio shows every draft edit at once. Mirrors app/geometry/dieline.py
// (seal zones, zipper, notches, corners, hang hole, window, folds) and the 3D artwork placement
// (pouch.ts panelMap: the texture matrix), so the flat view and the 3D model always agree.
import * as THREE from "three";
import type { GeometrySpec, Overlay, SceneTexture, WindowShape } from "./types";

export const GAP_MM = 30; // between panels on the sheet
export const MARGIN_MM = 28; // around the sheet: dimension lines and labels
export const BLEED_MM = 3;
export const SAFE_MM = 3; // keep text and logos this far inside the seals / cut line

export interface PanelBox {
  role: string;
  x: number; // left of the panel on the sheet, mm
  y: number;
  w: number;
  h: number;
  face: boolean; // front / back: seals, zipper, notches, hang hole, windows
}

const ORDER = ["front", "back", "gusset", "side_left", "side_right", "bottom", "roll"];

/** The panels side by side on one sheet (front, back, then gusset / sides), each its real size. */
export function layoutPanels(textures: Record<string, SceneTexture>): { panels: PanelBox[]; width: number; height: number } {
  const rank = (r: string) => (ORDER.includes(r) ? ORDER.indexOf(r) : ORDER.length);
  const roles = Object.keys(textures).sort((a, b) => rank(a) - rank(b));
  let x = 0;
  const panels = roles.map((role) => {
    const t = textures[role];
    const p = { role, x, y: 0, w: t.width_mm, h: t.height_mm, face: role === "front" || role === "back" };
    x += t.width_mm + GAP_MM;
    return p;
  });
  return { panels, width: Math.max(0, x - GAP_MM), height: Math.max(0, ...panels.map((p) => p.h)) };
}

/** Matrix taking the artwork's own mm (texture space, overlays are placed in it) to the panel's
 *  surface mm: exactly the texture matrix the 3D model uses (THREE.Matrix3.setUvTransform). */
export function artworkMatrix(t: SceneTexture): THREE.Matrix3 {
  const W = t.width_mm, H = t.height_mm, tr = t.transform;
  if (!tr) return new THREE.Matrix3();
  const s = 1 / (tr.scale || 1);
  const T = new THREE.Matrix3().setUvTransform(-(tr.offset_x_mm || 0) / W, -(tr.offset_y_mm || 0) / H,
    (tr.flip_x ? -1 : 1) * s, (tr.flip_y ? -1 : 1) * s, (tr.rotation * Math.PI) / 180, 0.5, 0.5);
  const S = new THREE.Matrix3().set(1 / W, 0, 0, 0, -1 / H, 1, 0, 0, 1); // surface mm -> surface uv
  const Q = new THREE.Matrix3().set(W, 0, 0, 0, -H, H, 0, 0, 1); // texture uv -> texture mm
  return Q.multiply(T).multiply(S).invert(); // (surface mm -> texture mm)^-1
}

export function svgMatrix(m: THREE.Matrix3): string {
  const e = m.elements;
  return `matrix(${e[0]} ${e[1]} ${e[3]} ${e[4]} ${e[6]} ${e[7]})`;
}

export function apply(m: THREE.Matrix3, x: number, y: number): [number, number] {
  const v = new THREE.Vector3(x, y, 1).applyMatrix3(m);
  return [v.x, v.y];
}

/** Seal areas of a face, panel mm: [x, y, w, h] rectangles plus the K-seal corner triangles. */
export function sealZones(g: GeometrySpec, w: number, h: number): { rects: [number, number, number, number][]; kseal: [number, number][][] } {
  const s = g.seals, rects: [number, number, number, number][] = [], kseal: [number, number][][] = [];
  if (s.side) rects.push([0, 0, s.side, h], [w - s.side, 0, s.side, h]);
  const top = s.top || s.crimp, bottom = s.bottom || s.crimp;
  if (top) rects.push([0, 0, w, top]);
  if (bottom) rects.push([0, h - bottom, w, bottom]);
  if (g.shape === "stand_up_bottom_gusset" && g.gusset_depth_mm) {
    const gd = g.gusset_depth_mm, k = Math.min(gd, w / 3);
    kseal.push([[0, h - gd], [k, h], [0, h]], [[w, h - gd], [w - k, h], [w, h]]);
  }
  return { rects, kseal };
}

/** The printable safe area of a panel: inside the seals (faces) and SAFE_MM from every edge. */
export function safeRect(g: GeometrySpec, p: PanelBox): [number, number, number, number] {
  if (!p.face) return [SAFE_MM, SAFE_MM, p.w - 2 * SAFE_MM, p.h - 2 * SAFE_MM];
  const s = g.seals, top = (s.top || s.crimp) + SAFE_MM, bottom = (s.bottom || s.crimp) + SAFE_MM, side = s.side + SAFE_MM;
  return [side, top, Math.max(0, p.w - 2 * side), Math.max(0, p.h - top - bottom)];
}

/** Rough box of an overlay in its artwork's mm (centre, size), before its rotation. */
export function overlayBox(o: Overlay, aspect = 1): { w: number; h: number } {
  if (o.kind === "image") return { w: o.width_mm, h: o.height_mm ?? o.width_mm / (aspect || 1) };
  const lines = (o.text || " ").split("\n");
  const longest = Math.max(...lines.map((l) => l.length), 1);
  return { w: longest * o.size_mm * 0.56 + (o.background ? o.size_mm * 0.4 : 0), h: lines.length * o.size_mm * 1.2 + (o.background ? o.size_mm * 0.4 : 0) };
}

/** Corners of an overlay on the panel surface (mm). */
export function overlayCorners(o: Overlay, m: THREE.Matrix3, aspect = 1): [number, number][] {
  const { w, h } = overlayBox(o, aspect);
  const a = (-o.rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as [number, number][])
    .map(([x, y]) => apply(m, o.x_mm + x * c - y * s, o.y_mm + x * s + y * c));
}

function boxOf(pts: [number, number][]): [number, number, number, number] {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function hits(a: [number, number, number, number], r: [number, number, number, number]): boolean {
  return a[0] < r[0] + r[2] && a[2] > r[0] && a[1] < r[1] + r[3] && a[3] > r[1];
}

function inside(pt: [number, number], poly: [number, number][]): boolean {
  let ok = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) ok = !ok;
  }
  return ok;
}

/** Window shape points in panel mm (rect: its 4 corners; free: the outline). */
export function windowPoints(w: WindowShape, p: PanelBox): [number, number][] {
  const pts = w.points.map(([u, v]) => [u * p.w, v * p.h] as [number, number]);
  if (w.kind === "rect" && pts.length >= 2) {
    const [a, b] = pts;
    return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
  }
  return pts;
}

export interface Check {
  level: "warn" | "bad";
  role: string;
  message: string;
  target?: { kind: "overlay"; id: string } | { kind: "window"; index: number } | { kind: "panel" } | { kind: "line"; key: string };
}

/** What would print or seal badly: text / logos in the seals or past the safe margin, artwork that
 *  leaves part of a panel bare, windows across a seal, zipper / notch / hang hole in the wrong place. */
export function checks(g: GeometrySpec, textures: Record<string, SceneTexture>, panels: PanelBox[], windows: WindowShape[], aspects: Record<string, number> = {}): Check[] {
  const out: Check[] = [];
  for (const p of panels) {
    const t = textures[p.role];
    if (!t || t.clear) continue;
    const m = artworkMatrix(t);
    const seals = p.face ? sealZones(g, p.w, p.h).rects : [];
    const safe = safeRect(g, p);
    for (const o of t.bake?.overlays ?? []) {
      const b = boxOf(overlayCorners(o, m, aspects[String(o.file_id)]));
      const name = o.kind === "text" ? `Text "${(o.text || "").slice(0, 24)}"` : "A logo";
      if (b[2] < 0 || b[3] < 0 || b[0] > p.w || b[1] > p.h) out.push({ level: "bad", role: p.role, message: `${name} on the ${p.role} is off the panel`, target: { kind: "overlay", id: o.id } });
      else if (seals.some((r) => hits(b, r))) out.push({ level: "bad", role: p.role, message: `${name} on the ${p.role} runs into a seal`, target: { kind: "overlay", id: o.id } });
      else if (b[0] < safe[0] || b[1] < safe[1] || b[2] > safe[0] + safe[2] || b[3] > safe[1] + safe[3]) out.push({ level: "warn", role: p.role, message: `${name} on the ${p.role} is within ${SAFE_MM} mm of a seal or the cut`, target: { kind: "overlay", id: o.id } });
    }
    if (!t.color && t.transform) {
      const art = [apply(m, 0, 0), apply(m, p.w, 0), apply(m, p.w, p.h), apply(m, 0, p.h)];
      const bare = ([[0.5, 0.5], [p.w - 0.5, 0.5], [p.w - 0.5, p.h - 0.5], [0.5, p.h - 0.5]] as [number, number][]).some((c) => !inside(c, art));
      if (bare) out.push({ level: "warn", role: p.role, message: `The ${p.role} artwork does not cover the whole panel (moved or scaled down)`, target: { kind: "panel" } });
    }
  }
  const face = panels.find((p) => p.face);
  if (face) {
    const s = g.seals, top = s.top || s.crimp;
    windows.forEach((w, i) => {
      const p = panels.find((q) => q.role === w.face);
      if (!p || w.kind === "wand") return;
      const b = boxOf(windowPoints(w, p));
      if (sealZones(g, p.w, p.h).rects.some((r) => hits(b, r))) out.push({ level: "bad", role: p.role, message: `Window ${i + 1} on the ${p.role} crosses a seal (seals cannot be clear)`, target: { kind: "window", index: i } });
    });
    if (g.zipper.enabled) {
      const zy = g.zipper.y_from_top_mm;
      if (zy <= top) out.push({ level: "bad", role: face.role, message: `The zipper (${zy} mm) is inside the top seal (${top} mm)`, target: { kind: "line", key: "zipper_offset_from_top_mm" } });
      if (zy > face.h / 2) out.push({ level: "warn", role: face.role, message: `The zipper is more than half way down the pouch (${zy} mm)`, target: { kind: "line", key: "zipper_offset_from_top_mm" } });
      if (g.tear_notch.type !== "none" && g.tear_notch.y_from_top_mm >= zy) out.push({ level: "warn", role: face.role, message: "The tear notch is below the zipper: the pouch would tear open under it", target: { kind: "line", key: "tear_notch_offset_mm" } });
      if (g.hang_hole.type !== "none" && Math.abs(g.hang_hole.offset_mm - zy) < g.hang_hole.size_mm / 2 + 2) out.push({ level: "bad", role: face.role, message: "The hang hole cuts through the zipper", target: { kind: "line", key: "hang_hole_offset_mm" } });
    }
    if (g.tear_notch.type !== "none" && g.tear_notch.y_from_top_mm > face.h - (s.bottom || s.crimp)) out.push({ level: "warn", role: face.role, message: "The tear notch is in the bottom seal", target: { kind: "line", key: "tear_notch_offset_mm" } });
    if (g.hang_hole.type !== "none" && g.hang_hole.offset_mm + g.hang_hole.size_mm / 2 > top && !g.zipper.enabled) out.push({ level: "warn", role: face.role, message: "The hang hole reaches below the top seal: it would open the pouch", target: { kind: "line", key: "hang_hole_offset_mm" } });
  }
  return out;
}

/** "1 2 5" steps: the ruler / grid spacing in mm that keeps ticks at least `minPx` apart. */
export function niceStep(pxPerMm: number, minPx = 60): number {
  for (const s of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) if (s * pxPerMm >= minPx) return s;
  return 2000;
}
