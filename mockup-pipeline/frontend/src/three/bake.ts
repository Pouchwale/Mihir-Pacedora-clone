// The live preview of job-page artwork editing: a panel texture drawn on a canvas with the draft's
// replacement picture (fitted), colour correction and overlays (logos, text). Mirrors what the
// texture step bakes server-side (app/workflow/panel_art.py), so "Apply" shows the same picture.
import * as THREE from "three";
import type { Overlay, PanelBake, SceneTexture } from "./types";

const MAX_PX = 2048;
const FONTS: Record<Overlay["font"], string> = { sans: "Arial, Helvetica, sans-serif", serif: '"Times New Roman", Times, serif', mono: '"Courier New", Courier, monospace' };

const imageCache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(url: string): Promise<HTMLImageElement> {
  if (!imageCache.has(url)) {
    imageCache.set(url, new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => { imageCache.delete(url); reject(new Error(`cannot load ${url}`)); };
      img.src = url;
    }));
  }
  return imageCache.get(url)!;
}

/** Draw `img` on the whole canvas: cover crops the overflow, contain shows it all over the background, stretch distorts. */
function drawFitted(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, w: number, h: number, fit: PanelBake["fit"], background: string | null) {
  ctx.fillStyle = background ?? "#ffffff";
  ctx.fillRect(0, 0, w, h);
  if (fit === "stretch") {
    ctx.drawImage(img, 0, 0, w, h);
    return;
  }
  const k = (fit === "cover" ? Math.max : Math.min)(w / img.width, h / img.height);
  const dw = img.width * k, dh = img.height * k;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function drawText(ctx: CanvasRenderingContext2D, o: Overlay, ppm: number) {
  const lines = o.text.replace(/^\n+|\n+$/g, "").split("\n");
  if (!lines.join("").trim()) return;
  const px = o.size_mm * ppm;
  ctx.font = `${o.bold ? "bold " : ""}${px}px ${FONTS[o.font] ?? FONTS.sans}`;
  ctx.textBaseline = "alphabetic";
  const lineH = px * 1.2;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const w = Math.max(...widths), h = lineH * lines.length;
  const pad = o.background ? 0.2 * px : 0;
  if (o.background) {
    ctx.fillStyle = o.background;
    ctx.fillRect(-w / 2 - pad, -h / 2 - pad, w + 2 * pad, h + 2 * pad);
  }
  ctx.fillStyle = o.color;
  lines.forEach((line, i) => {
    const x = o.align === "left" ? -w / 2 : o.align === "right" ? w / 2 - widths[i] : -widths[i] / 2;
    ctx.fillText(line, x, -h / 2 + lineH * i + px * 0.92);
  });
}

async function drawOverlay(ctx: CanvasRenderingContext2D, o: Overlay & { url?: string | null }, ppm: number) {
  ctx.save();
  ctx.translate(o.x_mm * ppm, o.y_mm * ppm);
  ctx.rotate((-o.rotation * Math.PI) / 180);
  ctx.globalAlpha = o.opacity;
  if (o.kind === "text") {
    drawText(ctx, o, ppm);
  } else if (o.url) {
    try {
      const img = await loadImage(o.url);
      const w = o.width_mm * ppm, h = o.height_mm ? o.height_mm * ppm : (w * img.height) / img.width;
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } catch { /* a logo that cannot be loaded is left out of the preview */ }
  }
  ctx.restore();
}

/** The panel's artwork with the bake drawn in, as a canvas the size of the panel's proportions.
 *  The base is the texture before the job's own bake (`raw_url`), so nothing is drawn twice. */
export async function bakeCanvas(tex: SceneTexture, bake: PanelBake): Promise<HTMLCanvasElement> {
  const base = await loadImage(bake.source_url ?? tex.raw_url ?? tex.url);
  const aspect = tex.width_mm / tex.height_mm;
  const long = Math.min(MAX_PX, Math.max(bake.source_url ? 1024 : 1, base.width, base.height));
  const w = Math.max(16, Math.round(aspect >= 1 ? long : long * aspect));
  const h = Math.max(16, Math.round(aspect >= 1 ? long / aspect : long));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const filters: string[] = [];
  if (bake.brightness) filters.push(`brightness(${Math.max(0, 1 + bake.brightness / 100)})`);
  if (bake.contrast) filters.push(`contrast(${Math.max(0, 1 + bake.contrast / 100)})`);
  if (bake.saturation) filters.push(`saturate(${Math.max(0, 1 + bake.saturation / 100)})`);
  ctx.filter = filters.join(" ") || "none";
  if (bake.source_url) drawFitted(ctx, base, w, h, bake.fit, bake.background);
  else ctx.drawImage(base, 0, 0, w, h);
  ctx.filter = "none";
  const ppm = w / tex.width_mm;
  for (const o of bake.overlays) await drawOverlay(ctx, o, ppm);
  return c;
}

const textureCache = new Map<string, Promise<THREE.CanvasTexture>>();

/** A texture of the baked panel; the last few drafts are kept so slider edits stay quick. */
export function bakedTexture(tex: SceneTexture, bake: PanelBake): Promise<THREE.CanvasTexture> {
  const key = JSON.stringify([tex.url, tex.raw_url, tex.width_mm, tex.height_mm, bake]);
  if (!textureCache.has(key)) {
    textureCache.set(key, bakeCanvas(tex, bake).then((c) => {
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      return t;
    }));
    if (textureCache.size > 12) textureCache.delete(textureCache.keys().next().value!);
  }
  return textureCache.get(key)!;
}
