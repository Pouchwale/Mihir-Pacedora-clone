// Procedural surface maps for a pouch face, drawn in panel millimetres.
//   cut mask   : alpha (white = film, black = cut away): corners, notches, hang hole; window = grey
//   normal map : knurled heat seals, film wrinkles running out of the seals, zipper track
// Coordinates: x from the panel's left edge, y from its top edge, as printed (front view).
import * as THREE from "three";
import type { GeometrySpec } from "./types";

export const PX_PER_MM = 4;
const MAX_PX = 2048;

function canvasFor(wMm: number, hMm: number): { c: HTMLCanvasElement; k: number } {
  const k = Math.min(PX_PER_MM, MAX_PX / Math.max(wMm, hMm));
  const c = document.createElement("canvas");
  c.width = Math.max(4, Math.round(wMm * k));
  c.height = Math.max(4, Math.round(hMm * k));
  return { c, k };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export interface CutOptions {
  corners: boolean; // round the four corners
  spoutCorner?: "left" | "right" | null; // diagonal corner cut for a corner spout (front-view side)
  mirror?: boolean; // back face: draw mirrored so it matches the back's texture orientation
  outline?: HTMLCanvasElement | null; // shaped die-cut: white inside the outline
}

/** Alpha mask of a front/back face. Returns null when nothing is cut and there is no window. */
export function cutMask(g: GeometrySpec, wMm: number, hMm: number, o: CutOptions): THREE.CanvasTexture | null {
  const notch = g.tear_notch.type !== "none" || g.butterfly_notch;
  const any = (o.corners && g.corner_radius_mm > 0) || notch || g.hang_hole.type !== "none" || g.window.enabled || o.spoutCorner || o.outline;
  if (!any) return null;
  const { c, k } = canvasFor(wMm, hMm);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);
  if (o.mirror) {
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.scale(k, k);
  ctx.fillStyle = "#fff";
  if (o.outline) {
    ctx.drawImage(o.outline, 0, 0, wMm, hMm);
  } else {
    roundRect(ctx, 0, 0, wMm, hMm, o.corners ? g.corner_radius_mm : 0);
    ctx.fill();
  }
  ctx.fillStyle = "#000";
  const cutNotch = (yTop: number, depth: number, kind: string) => {
    for (const side of [0, 1]) {
      const x0 = side === 0 ? 0 : wMm;
      const dir = side === 0 ? 1 : -1;
      ctx.beginPath();
      if (kind === "straight") {
        ctx.rect(side === 0 ? 0 : wMm - depth, yTop - 0.35, depth, 0.7);
      } else if (kind !== "laser_score") {
        ctx.moveTo(x0, yTop - depth * 0.6);
        ctx.lineTo(x0 + dir * depth, yTop);
        ctx.lineTo(x0, yTop + depth * 0.6);
        ctx.closePath();
      }
      ctx.fill();
    }
  };
  if (g.tear_notch.type !== "none") cutNotch(g.tear_notch.y_from_top_mm, g.tear_notch.depth_mm || 4, g.tear_notch.type);
  if (g.butterfly_notch) cutNotch(g.tear_notch.y_from_top_mm + 6, 3, "v_notch");
  if (g.hang_hole.type === "round") {
    ctx.beginPath();
    ctx.arc(wMm / 2, g.hang_hole.offset_mm, g.hang_hole.size_mm / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (g.hang_hole.type === "euro") {
    const s = g.hang_hole.size_mm;
    roundRect(ctx, wMm / 2 - s * 1.6, g.hang_hole.offset_mm - s / 2, s * 3.2, s, s / 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(wMm / 2, g.hang_hole.offset_mm - s * 0.2, s * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }
  if (o.spoutCorner) {
    const cut = (g.spout?.cap_diameter_mm ?? 30) * 1.1;
    ctx.beginPath();
    if (o.spoutCorner === "right") {
      ctx.moveTo(wMm - cut, 0);
      ctx.lineTo(wMm, 0);
      ctx.lineTo(wMm, cut);
    } else {
      ctx.moveTo(0, 0);
      ctx.lineTo(cut, 0);
      ctx.lineTo(0, cut);
    }
    ctx.closePath();
    ctx.fill();
  }
  if (g.window.enabled) {
    ctx.fillStyle = "#555"; // partly transparent film
    roundRect(ctx, g.window.x_mm, g.window.y_mm, g.window.width_mm, g.window.height_mm, g.window.radius_mm);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// ---------------------------------------------------------------- normal maps
function hash(n: number) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
function noise1(x: number) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

export interface SealZones {
  side: number;
  top: number;
  bottom: number;
  zipperY?: number | null; // from top
  finX?: number | null; // pillow back fin seal centre (from left)
  finW?: number;
  crimp?: boolean; // pillow end seals: vertical serration teeth across the band (crimp jaws), not a knurl
}

/** Normal map from a procedural height field (seal knurl, wrinkles, zipper track, film grain). */
export function normalMap(wMm: number, hMm: number, z: SealZones, seed = 1): THREE.CanvasTexture {
  const k = Math.min(3, 1400 / Math.max(wMm, hMm));
  const W = Math.max(8, Math.round(wMm * k));
  const H = Math.max(8, Math.round(hMm * k));
  const h = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const y = j / k;
    for (let i = 0; i < W; i++) {
      const x = i / k;
      let v = (hash(i * 7.31 + j * 3.17 + seed) - 0.5) * 0.04; // film grain
      const inSide = x < z.side || x > wMm - z.side;
      const inTop = y < z.top;
      const inBottom = z.bottom > 0 && y > hMm - z.bottom;
      if (inSide || inTop || inBottom) {
        // knurled heat seal: fine ridges along the seal, 1.2 mm pitch
        const along = inSide && !inTop && !inBottom ? x : y;
        if (z.crimp && (inTop || inBottom) && !inSide) {
          // crimp teeth: sharp ridges 1.5 mm apart running across the seal, a flat 1 mm margin at the cut edge
          const edge = inTop ? y : hMm - y;
          v += edge < 1 ? 0 : 0.55 * Math.abs(Math.sin((x / 1.5) * Math.PI)) ** 0.6;
        } else {
          v += 0.35 * Math.sin((along / 1.2) * Math.PI * 2) + 0.12 * Math.sin(((x + y) / 0.9) * Math.PI * 2);
        }
      } else {
        // wrinkles running out of the seals, fading inward over ~12 mm
        const dSide = Math.min(x - z.side, wMm - z.side - x);
        const dTop = y - z.top;
        const dBottom = z.bottom > 0 ? hMm - z.bottom - y : 1e9;
        const fadeS = Math.exp(-dSide / 9);
        const fadeT = Math.exp(-Math.min(dTop, dBottom) / 12);
        v += fadeS * 0.9 * (noise1(y / 7 + seed) - 0.5) * Math.sin(dSide / 3.5 + noise1(y / 4) * 6);
        v += fadeT * 0.9 * (noise1(x / 9 + seed * 3) - 0.5) * Math.sin(Math.min(dTop, dBottom) / 4 + noise1(x / 5) * 6);
      }
      if (z.zipperY != null) {
        const dz = y - z.zipperY;
        v += 1.4 * Math.exp(-(dz * dz) / 1.2) + 0.25 * Math.exp(-((dz - 2.2) ** 2) / 0.3) + 0.25 * Math.exp(-((dz + 2.2) ** 2) / 0.3);
      }
      if (z.finX != null) {
        const fw = (z.finW ?? 10) / 2;
        // the fin strip, knurled, laid over to the right: its free edge casts a hard line, the fold side is soft
        const dx = x - z.finX;
        if (dx > -fw - 2 && dx < fw + 0.6) {
          v += dx < -fw ? 0.6 * (dx + fw + 2) / 2 : dx < fw ? 0.6 + 0.3 * Math.sin((y / 1.2) * Math.PI * 2) : -0.4;
        }
      }
      h[j * W + i] = v;
    }
  }
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const s = 2.2;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const hx = h[j * W + Math.min(W - 1, i + 1)] - h[j * W + Math.max(0, i - 1)];
      const hy = h[Math.min(H - 1, j + 1) * W + i] - h[Math.max(0, j - 1) * W + i];
      let nx = -hx * s, ny = hy * s, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const p = (j * W + i) * 4;
      img.data[p] = (nx * 0.5 + 0.5) * 255;
      img.data[p + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[p + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// ---------------------------------------------------------------- material maps
async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  return img;
}

export interface SurfaceSettings { [k: string]: number }

/** Roughness (G), metalness (B) and clearcoat (R) maps mixed from the base / metal / spot settings. */
export async function materialMaps(
  base: SurfaceSettings, metal: SurfaceSettings | undefined, spot: SurfaceSettings | undefined,
  metalUrl?: string, spotUrl?: string,
): Promise<{ rough: THREE.CanvasTexture; metal: THREE.CanvasTexture | null; coat: THREE.CanvasTexture | null } | null> {
  if (!(metalUrl && metal) && !(spotUrl && spot)) return null;
  const imgs = await Promise.all([metalUrl && metal ? loadImage(metalUrl) : null, spotUrl && spot ? loadImage(spotUrl) : null]);
  const ref = imgs[0] ?? imgs[1]!;
  const W = Math.min(1024, ref.width), H = Math.round(W * ref.height / ref.width);
  const read = (img: HTMLImageElement | null) => {
    if (!img) return null;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d")!;
    x.drawImage(img, 0, 0, W, H);
    return x.getImageData(0, 0, W, H).data;
  };
  const m = read(imgs[0]);
  const sp = read(imgs[1]);
  const make = () => {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    return c;
  };
  const rc = make(), mc = make(), cc = make();
  const rd = rc.getContext("2d")!.createImageData(W, H), md = mc.getContext("2d")!.createImageData(W, H), cd = cc.getContext("2d")!.createImageData(W, H);
  const r0 = base.roughness ?? 0.5, rm = metal?.roughness ?? r0, rs = spot?.roughness ?? r0;
  const c0 = base.clearcoat ?? 0, cs = spot?.clearcoat ?? c0;
  for (let p = 0; p < W * H * 4; p += 4) {
    const a = m ? m[p] / 255 : 0;
    const b = sp ? sp[p] / 255 : 0;
    let r = r0 * (1 - a) + rm * a;
    r = r * (1 - b) + rs * b;
    const coat = c0 * (1 - b) + cs * b;
    rd.data[p + 1] = r * 255; rd.data[p + 3] = 255;
    md.data[p + 2] = a * 255; md.data[p + 3] = 255;
    cd.data[p] = coat * 255; cd.data[p + 3] = 255;
  }
  rc.getContext("2d")!.putImageData(rd, 0, 0);
  mc.getContext("2d")!.putImageData(md, 0, 0);
  cc.getContext("2d")!.putImageData(cd, 0, 0);
  const tex = (c: HTMLCanvasElement) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; return t; };
  return { rough: tex(rc), metal: m ? tex(mc) : null, coat: sp ? tex(cc) : null };
}

/** Rasterise an admin-uploaded die-cut outline SVG (1 unit = 1 mm) to a white-inside mask. */
export async function outlineCanvas(svg: string, wMm: number, hMm: number): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const { c, k } = canvasFor(wMm, hMm);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, wMm * k, hMm * k);
  // anything drawn (any alpha) counts as inside; make it pure white on transparent
  const d = ctx.getImageData(0, 0, c.width, c.height);
  for (let p = 0; p < d.data.length; p += 4) {
    const inside = d.data[p + 3] > 20;
    d.data[p] = d.data[p + 1] = d.data[p + 2] = 255;
    d.data[p + 3] = inside ? 255 : 0;
  }
  ctx.putImageData(d, 0, 0);
  return c;
}

/** Inside-ness 0..1 (0 at the outline edge, 1 deep inside), from a blurred copy of the outline. */
export function insideField(outline: HTMLCanvasElement, blurMm: number, k: number): (xMm: number, yMm: number) => number {
  const c = document.createElement("canvas");
  c.width = outline.width; c.height = outline.height;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.filter = `blur(${Math.max(1, blurMm * k)}px)`;
  ctx.drawImage(outline, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const inside = outline.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  return (x, y) => {
    const i = Math.min(c.width - 1, Math.max(0, Math.round(x * k)));
    const j = Math.min(c.height - 1, Math.max(0, Math.round(y * k)));
    const p = (j * c.width + i) * 4;
    if (inside[p + 3] < 128) return 0;
    return Math.max(0, Math.min(1, (data[p] / 255 - 0.5) * 2));
  };
}
