// The hang hole's shape, one definition for the 3D cut mask (surface.ts), the dieline editor
// (KeylineWorkspace) and its checks (dieline.ts). Mirrors app/geometry/spec.py (hang_hole_dims /
// hang_hole_path): change both together.
//
// "Butterfly Notch: Yes" on the spec table is the butterfly (sombrero) hang hole at the top centre,
// never a second tear notch (FGPO7700 / 7570 / 0928).
import type { GeometrySpec } from "./types";

export type HangHoleType = "none" | "round" | "euro" | "butterfly";

export interface HangHole {
  type: HangHoleType;
  size_mm: number; // round: diameter; euro / butterfly: slot height
  offset_mm: number; // slot (circle) centre below the top edge
  width_mm: number; // euro / butterfly: overall width (0 = 3.2 x size)
  height_mm: number; // butterfly: dome top to slot bottom (0 = 1.6 x size)
}

const KNOWN = new Set(["round", "euro", "butterfly"]);

/** The hole a face gets. Geometry files written before the butterfly fix carry
 *  `butterfly_notch: true` and no hole: they get the usual butterfly hole too. */
export function hangHoleOf(g: GeometrySpec, panelWidthMm: number): HangHole {
  const h = g.hang_hole ?? { type: "none", size_mm: 8, offset_mm: 10 };
  const type = (KNOWN.has(h.type) ? h.type : "none") as HangHoleType;
  if (type === "none" && g.butterfly_notch) {
    return { type: "butterfly", size_mm: 6, offset_mm: h.offset_mm || 10, width_mm: Math.min(30, panelWidthMm * 0.3), height_mm: 0 };
  }
  return { type, size_mm: h.size_mm, offset_mm: h.offset_mm, width_mm: h.width_mm ?? 0, height_mm: h.height_mm ?? 0 };
}

/** The face's hole switched to `type` (the job page's choice), sized the way the server will size
 *  it (geometry/spec.py resolve_hang_hole): the same type keeps its size; a newly chosen butterfly
 *  gets the usual sombrero (6 mm slot, 30 mm wide) unless the operator typed sizes. */
export function holeAsType(current: HangHole, type: string, panelWidthMm: number, typed: { size?: number | null; width?: number | null } = {}): HangHole {
  const t = (KNOWN.has(type) ? type : "none") as HangHoleType;
  let h: HangHole = { ...current, type: t };
  if (t !== current.type) {
    h = t === "butterfly" ? { ...h, size_mm: 6, width_mm: Math.min(30, panelWidthMm * 0.3), height_mm: 0 }
      : { ...h, size_mm: 8, width_mm: 0, height_mm: 0 }; // the template default: another type's drawn size does not carry over
  }
  if (typed.size != null) h.size_mm = typed.size;
  if (typed.width != null) h.width_mm = typed.width;
  return h;
}

/** [width, slot height, dome rise above the slot, dome radius] in mm. */
export function hangHoleDims(h: HangHole, panelWidthMm: number): [number, number, number, number] {
  const s = Math.max(h.size_mm, 0.5);
  if (h.type === "round") return [s, s, 0, s / 2];
  let width = h.width_mm > 0 ? h.width_mm : s * 3.2;
  width = Math.min(Math.max(width, s), panelWidthMm * 0.9);
  if (h.type !== "butterfly") return [width, s, 0, 0];
  const total = h.height_mm > s ? h.height_mm : s * 1.6;
  const rise = total - s;
  const radius = Math.min(Math.max(rise, width * 0.2), total, width / 2);
  return [width, s, rise, radius];
}

/** Top and bottom of the hole, mm below the top edge. */
export function hangHoleExtent(h: HangHole, panelWidthMm: number): [number, number] {
  const [, s, rise] = hangHoleDims(h, panelWidthMm);
  return [h.offset_mm - s / 2 - rise, h.offset_mm + s / 2];
}

const f = (v: number) => String(Math.round(v * 1000) / 1000);

/** The hole's outline as an SVG path (mm, y down); "" for no hole. */
export function hangHolePath(h: HangHole, panelWidthMm: number): string {
  if (!KNOWN.has(h.type)) return "";
  const cx = panelWidthMm / 2, cy = h.offset_mm;
  const [width, s, rise, radius] = hangHoleDims(h, panelWidthMm);
  if (h.type === "round") {
    const r = s / 2;
    return `M${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 1 ${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 1 ${f(cx - r)} ${f(cy)}Z`;
  }
  const rs = s / 2;
  const x0 = cx - width / 2, x1 = cx + width / 2, top = cy - s / 2, bottom = cy + s / 2;
  let d = `M${f(x0 + rs)} ${f(top)}`;
  if (rise > 0.01) {
    const domeCy = top - rise + radius;
    const half = Math.sqrt(Math.max(radius * radius - (domeCy - top) ** 2, 0));
    // centre below the slot's top line: the dome above it is the minor arc
    d += `L${f(cx - half)} ${f(top)}A${f(radius)} ${f(radius)} 0 ${domeCy >= top ? 0 : 1} 1 ${f(cx + half)} ${f(top)}`;
  }
  return d + `L${f(x1 - rs)} ${f(top)}A${f(rs)} ${f(rs)} 0 0 1 ${f(x1 - rs)} ${f(bottom)}L${f(x0 + rs)} ${f(bottom)}A${f(rs)} ${f(rs)} 0 0 1 ${f(x0 + rs)} ${f(top)}Z`;
}
