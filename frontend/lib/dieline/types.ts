// 2D dieline (keyline) editor: data model shared by the editor, the 3D mapping and the admin
// defaults. All lengths are millimetres in "sheet space": (0,0) is the top-left corner of the flat
// sheet including bleed, x grows to the right and y grows downwards.

export type PouchType = 'standup_pouch' | 'flat_pouch';

/** A printed band along the top or bottom edge of a face (seal, zipper, tear strip, hang hole…). */
export interface KeylineBand {
  label: string;
  mm: number;
}

export interface Keyline {
  /** Extra artwork outside the cut line so trimming never leaves a white edge */
  bleedMm: number;
  /** Side seals: where the front and back sheets overlap and are welded together */
  sideSealMm: number;
  /** Bands from the top cut edge downwards (top seal, zipper, tear notch, hang hole…) */
  topBands: KeylineBand[];
  /** Bands from the bottom cut edge upwards */
  bottomBands: KeylineBand[];
  /** Stand-up pouch only: the bottom gusset fold, measured from the bottom cut edge */
  gussetFoldMm: number;
  /** Text and logos should stay inside this margin from the print area edge */
  safeMm: number;
}

export type DielineFace = 'outside' | 'inside';
export type DielinePanel = 'front' | 'back';

interface DielineItemBase {
  id: string;
  face: DielineFace;
  /** Centre of the item in sheet mm */
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  opacity: number;
  flipX?: boolean;
  flipY?: boolean;
  locked?: boolean;
  /** 'panel': cropped to one face (incl. its bleed). 'none': may run across the whole sheet */
  clip: 'none' | 'panel';
  panel: DielinePanel;
}

export interface DielineImageItem extends DielineItemBase {
  type: 'image';
  src: string;
  name?: string;
  /** Natural pixel size, used to keep the proportions when fitting */
  naturalW: number;
  naturalH: number;
}

export interface DielineTextItem extends DielineItemBase {
  type: 'text';
  text: string;
  fontSizeMm: number;
  color: string;
  bold: boolean;
  fontFamily: string;
  align: 'left' | 'center' | 'right';
}

export interface DielineShapeItem extends DielineItemBase {
  type: 'rect' | 'ellipse';
  fill: string;
  stroke: string;
  strokeMm: number;
}

export type DielineItem = DielineImageItem | DielineTextItem | DielineShapeItem;

export interface DielineState {
  pouchType: PouchType;
  keyline: Keyline;
  items: DielineItem[];
  /** Which print side the editor is showing */
  activeFace: DielineFace;
}

/** Built-in keyline defaults per pouch type (an administrator can override them). */
export const DEFAULT_KEYLINES: Record<PouchType, Keyline> = {
  standup_pouch: {
    bleedMm: 2.55,
    sideSealMm: 10,
    topBands: [
      { label: 'Top seal', mm: 4 },
      { label: 'Zipper', mm: 10 },
      { label: 'Tear notch', mm: 12 },
      { label: 'Hang hole', mm: 13 },
    ],
    bottomBands: [
      { label: 'Bottom seal', mm: 4 },
      { label: 'Gusset seal', mm: 10 },
    ],
    gussetFoldMm: 40,
    safeMm: 5,
  },
  flat_pouch: {
    bleedMm: 2.55,
    sideSealMm: 10,
    topBands: [
      { label: 'Top seal', mm: 10 },
      { label: 'Tear notch', mm: 12 },
    ],
    bottomBands: [{ label: 'Bottom seal', mm: 10 }],
    gussetFoldMm: 0,
    safeMm: 5,
  },
};

export const POUCH_TYPE_LABELS: Record<PouchType, string> = {
  standup_pouch: 'Stand-Up Pouch (bottom gusset)',
  flat_pouch: 'Flat Pouch (three side seal)',
};

/** Which dieline layout a 3D model uses, or null when the model has no dieline yet. */
export function pouchTypeForModel(fileName: string | null | undefined): PouchType | null {
  const name = (fileName || '').toLowerCase();
  if (name.includes('standup') || name.includes('stand-up') || name.includes('stander')) return 'standup_pouch';
  if (name.includes('three_side') || name.includes('three side') || name.includes('chocolate')) return 'flat_pouch';
  return null;
}

/** Deep-copies a keyline and drops anything that is not a finite, sensible number. */
export function sanitizeKeyline(input: any, fallback: Keyline): Keyline {
  const num = (v: any, def: number, max = 500) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= max ? n : def;
  };
  const bands = (list: any, def: KeylineBand[]): KeylineBand[] =>
    Array.isArray(list)
      ? list
          .slice(0, 8)
          .map((b) => ({ label: String(b?.label ?? '').slice(0, 30) || 'Band', mm: num(b?.mm, 0, 200) }))
      : def.map((b) => ({ ...b }));
  return {
    bleedMm: num(input?.bleedMm, fallback.bleedMm, 20),
    sideSealMm: num(input?.sideSealMm, fallback.sideSealMm, 60),
    topBands: bands(input?.topBands, fallback.topBands),
    bottomBands: bands(input?.bottomBands, fallback.bottomBands),
    gussetFoldMm: num(input?.gussetFoldMm, fallback.gussetFoldMm, 300),
    safeMm: num(input?.safeMm, fallback.safeMm, 50),
  };
}

export const newItemId = () => Math.random().toString(36).slice(2, 10);
