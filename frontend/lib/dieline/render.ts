// Draws the dieline artwork onto canvases and cuts out the regions that become the 3D textures.
import type { DielineFace, DielineItem, DielineState } from './types';
import { computeSheetLayout, faceOf, textureRegions, type PouchSizeMm, type Rect, type SheetLayout } from './layout';

const imageCache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imageCache.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { imageCache.delete(src); reject(new Error('image failed to load')); };
      img.src = src;
    });
    imageCache.set(src, p);
  }
  return p;
}

/** Draw one item. `ppm` = canvas pixels per sheet mm. Sheet origin is at canvas (0,0). */
export function drawItem(ctx: CanvasRenderingContext2D, item: DielineItem, ppm: number, images: Map<string, HTMLImageElement>, layout: SheetLayout) {
  ctx.save();
  if (item.clip === 'panel') {
    const r = faceOf(layout, item.panel).outer;
    ctx.beginPath();
    ctx.rect(r.x * ppm, r.y * ppm, r.w * ppm, r.h * ppm);
    ctx.clip();
  }
  ctx.globalAlpha = item.opacity;
  ctx.translate(item.x * ppm, item.y * ppm);
  ctx.rotate((item.rotation * Math.PI) / 180);
  ctx.scale(item.flipX ? -1 : 1, item.flipY ? -1 : 1);
  const w = item.w * ppm, h = item.h * ppm;
  if (item.type === 'image') {
    const img = images.get(item.src);
    if (img) ctx.drawImage(img, -w / 2, -h / 2, w, h);
  } else if (item.type === 'rect' || item.type === 'ellipse') {
    ctx.beginPath();
    if (item.type === 'rect') ctx.rect(-w / 2, -h / 2, w, h);
    else ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    if (item.fill && item.fill !== 'none') { ctx.fillStyle = item.fill; ctx.fill(); }
    if (item.strokeMm > 0 && item.stroke && item.stroke !== 'none') { ctx.lineWidth = item.strokeMm * ppm; ctx.strokeStyle = item.stroke; ctx.stroke(); }
  } else if (item.type === 'text') {
    ctx.fillStyle = item.color;
    ctx.font = `${item.bold ? '700' : '400'} ${item.fontSizeMm * ppm}px ${item.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = item.align;
    const lines = item.text.split('\n');
    const lineH = item.fontSizeMm * ppm * 1.2;
    const startY = -((lines.length - 1) * lineH) / 2;
    const tx = item.align === 'left' ? -w / 2 : item.align === 'right' ? w / 2 : 0;
    lines.forEach((line, i) => ctx.fillText(line, tx, startY + i * lineH));
  }
  ctx.restore();
}

async function collectImages(items: DielineItem[]) {
  const images = new Map<string, HTMLImageElement>();
  await Promise.all(items.map(async (it) => {
    if (it.type !== 'image' || images.has(it.src)) return;
    try { images.set(it.src, await loadImage(it.src)); } catch { /* skipped: broken image */ }
  }));
  return images;
}

/** Renders one print face (outside or inside) of the whole sheet to a canvas. */
export async function renderSheet(state: DielineState, size: PouchSizeMm, face: DielineFace, ppm: number, background = '#ffffff') {
  const layout = computeSheetLayout(state.pouchType, size, state.keyline);
  const items = state.items.filter((it) => it.face === face);
  const images = await collectImages(items);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(layout.width * ppm));
  canvas.height = Math.max(1, Math.round(layout.height * ppm));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas not supported');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  items.forEach((it) => drawItem(ctx, it, ppm, images, layout));
  return { canvas, layout };
}

function cropToDataUrl(source: HTMLCanvasElement, r: Rect, ppm: number, mirror = false, quality = 0.9): string {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(r.w * ppm));
  out.height = Math.max(1, Math.round(r.h * ppm));
  const ctx = out.getContext('2d')!;
  if (mirror) { ctx.translate(out.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(source, r.x * ppm, r.y * ppm, r.w * ppm, r.h * ppm, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', quality);
}

export interface SideTextures {
  front: string | null;
  back: string | null;
  bottom: string | null;
}

/**
 * The per-side textures the 3D model uses. Each texture covers the whole 3D side (its UVs are
 * normalised per side), so the crops use the cut-line regions without bleed.
 * Inside artwork is mirrored because the inner lining is viewed from the other side.
 */
export async function renderSideTextures(state: DielineState, size: PouchSizeMm, face: DielineFace, targetPx = 2048): Promise<SideTextures> {
  const layout = computeSheetLayout(state.pouchType, size, state.keyline);
  const ppm = targetPx / Math.max(layout.faceHeight, 1);
  const hasItems = state.items.some((it) => it.face === face);
  if (!hasItems) return { front: null, back: null, bottom: null };
  const { canvas } = await renderSheet(state, size, face, ppm);
  const regions = textureRegions(layout, state.keyline);
  const mirror = face === 'inside';
  const front = cropToDataUrl(canvas, regions.front, ppm, mirror);
  const back = cropToDataUrl(canvas, regions.back, ppm, mirror);
  let bottom: string | null = null;
  if (regions.bottom) {
    // Bottom = back gusset half (upside down, far edge) over the front gusset half (near edge)
    const { frontStrip, backStrip } = regions.bottom;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(frontStrip.w * ppm));
    out.height = Math.max(1, Math.round((frontStrip.h + backStrip.h) * ppm));
    const ctx = out.getContext('2d')!;
    const half = Math.round(backStrip.h * ppm);
    ctx.save();
    ctx.translate(out.width / 2, half / 2);
    ctx.rotate(Math.PI);
    ctx.drawImage(canvas, backStrip.x * ppm, backStrip.y * ppm, backStrip.w * ppm, backStrip.h * ppm, -out.width / 2, -half / 2, out.width, half);
    ctx.restore();
    ctx.drawImage(canvas, frontStrip.x * ppm, frontStrip.y * ppm, frontStrip.w * ppm, frontStrip.h * ppm, 0, half, out.width, out.height - half);
    if (mirror) {
      const m = document.createElement('canvas');
      m.width = out.width; m.height = out.height;
      const mc = m.getContext('2d')!;
      mc.translate(m.width, 0); mc.scale(-1, 1); mc.drawImage(out, 0, 0);
      bottom = m.toDataURL('image/jpeg', 0.9);
    } else {
      bottom = out.toDataURL('image/jpeg', 0.9);
    }
  }
  return { front, back, bottom };
}

/** Size and position that make an image cover (or fit inside) a rectangle without stretching. */
export function fitRect(naturalW: number, naturalH: number, target: Rect, mode: 'fill' | 'fit') {
  const scale = mode === 'fill'
    ? Math.max(target.w / naturalW, target.h / naturalH)
    : Math.min(target.w / naturalW, target.h / naturalH);
  const w = naturalW * scale;
  const h = naturalH * scale;
  return { x: target.x + target.w / 2, y: target.y + target.h / 2, w, h };
}
