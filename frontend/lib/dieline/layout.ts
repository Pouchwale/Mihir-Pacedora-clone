// Geometry of the flat sheet for a pouch type: where the faces, seals, bands, folds and bleed sit
// in sheet millimetres. Everything derives from the pouch size (Size tab) and the keyline values.
import type { DielinePanel, Keyline, PouchType } from './types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Zone extends Rect {
  kind: 'seal' | 'band' | 'gusset' | 'print';
  label: string;
}

export interface FaceLayout {
  panel: DielinePanel;
  label: string;
  /** Face including bleed (the outer edge of the artwork) */
  outer: Rect;
  /** Face at the cut line */
  cut: Rect;
  /** Unprinted / seal-free print area (inside seals and bands) */
  print: Rect;
  /** Print area minus the safe margin: keep text and logos inside */
  safe: Rect;
  zones: Zone[];
  /** Horizontal fold lines (y in sheet mm) with a label */
  folds: { y: number; label: string }[];
}

export interface SheetLayout {
  pouchType: PouchType;
  /** Whole sheet size in mm (both faces incl. bleed) */
  width: number;
  height: number;
  faces: FaceLayout[];
  /** Finished pouch size in mm */
  pouch: { width: number; height: number; depth: number };
  /** Face sheet height in mm (pouch height plus the gusset half for stand-up pouches) */
  faceHeight: number;
}

export interface PouchSizeMm {
  width: number;
  height: number;
  depth: number;
}

/** Reference size of the built-in models (Size tab): 15 x 20 x 5 cm, multiplied by sizeScale. */
export const REFERENCE_SIZE_CM: [number, number, number] = [15, 20, 5];

export function pouchSizeFromScale(sizeScale: [number, number, number] | undefined): PouchSizeMm {
  const s = sizeScale ?? [1, 1, 1];
  return {
    width: Math.round(REFERENCE_SIZE_CM[0] * 10 * (s[0] ?? 1) * 10) / 10,
    height: Math.round(REFERENCE_SIZE_CM[1] * 10 * (s[1] ?? 1) * 10) / 10,
    depth: Math.round(REFERENCE_SIZE_CM[2] * 10 * (s[2] ?? 1) * 10) / 10,
  };
}

export function sizeScaleFromPouch(size: PouchSizeMm): [number, number, number] {
  return [
    size.width / (REFERENCE_SIZE_CM[0] * 10),
    size.height / (REFERENCE_SIZE_CM[1] * 10),
    size.depth / (REFERENCE_SIZE_CM[2] * 10),
  ];
}

const sum = (bands: { mm: number }[]) => bands.reduce((t, b) => t + b.mm, 0);

export function computeSheetLayout(pouchType: PouchType, size: PouchSizeMm, keyline: Keyline): SheetLayout {
  const bleed = keyline.bleedMm;
  const gusset = pouchType === 'standup_pouch' ? keyline.gussetFoldMm : 0;
  // The face sheet runs from the top cut edge to the bottom cut edge: the standing height plus the
  // half of the bottom gusset that is folded underneath
  const faceHeight = size.height + gusset;
  const faceOuterW = size.width + 2 * bleed;
  const faceOuterH = faceHeight + 2 * bleed;

  const faces: FaceLayout[] = (['front', 'back'] as DielinePanel[]).map((panel, index) => {
    const ox = index * faceOuterW;
    const outer: Rect = { x: ox, y: 0, w: faceOuterW, h: faceOuterH };
    const cut: Rect = { x: ox + bleed, y: bleed, w: size.width, h: faceHeight };
    const zones: Zone[] = [];
    const folds: { y: number; label: string }[] = [];

    // Side seals (front and back sheets overlap here)
    zones.push({ kind: 'seal', label: `Side seal ${keyline.sideSealMm} mm`, x: cut.x, y: cut.y, w: keyline.sideSealMm, h: cut.h });
    zones.push({ kind: 'seal', label: `Side seal ${keyline.sideSealMm} mm`, x: cut.x + cut.w - keyline.sideSealMm, y: cut.y, w: keyline.sideSealMm, h: cut.h });

    // Top bands from the cut edge downwards
    let y = cut.y;
    keyline.topBands.forEach((band) => {
      if (band.mm <= 0) return;
      zones.push({ kind: 'band', label: `${band.label} ${band.mm} mm`, x: cut.x, y, w: cut.w, h: band.mm });
      y += band.mm;
      folds.push({ y, label: band.label });
    });
    const printTop = y;

    // Bottom bands from the cut edge upwards
    let yb = cut.y + cut.h;
    keyline.bottomBands.forEach((band) => {
      if (band.mm <= 0) return;
      yb -= band.mm;
      zones.push({ kind: 'band', label: `${band.label} ${band.mm} mm`, x: cut.x, y: yb, w: cut.w, h: band.mm });
      folds.push({ y: yb, label: band.label });
    });
    let printBottom = yb;

    if (gusset > 0) {
      const foldY = cut.y + cut.h - gusset;
      zones.push({ kind: 'gusset', label: `Bottom gusset ${gusset} mm`, x: cut.x, y: foldY, w: cut.w, h: gusset - sum(keyline.bottomBands) });
      folds.push({ y: foldY, label: 'Gusset fold' });
      printBottom = Math.min(printBottom, foldY);
    }

    const print: Rect = {
      x: cut.x + keyline.sideSealMm,
      y: printTop,
      w: Math.max(0, cut.w - 2 * keyline.sideSealMm),
      h: Math.max(0, printBottom - printTop),
    };
    const safe: Rect = {
      x: print.x + keyline.safeMm,
      y: print.y + keyline.safeMm,
      w: Math.max(0, print.w - 2 * keyline.safeMm),
      h: Math.max(0, print.h - 2 * keyline.safeMm),
    };
    zones.push({ kind: 'print', label: 'Print area', ...print });

    return { panel, label: panel === 'front' ? 'Front' : 'Back', outer, cut, print, safe, zones, folds };
  });

  return {
    pouchType,
    width: faceOuterW * 2,
    height: faceOuterH,
    faces,
    pouch: { ...size },
    faceHeight,
  };
}

export function faceOf(layout: SheetLayout, panel: DielinePanel): FaceLayout {
  return layout.faces.find((f) => f.panel === panel) || layout.faces[0];
}

/** The sheet regions that become the 3D side textures (in sheet mm, without bleed). */
export function textureRegions(layout: SheetLayout, keyline: Keyline) {
  const front = faceOf(layout, 'front').cut;
  const back = faceOf(layout, 'back').cut;
  const gusset = layout.pouchType === 'standup_pouch' ? keyline.gussetFoldMm : 0;
  return {
    front,
    back,
    // The bottom of the pouch is made of the two gusset halves: the bottom strip of each face
    bottom: gusset > 0
      ? {
          frontStrip: { x: front.x, y: front.y + front.h - gusset, w: front.w, h: gusset },
          backStrip: { x: back.x, y: back.y + back.h - gusset, w: back.w, h: gusset },
        }
      : null,
  };
}
