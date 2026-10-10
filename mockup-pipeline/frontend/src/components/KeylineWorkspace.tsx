// Keyline & Dieline Studio: the job's flat dieline (every panel at its real size, seals, zipper,
// notches, hang hole, windows, folds, bleed and safe zone) with the artwork placed exactly as the 3D
// model places it. It edits the same draft as the 3D tab: drag the artwork, logos, text, the zipper
// line, seal edges, notch and hang hole; draw windows; measure; check for print problems; export the
// dieline. "Apply and re-render" saves the draft for the renders, GLB and share links.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import * as THREE from "three";
import AdjustPanel, { OverlayControls, type Uploaded } from "./AdjustPanel";
import Viewer from "./Viewer";
import { bakeCanvas, loadImage } from "../three/bake";
import { applyDraft, DEFAULT_OVERLAY, IDENTITY_PANEL, panelOf, type Draft, type PanelDraft } from "../three/draft";
import {
  apply, artworkMatrix, BLEED_MM, checks as findChecks, layoutPanels, MARGIN_MM, niceStep, overlayCorners, safeRect, sealZones, svgMatrix, windowPoints,
  type Check, type PanelBox,
} from "../three/dieline";
import { paintWindows } from "../three/surface";
import type { GeometrySpec, Overlay, SceneData, SceneTexture, WindowShape } from "../three/types";
import DesignPicker from "./DesignPicker";

type Dict = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Props {
  job: Dict; // GET /api/jobs/{id}
  liveScene: SceneData | null;
  draft: Draft | null;
  dirty: boolean;
  busy: boolean;
  running: boolean;
  isAdmin: boolean;
  onChange: (d: Draft) => void;
  onApply: (saveDefault: boolean) => void;
  onReset: () => void;
  onUpload: (file: File) => Promise<Uploaded>;
  onSwitchTo3D: () => void;
}

type Tool = "select" | "pan" | "measure" | "text" | "logo" | "window";
type Layer = "artwork" | "cut" | "seals" | "folds" | "zipper" | "cuts" | "windows" | "bleed" | "safe" | "dims" | "grid";
type Selection = { kind: "panel"; role: string } | { kind: "overlay"; role: string; id: string } | { kind: "window"; index: number } | { kind: "line"; key: string; role: string } | null;

const LAYERS: [Layer, string][] = [
  ["artwork", "Artwork"], ["cut", "Cut line"], ["seals", "Seal areas"], ["folds", "Folds"], ["zipper", "Zipper"], ["cuts", "Notches & holes"],
  ["windows", "Windows"], ["bleed", `Bleed (${BLEED_MM} mm)`], ["safe", "Safe zone"], ["dims", "Dimensions"], ["grid", "Grid"],
];
const DEFAULT_LAYERS: Record<Layer, boolean> = { artwork: true, cut: true, seals: true, folds: true, zipper: true, cuts: true, windows: true, bleed: false, safe: false, dims: true, grid: false };
const TOOLS: [Tool, string, string, string][] = [
  ["select", "Select & move", "V", "M5 3l14 9-6 1.5L10 20z"],
  ["pan", "Pan", "H", "M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8l-1.5-1.5a2 2 0 0 0-3 2.6L6 20a6 6 0 0 0 5 2h2a7 7 0 0 0 7-7v-4a2 2 0 0 0-4 0"],
  ["measure", "Measure", "M", "M3 17 17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2"],
  ["text", "Add text", "T", "M4 7V4h16v3M9 20h6M12 4v16"],
  ["logo", "Add logo / picture", "L", "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21"],
  ["window", "Draw a clear window", "W", "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8 8h8v8H8z"],
];
// keyline values the dieline can drag: which axis, and how a panel point turns into the value
const LINE_KEYS: Record<string, { label: string; axis: "x" | "y" }> = {
  zipper_offset_from_top_mm: { label: "Zipper from top", axis: "y" },
  top_seal_mm: { label: "Top seal", axis: "y" },
  bottom_seal_mm: { label: "Bottom seal", axis: "y" },
  side_seal_mm: { label: "Side seal", axis: "x" },
  tear_notch_offset_mm: { label: "Tear notch from top", axis: "y" },
  hang_hole_offset_mm: { label: "Hang hole from top", axis: "y" },
};
const BLUE = "#1f5bd6";
const round = (v: number) => Math.round(v * 2) / 2;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const newId = () => Math.random().toString(36).slice(2, 10);

const Icon = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const I = {
  undo: "M3 7v6h6M21 17a9 9 0 0 0-15-6.7L3 13", redo: "M21 7v6h-6M3 17a9 9 0 0 1 15-6.7L21 13",
  plus: "M12 5v14M5 12h14", minus: "M5 12h14", fit: "M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3",
  layers: "M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5", check: "M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3", split: "M12 3v18M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  close: "M18 6 6 18M6 6l12 12", trash: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
  cube: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z",
};

function readLayers(): Record<Layer, boolean> {
  try { return { ...DEFAULT_LAYERS, ...JSON.parse(localStorage.getItem("dieline-layers") || "{}") }; } catch { return DEFAULT_LAYERS; }
}

/** The dieline's own styles (styles.css ".kl-svg .dl-*"), for an exported file that stands alone:
 *  one screen pixel becomes 0.25 mm, theme colours their light values. */
function exportCss(): string {
  const rules: string[] = [];
  for (const sheet of [...document.styleSheets]) {
    let list: CSSRuleList;
    try { list = sheet.cssRules; } catch { continue; } // another origin's stylesheet
    for (const r of [...list]) if (r instanceof CSSStyleRule && r.selectorText.includes(".kl-svg .dl-")) rules.push(r.cssText);
  }
  return rules.join("\n").replace(/\.kl-svg /g, "").replace(/var\(--px\)/g, "0.25").replace(/var\(--text\)/g, "#141a26");
}

/** Inline every <image> of an exported SVG as a data URL, so the file stands alone. */
async function inlineImages(svg: SVGSVGElement) {
  await Promise.all([...svg.querySelectorAll("image")].map(async (im) => {
    const href = im.getAttribute("href") || "";
    if (!href || href.startsWith("data:")) return;
    try {
      const blob = await (await fetch(href, { credentials: "same-origin" })).blob();
      const url = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsDataURL(blob); });
      im.setAttribute("href", url);
    } catch { im.remove(); }
  }));
}

export default function KeylineWorkspace(props: Props) {
  const { job, liveScene, draft } = props;
  const outputs: Dict = job.outputs ?? {};
  if (!liveScene || !draft) {
    const step = job.job?.current_step;
    return (
      <div className="card empty-state">
        <div className="dropzone-icon"><Icon d={I.layers} size={26} /></div>
        <b>The dieline appears when the keyline and artwork are ready</b>
        <span className="muted">{props.running ? `Working: ${String(step ?? "").replace(/_/g, " ")}…` : outputs.resolve_keyline ? "The artwork textures are not ready yet." : "The keyline has not been resolved yet."}</span>
      </div>
    );
  }
  return <Studio {...props} liveScene={liveScene} draft={draft} />;
}

function Studio({ job, liveScene, draft, dirty, busy, running, isAdmin, onChange, onApply, onReset, onUpload, onSwitchTo3D }: Props & { liveScene: SceneData; draft: Draft }) {
  const kl: Dict = job.outputs?.resolve_keyline?.keyline?.fields ?? {};
  const itemCode: string = job.job?.item_code ?? "dieline";
  // a sheet with several designs: the dieline of the one picked (the draft's edits apply to each alike)
  const designs = liveScene.designs ?? [];
  const [design, setDesign] = useState(1);
  const shownScene = useMemo(() => (designs.length > 1 ? { ...liveScene, textures: designs[Math.min(design, designs.length) - 1].textures } : liveScene), [liveScene, design]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = useMemo(() => applyDraft(shownScene, draft), [shownScene, draft]);
  const g: GeometrySpec = view.geometry;
  const textures = view.textures;
  const sheet = useMemo(() => layoutPanels(textures), [textures]);
  const panels = sheet.panels;
  const files = liveScene.files ?? {};

  // ---- draft history (undo / redo); quick successive edits (a drag, a slider) are one step
  const past = useRef<Draft[]>([]);
  const future = useRef<Draft[]>([]);
  const lastPush = useRef(0);
  const [, setHist] = useState(0);
  const change = useCallback((d: Draft) => {
    const now = Date.now();
    if (now - lastPush.current > 600) {
      past.current = [...past.current.slice(-99), draft];
      future.current = [];
    }
    lastPush.current = now;
    setHist((h) => h + 1);
    onChange(d);
  }, [draft, onChange]);
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(draft);
    lastPush.current = 0;
    setHist((h) => h + 1);
    onChange(prev);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(draft);
    lastPush.current = 0;
    setHist((h) => h + 1);
    onChange(next);
  };

  // ---- view: k px per mm, the sheet's origin at (tx, ty) px
  const wrap = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [vp, setVp] = useState({ k: 1, tx: 0, ty: 0 });
  const [size, setSize] = useState({ w: 800, h: 600 });
  const fitted = useRef("");
  const fit = useCallback(() => {
    const W = sheet.width + 2 * MARGIN_MM, H = sheet.height + 2 * MARGIN_MM;
    const k = Math.max(0.05, Math.min((size.w - 40) / W, (size.h - 40) / H));
    setVp({ k, tx: (size.w - sheet.width * k) / 2, ty: (size.h - sheet.height * k) / 2 });
  }, [sheet.width, sheet.height, size.w, size.h]);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  // fit when the panel set or the canvas size changes, until the operator zooms or pans themselves
  const userView = useRef(false);
  useEffect(() => {
    const key = `${panels.map((p) => p.role).join()}|${Math.round(sheet.width)}x${Math.round(sheet.height)}`;
    if (size.w < 100) return;
    if (fitted.current !== key) { fitted.current = key; userView.current = false; }
    if (!userView.current) fit();
  }, [panels, sheet.width, sheet.height, size.w, size.h, fit]);
  const zoomAt = (factor: number, cx = size.w / 2, cy = size.h / 2) => setVp((v) => {
    userView.current = true;
    const k = clamp(v.k * factor, 0.05, 60);
    return { k, tx: cx - ((cx - v.tx) * k) / v.k, ty: cy - ((cy - v.ty) * k) / v.k };
  });
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      else { userView.current = true; setVp((v) => ({ ...v, tx: v.tx - e.deltaX })); }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });

  // ---- UI state
  const [tool, setTool] = useState<Tool>("select");
  const [winMode, setWinMode] = useState<"rect" | "free">("rect");
  const [layers, setLayersState] = useState<Record<Layer, boolean>>(readLayers);
  const setLayer = (l: Layer, on: boolean) => setLayersState((cur) => {
    const next = { ...cur, [l]: on };
    try { localStorage.setItem("dieline-layers", JSON.stringify(next)); } catch { /* private window */ }
    return next;
  });
  const [menu, setMenu] = useState<"layers" | "checks" | "export" | null>(null);
  const [split, setSplit] = useState(false);
  const [side, setSide] = useState(true); // the Adjust panel on the right
  // an open menu closes on a click anywhere outside it
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => { if (!(e.target as Element | null)?.closest?.(".kl-menu-wrap")) setMenu(null); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);
  const [inside, setInside] = useState(false);
  const [sel, setSel] = useState<Selection>(null);
  const [cursor, setCursor] = useState<{ role: string | null; x: number; y: number } | null>(null);
  // the measurement and the window being drawn: refs are the truth (pointer events can outrun renders)
  type Measure = { a: [number, number]; b: [number, number]; done: boolean } | null;
  type Sketch = { role: string; pts: [number, number][] } | null;
  const [measure, setMeasureState] = useState<Measure>(null);
  const [sketch, setSketchState] = useState<Sketch>(null);
  const measureRef = useRef<Measure>(null);
  const sketchRef = useRef<Sketch>(null);
  const setMeasure = (m: Measure) => { measureRef.current = m; setMeasureState(m); };
  const setSketch = (k: Sketch) => { sketchRef.current = k; setSketchState(k); };
  const [guides, setGuides] = useState<{ role: string; x?: number; y?: number } | null>(null);
  const [msg, setMsg] = useState("");
  const [exportArt, setExportArt] = useState(true);
  const logoInput = useRef<HTMLInputElement>(null);
  const pendingLogo = useRef<{ role: string; x: number; y: number } | null>(null);

  // ---- panel pictures: the texture, or (with a bake) the panel drawn with its picture / colour / logos / text
  const [images, setImages] = useState<Record<string, string>>({});
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const bakeKeys = JSON.stringify(Object.entries(textures).map(([r, t]) => [r, t.url, t.raw_url, t.bake]));
  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    const timer = window.setTimeout(async () => {
      const next: Record<string, string> = {};
      for (const [role, t] of Object.entries(textures)) {
        if (!t.bake) { next[role] = t.url; continue; }
        try {
          const c = await bakeCanvas(t, t.bake);
          const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/png"));
          if (blob) { const u = URL.createObjectURL(blob); urls.push(u); next[role] = u; }
        } catch { next[role] = t.raw_url ?? t.url; }
      }
      if (alive) setImages(next);
    }, 150);
    return () => { alive = false; window.clearTimeout(timer); window.setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 4000); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bakeKeys]);
  // logo proportions (for their outlines and the checks)
  useEffect(() => {
    for (const t of Object.values(textures)) {
      for (const o of t.bake?.overlays ?? []) {
        const key = String(o.file_id);
        if (o.kind !== "image" || !o.url || key in aspects) continue;
        loadImage(o.url).then((im) => setAspects((a) => ({ ...a, [key]: im.width / im.height || 1 }))).catch(() => setAspects((a) => ({ ...a, [key]: 1 })));
      }
    }
  }, [textures, aspects]);
  // "pick area" windows: grown over the panel's artwork exactly as the 3D model grows them
  const [wandMasks, setWandMasks] = useState<Record<string, string>>({});
  const wandKey = JSON.stringify([draft.windows.filter((w) => w.kind === "wand"), images.front, images.back]);
  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    (async () => {
      const next: Record<string, string> = {};
      for (const p of panels.filter((q) => q.face)) {
        const shapes = draft.windows.filter((w) => w.kind === "wand" && w.face === p.role);
        if (!shapes.length || !images[p.role]) continue;
        try {
          const art = await loadImage(images[p.role]);
          const c = document.createElement("canvas");
          c.width = Math.max(16, Math.round(p.w * 3));
          c.height = Math.max(16, Math.round(p.h * 3));
          const ctx = c.getContext("2d")!;
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, c.width, c.height);
          paintWindows({ image: c, needsUpdate: false } as unknown as THREE.Texture, shapes, art);
          const px = ctx.getImageData(0, 0, c.width, c.height);
          for (let i = 0; i < px.data.length; i += 4) {
            const win = px.data[i] < 0x40;
            px.data[i] = 80; px.data[i + 1] = 160; px.data[i + 2] = 255; px.data[i + 3] = win ? 120 : 0;
          }
          ctx.putImageData(px, 0, 0);
          const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/png"));
          if (blob) { const u = URL.createObjectURL(blob); urls.push(u); next[p.role] = u; }
        } catch { /* artwork not loadable: the window shows in 3D only */ }
      }
      if (alive) setWandMasks(next);
    })();
    return () => { alive = false; window.setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 4000); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wandKey]);

  const allChecks: Check[] = useMemo(() => findChecks(g, textures, panels, draft.windows, aspects), [g, textures, panels, draft.windows, aspects]);
  const badOverlays = new Set(allChecks.filter((c) => c.level === "bad" && c.target?.kind === "overlay").map((c) => (c.target as { id: string }).id));

  // ---- draft edits
  const setPanel = (role: string, patch: Partial<PanelDraft>) => change({ ...draft, panels: { ...draft.panels, [role]: { ...panelOf(draft, role), ...patch } } });
  const setKey = (key: string, value: number | string | boolean | null) => change({ ...draft, keyline: { ...draft.keyline, [key]: value } });
  const setOverlay = (role: string, id: string, patch: Partial<Overlay>) => {
    const p = panelOf(draft, role);
    setPanel(role, { overlays: p.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)) });
  };
  const removeOverlay = (role: string, id: string) => {
    setPanel(role, { overlays: panelOf(draft, role).overlays.filter((o) => o.id !== id) });
    setSel(null);
  };
  const orderOverlay = (role: string, id: string, dir: -1 | 1) => {
    const list = [...panelOf(draft, role).overlays];
    const i = list.findIndex((o) => o.id === id);
    if (i < 0 || i + dir < 0 || i + dir >= list.length) return;
    [list[i], list[i + dir]] = [list[i + dir], list[i]];
    setPanel(role, { overlays: list });
  };
  const addOverlay = (role: string, x: number, y: number, patch: Partial<Overlay>) => {
    const t = textures[role];
    const o: Overlay = { ...DEFAULT_OVERLAY, id: newId(), x_mm: round(x), y_mm: round(y), size_mm: Math.max(4, Math.round(t.height_mm / 25)), ...patch };
    setPanel(role, { overlays: [...panelOf(draft, role).overlays, o] });
    setSel({ kind: "overlay", role, id: o.id });
    setTool("select");
  };
  const setWindows = (windows: WindowShape[]) => change({ ...draft, windows });

  // ---- coordinates
  const toWorld = (clientX: number, clientY: number): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    const x = (clientX - r.left - vp.tx) / vp.k, y = (clientY - r.top - vp.ty) / vp.k;
    return [inside ? sheet.width - x : x, y];
  };
  const panelAt = (x: number, y: number): PanelBox | undefined => panels.find((p) => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h);
  /** artwork mm of a point on a panel (where an overlay placed there sits in the texture) */
  const toArtwork = (p: PanelBox, x: number, y: number): [number, number] => apply(artworkMatrix(textures[p.role]).clone().invert(), x - p.x, y - p.y);
  /** How a 1 mm change of offset x / y moves the artwork on the panel (it depends on turn and flip). */
  const offsetJacobian = (role: string) => {
    const t = textures[role];
    const base = t.transform ?? { ...IDENTITY_PANEL };
    const at = (ox: number, oy: number) => apply(artworkMatrix({ ...t, transform: { ...base, offset_x_mm: ox, offset_y_mm: oy } }), t.width_mm / 2, t.height_mm / 2);
    const o = at(base.offset_x_mm, base.offset_y_mm), ax = at(base.offset_x_mm + 1, base.offset_y_mm), ay = at(base.offset_x_mm, base.offset_y_mm + 1);
    const a = ax[0] - o[0], b = ay[0] - o[0], c = ax[1] - o[1], d = ay[1] - o[1], det = a * d - b * c || 1;
    return (dx: number, dy: number): [number, number] => [(d * dx - b * dy) / det, (-c * dx + a * dy) / det];
  };

  // ---- pointer: what a press on the sheet does depends on the tool and on what is under it
  const drag = useRef<null | {
    kind: "pan" | "art" | "overlay" | "line" | "kwin" | "measure" | "window";
    start: [number, number]; startClient: [number, number]; vp0: typeof vp; role?: string; id?: string; key?: string;
    off0?: [number, number]; pos0?: [number, number]; inv?: THREE.Matrix3; jac?: (dx: number, dy: number) => [number, number];
  }>(null);
  const spaceDown = useRef(false);
  // the selection card: dragged by its title bar anywhere over the canvas; remembered in this browser
  const [cardPos, setCardPos] = useState<{ x: number; y: number } | null>(() => {
    try { return JSON.parse(localStorage.getItem("dieline-card") || "null"); } catch { return null; }
  });
  const cardRef = useRef<HTMLDivElement>(null);
  const cardDrag = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    const card = cardRef.current, box = wrap.current;
    if (!card || !box) return;
    e.preventDefault();
    const b = box.getBoundingClientRect(), c = card.getBoundingClientRect();
    const dx = e.clientX - c.left, dy = e.clientY - c.top;
    let last = { x: c.left - b.left, y: c.top - b.top };
    const move = (ev: PointerEvent) => {
      last = { x: clamp(ev.clientX - b.left - dx, 0, b.width - c.width), y: clamp(ev.clientY - b.top - dy, 0, b.height - 40) };
      setCardPos(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try { localStorage.setItem("dieline-card", JSON.stringify(last)); } catch { /* private window */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // keep a remembered position inside a smaller canvas
  const cardStyle = cardPos ? { left: clamp(cardPos.x, 0, Math.max(0, size.w - 300)), top: clamp(cardPos.y, 0, Math.max(0, size.h - 60)), bottom: "auto" } : undefined;
  const hovering = useRef(false); // Space pans only while the pointer is over the dieline (else it scrolls the page)

  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button === 2) return;
    const [x, y] = toWorld(e.clientX, e.clientY);
    const start: [number, number] = [x, y];
    const base = { start, startClient: [e.clientX, e.clientY] as [number, number], vp0: vp };
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    setMenu(null);
    if (tool === "pan" || e.button === 1 || spaceDown.current) { userView.current = true; drag.current = { kind: "pan", ...base }; return; }
    const p = panelAt(x, y);
    if (tool === "measure") {
      const m = measureRef.current;
      if (!m || m.done) setMeasure({ a: start, b: start, done: false });
      else setMeasure({ ...m, b: start, done: true });
      drag.current = { kind: "measure", ...base };
      return;
    }
    if (inside) return; // the inside of the film: look and measure only
    if (tool === "text" && p) {
      const [ax, ay] = toArtwork(p, x, y);
      addOverlay(p.role, ax, ay, { kind: "text", text: "Your text" });
      return;
    }
    if (tool === "logo" && p) {
      const [ax, ay] = toArtwork(p, x, y);
      pendingLogo.current = { role: p.role, x: ax, y: ay };
      logoInput.current?.click();
      return;
    }
    if (tool === "window") {
      if (p?.face) {
        drag.current = { kind: "window", ...base, role: p.role };
        setSketch({ role: p.role, pts: [[x - p.x, y - p.y]] });
      } else setMsg("Windows go on the front or back.");
      return;
    }
    // select: a handle, a logo / text, a window, the artwork, or nothing
    const hit = (e.target as Element).closest("[data-hit]")?.getAttribute("data-hit") ?? "";
    const [kind, a1, a2] = hit.split(":");
    if (kind === "line" && a1 && a2) {
      setSel({ kind: "line", key: a1, role: a2 });
      drag.current = { kind: "line", ...base, key: a1, role: a2 };
    } else if (kind === "kwin") {
      setSel({ kind: "line", key: "window", role: a1 });
      drag.current = { kind: "kwin", ...base, role: a1, pos0: [g.window.x_mm, g.window.y_mm] };
    } else if (kind === "ov" && a1 && a2) {
      const o = panelOf(draft, a1).overlays.find((q) => q.id === a2);
      if (!o) return;
      setSel({ kind: "overlay", role: a1, id: a2 });
      drag.current = { kind: "overlay", ...base, role: a1, id: a2, pos0: [o.x_mm, o.y_mm], inv: artworkMatrix(textures[a1]).clone().invert() };
    } else if (kind === "win") {
      setSel({ kind: "window", index: Number(a1) });
    } else if (p) {
      setSel({ kind: "panel", role: p.role });
      const pd = panelOf(draft, p.role);
      if (!textures[p.role].color) drag.current = { kind: "art", ...base, role: p.role, off0: [pd.offset_x_mm, pd.offset_y_mm], jac: offsetJacobian(p.role) };
    } else setSel(null);
  };

  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const [x, y] = toWorld(e.clientX, e.clientY);
    const p = panelAt(x, y);
    setCursor({ role: p?.role ?? null, x: p ? x - p.x : x, y: p ? y - p.y : y });
    const d = drag.current;
    const m = measureRef.current;
    if (!d) {
      if (tool === "measure" && m && !m.done) setMeasure({ ...m, b: [x, y] });
      return;
    }
    const dx = x - d.start[0], dy = y - d.start[1];
    if (d.kind === "pan") {
      setVp({ ...d.vp0, tx: d.vp0.tx + e.clientX - d.startClient[0], ty: d.vp0.ty + e.clientY - d.startClient[1] });
    } else if (d.kind === "measure") {
      if (m && !m.done) setMeasure({ ...m, b: [x, y] });
    } else if (d.kind === "art" && d.role && d.off0 && d.jac) {
      const [ox, oy] = d.jac(dx, dy);
      let nx = round(d.off0[0] + ox), ny = round(d.off0[1] + oy);
      const snapX = Math.abs(nx) < 1.5, snapY = Math.abs(ny) < 1.5; // back on centre
      if (snapX) nx = 0;
      if (snapY) ny = 0;
      const box = panels.find((q) => q.role === d.role)!;
      setGuides({ role: d.role, x: snapX ? box.w / 2 : undefined, y: snapY ? box.h / 2 : undefined });
      setPanel(d.role, { offset_x_mm: nx, offset_y_mm: ny });
    } else if (d.kind === "overlay" && d.role && d.id && d.pos0 && d.inv) {
      const e2 = d.inv.elements; // linear part only: a move, not a position
      let ax = d.pos0[0] + e2[0] * dx + e2[3] * dy, ay = d.pos0[1] + e2[1] * dx + e2[4] * dy;
      const t = textures[d.role];
      const snapX = Math.abs(ax - t.width_mm / 2) < 1.5, snapY = Math.abs(ay - t.height_mm / 2) < 1.5;
      if (snapX) ax = t.width_mm / 2;
      if (snapY) ay = t.height_mm / 2;
      setGuides(snapX || snapY ? { role: d.role, ...(snapX ? { x: apply(artworkMatrix(t), t.width_mm / 2, 0)[0] } : {}), ...(snapY ? { y: apply(artworkMatrix(t), 0, t.height_mm / 2)[1] } : {}) } : null);
      setOverlay(d.role, d.id, { x_mm: round(ax), y_mm: round(ay) });
    } else if (d.kind === "line" && d.key && d.role) {
      const box = panels.find((q) => q.role === d.role)!;
      const lx = x - box.x, ly = y - box.y;
      const v = d.key === "side_seal_mm" ? (lx > box.w / 2 ? box.w - lx : lx)
        : d.key === "bottom_seal_mm" ? box.h - ly : ly;
      const limit = d.key === "side_seal_mm" ? box.w / 3 : d.key.endsWith("seal_mm") ? box.h / 3 : box.h - 1;
      setKey(d.key, clamp(round(v), 0, limit));
    } else if (d.kind === "kwin" && d.pos0 && d.role) {
      const box = panels.find((q) => q.role === d.role)!;
      change({ ...draft, keyline: { ...draft.keyline, window_x_mm: clamp(round(d.pos0[0] + dx), 0, box.w - g.window.width_mm), window_y_mm: clamp(round(d.pos0[1] + dy), 0, box.h - g.window.height_mm) } });
    } else if (d.kind === "window" && d.role && sketchRef.current) {
      const sketch = sketchRef.current;
      const box = panels.find((q) => q.role === d.role)!;
      const pt: [number, number] = [clamp(x - box.x, 0, box.w), clamp(y - box.y, 0, box.h)];
      const last = sketch.pts[sketch.pts.length - 1];
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) * vp.k < 3) return;
      setSketch({ role: d.role, pts: winMode === "rect" ? [sketch.pts[0], pt] : [...sketch.pts, pt] });
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    setGuides(null);
    const sketch = sketchRef.current;
    if (d?.kind === "window" && sketch) {
      const box = panels.find((q) => q.role === sketch.role)!;
      const norm = (pt: [number, number]): [number, number] => [clamp(pt[0] / box.w, 0, 1), clamp(pt[1] / box.h, 0, 1)];
      const pts = sketch.pts;
      if (winMode === "rect" && pts.length >= 2 && Math.abs(pts[1][0] - pts[0][0]) > 1 && Math.abs(pts[1][1] - pts[0][1]) > 1) {
        setWindows([...draft.windows, { face: sketch.role as "front" | "back", kind: "rect", points: [norm(pts[0]), norm(pts[1])] }]);
        setSel({ kind: "window", index: draft.windows.length });
      } else if (winMode === "free" && pts.length >= 3) {
        const step = Math.max(1, Math.ceil(pts.length / 300));
        setWindows([...draft.windows, { face: sketch.role as "front" | "back", kind: "free", points: pts.filter((_, i) => i % step === 0).map(norm) }]);
        setSel({ kind: "window", index: draft.windows.length });
      }
      setSketch(null);
    }
  };

  const onLogoFile = async (file: File | undefined) => {
    const at = pendingLogo.current;
    pendingLogo.current = null;
    if (!file || !at) return;
    setMsg("Uploading the picture…");
    try {
      const up = await onUpload(file);
      addOverlay(at.role, at.x, at.y, { kind: "image", file_id: up.file_id, width_mm: Math.min(40, textures[at.role].width_mm / 3) });
      setMsg("");
    } catch (err) {
      setMsg(String((err as Error).message ?? err));
    }
  };

  // ---- keyboard
  const deleteSelected = () => {
    if (sel?.kind === "overlay") removeOverlay(sel.role, sel.id);
    else if (sel?.kind === "window") { setWindows(draft.windows.filter((_, i) => i !== sel.index)); setSel(null); }
  };
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && typeof t.closest === "function" && t.closest("input, textarea, select, [contenteditable]")) return;
    if (!wrap.current?.closest(".kl-studio")?.isConnected) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === " ") { if (hovering.current) { e.preventDefault(); spaceDown.current = true; } return; }
    const toolKey = TOOLS.find(([, , key]) => key.toLowerCase() === k);
    if (toolKey) { setTool(toolKey[0]); return; }
    if (k === "escape") { setSel(null); setMeasure(null); setSketch(null); setTool("select"); setMenu(null); }
    else if (k === "delete" || k === "backspace") { if (sel) { e.preventDefault(); deleteSelected(); } }
    else if (k === "0") { userView.current = false; fit(); }
    else if (k === "+" || k === "=") zoomAt(1.25);
    else if (k === "-") zoomAt(0.8);
    else if (sel?.kind === "overlay" && k.startsWith("arrow")) {
      e.preventDefault();
      const o = panelOf(draft, sel.role).overlays.find((q) => q.id === sel.id);
      const s = e.shiftKey ? 5 : 0.5;
      if (o) setOverlay(sel.role, sel.id, { x_mm: o.x_mm + (k === "arrowleft" ? -s : k === "arrowright" ? s : 0), y_mm: o.y_mm + (k === "arrowup" ? -s : k === "arrowdown" ? s : 0) });
    }
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => keyRef.current(e);
    const up = (e: KeyboardEvent) => { if (e.key === " ") spaceDown.current = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // ---- export: the sheet in mm (SVG), printed to PDF, or a 300 dpi PNG
  const exportSvg = async (): Promise<{ svg: string; w: number; h: number }> => {
    const src = svgRef.current!.querySelector("[data-sheet]") as SVGGElement;
    const w = sheet.width + 2 * MARGIN_MM, h = sheet.height + 2 * MARGIN_MM;
    const out = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    out.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    out.setAttribute("viewBox", `${-MARGIN_MM} ${-MARGIN_MM} ${w} ${h}`);
    out.setAttribute("width", `${w}mm`);
    out.setAttribute("height", `${h}mm`);
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = exportCss();
    out.appendChild(style);
    const defs = svgRef.current!.querySelector("defs");
    if (defs) out.appendChild(defs.cloneNode(true));
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    Object.entries({ x: -MARGIN_MM, y: -MARGIN_MM, width: w, height: h, fill: "#ffffff" }).forEach(([k, v]) => bg.setAttribute(k, String(v)));
    out.appendChild(bg);
    const g2 = src.cloneNode(true) as SVGGElement;
    g2.removeAttribute("transform");
    g2.querySelectorAll("[data-ui]").forEach((n) => n.remove());
    if (!exportArt) g2.querySelectorAll("[data-layer=artwork]").forEach((n) => n.remove());
    out.appendChild(g2);
    await inlineImages(out);
    return { svg: new XMLSerializer().serializeToString(out), w, h };
  };
  const download = (blob: Blob, name: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };
  const doExport = async (kind: "svg" | "pdf" | "png") => {
    setMenu(null);
    setMsg("Preparing the dieline…");
    try {
      const { svg, w, h } = await exportSvg();
      const stem = `${itemCode}${designs.length > 1 ? `_design${design}` : ""}_dieline${exportArt ? "" : "_keyline"}`;
      if (kind === "svg") download(new Blob([svg], { type: "image/svg+xml" }), `${stem}.svg`);
      else if (kind === "png") {
        const dpi = 300, scale = Math.min(dpi / 25.4, 16000 / Math.max(w, h));
        const img = await loadImage(URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })));
        const c = document.createElement("canvas");
        c.width = Math.round(w * scale);
        c.height = Math.round(h * scale);
        c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
        const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/png"));
        if (!blob) throw new Error("The picture is too large for this browser");
        download(blob, `${stem}.png`);
      } else {
        const win = window.open("", "_blank");
        if (!win) throw new Error("Allow pop-ups for this site to print the PDF");
        win.document.write(`<!doctype html><html><head><title>${stem}</title><style>@page{size:${w}mm ${h}mm;margin:0}html,body{margin:0}svg{display:block}</style></head><body>${svg}</body></html>`);
        win.document.close();
        win.onload = () => { win.focus(); win.print(); };
        window.setTimeout(() => { try { win.focus(); win.print(); } catch { /* closed */ } }, 800);
      }
      setMsg("");
    } catch (err) {
      setMsg(`Export failed: ${String((err as Error).message ?? err)}`);
    }
  };

  // ---- drawing
  const lineHandle = (key: string, role: string, x1: number, y1: number, x2: number, y2: number) => {
    if (!(key in kl) || inside || tool !== "select") return null;
    const on = sel?.kind === "line" && sel.key === key;
    return (
      <g key={`h-${key}-${role}`} data-ui="" data-hit={`line:${key}:${role}`} className={`dl-handle ${on ? "on" : ""} ${LINE_KEYS[key].axis}`}>
        <line x1={x1} y1={y1} x2={x2} y2={y2} className="dl-handle-hit" />
        <line x1={x1} y1={y1} x2={x2} y2={y2} className="dl-handle-line" />
      </g>
    );
  };

  const drawPanel = (p: PanelBox) => {
    const t: SceneTexture = textures[p.role];
    const m = artworkMatrix(t);
    const r = p.face ? g.corner_radius_mm : 0;
    const s = g.seals, top = s.top || s.crimp, bottom = s.bottom || s.crimp;
    const zones = p.face ? sealZones(g, p.w, p.h) : { rects: [], kseal: [] };
    const safe = safeRect(g, p);
    const pd = panelOf(draft, p.role);
    const overlays = t.bake?.overlays ?? [];
    const selected = sel?.kind === "panel" && sel.role === p.role;
    const spoutCut = p.face && g.spout && g.spout.position !== "top_center" ? (g.spout.cap_diameter_mm ?? 30) * 1.1 : 0;
    const spoutRight = g.spout?.position === "top_right_corner" ? p.role === "front" : p.role === "back";
    const nd = g.tear_notch.depth_mm || 4, ny = g.tear_notch.y_from_top_mm;
    const kw = g.window;
    const windows = draft.windows.map((w, i) => ({ w, i })).filter(({ w }) => w.face === p.role);
    return (
      <g key={p.role} transform={`translate(${p.x} ${p.y})`}>
        <text x={0} y={-MARGIN_MM + 8} className="dl-title">{p.role[0].toUpperCase() + p.role.slice(1).replace(/_/g, " ")} · {p.w} × {p.h} mm{pd.source !== "auto" ? ` · ${pd.source.startsWith("sheet") ? "sheet panel" : pd.source}` : ""}</text>
        {layers.bleed && <rect x={-BLEED_MM} y={-BLEED_MM} width={p.w + 2 * BLEED_MM} height={p.h + 2 * BLEED_MM} rx={r ? r + BLEED_MM : 0} className="dl-bleed" />}
        {layers.artwork && !inside && (
          <g data-layer="artwork" clipPath={`url(#clip-${p.role})`}>
            {t.clear ? <rect width={p.w} height={p.h} fill="url(#dl-clear)" />
              : t.color ? <rect width={p.w} height={p.h} fill={t.color} />
              : images[p.role] ? (
                <g transform={svgMatrix(m)}>
                  <image href={images[p.role]} x={0} y={0} width={t.width_mm} height={t.height_mm} preserveAspectRatio="none" />
                </g>
              ) : <rect width={p.w} height={p.h} fill="#e8ebf0" />}
          </g>
        )}
        {(inside || !layers.artwork) && <rect width={p.w} height={p.h} rx={r} fill={inside ? "#f6f7f9" : "#ffffff"} />}
        {inside && <text x={p.w / 2} y={p.h / 2} className="dl-note" textAnchor="middle">inside (unprinted film)</text>}
        {layers.seals && zones.rects.map(([x, y, w, h], i) => <rect key={`s${i}`} x={x} y={y} width={w} height={h} className="dl-seal" />)}
        {layers.seals && zones.kseal.map((pts, i) => <polygon key={`k${i}`} points={pts.map((q) => q.join(",")).join(" ")} className="dl-seal" />)}
        {layers.folds && p.face && g.shape === "stand_up_bottom_gusset" && g.gusset_depth_mm > 0 && (
          <g><line x1={0} y1={p.h - g.gusset_depth_mm} x2={p.w} y2={p.h - g.gusset_depth_mm} className="dl-fold" />
            <text x={p.w / 2} y={p.h - g.gusset_depth_mm - 1.5} className="dl-note" textAnchor="middle">gusset fold (depth {g.gusset_depth_mm} mm)</text></g>
        )}
        {layers.folds && p.role === "gusset" && <g><line x1={0} y1={p.h / 2} x2={p.w} y2={p.h / 2} className="dl-fold" /><text x={p.w / 2} y={p.h / 2 - 1.5} className="dl-note" textAnchor="middle">centre fold (base)</text></g>}
        {layers.folds && p.role.startsWith("side") && <line x1={p.w / 2} y1={0} x2={p.w / 2} y2={p.h} className="dl-fold" />}
        {layers.zipper && p.face && g.zipper.enabled && (
          <g><line x1={s.side} y1={g.zipper.y_from_top_mm} x2={p.w - s.side} y2={g.zipper.y_from_top_mm} className="dl-zip" />
            <text x={p.w / 2} y={g.zipper.y_from_top_mm - 1.5} className="dl-note" textAnchor="middle">zipper {g.zipper.y_from_top_mm} mm from top</text></g>
        )}
        {layers.cuts && p.face && g.tear_notch.type !== "none" && (
          <g>
            {g.tear_notch.type === "straight"
              ? <><rect x={0} y={ny - 0.35} width={nd} height={0.7} className="dl-cut" /><rect x={p.w - nd} y={ny - 0.35} width={nd} height={0.7} className="dl-cut" /></>
              : g.tear_notch.type === "laser_score" ? <line x1={s.side} y1={ny} x2={p.w - s.side} y2={ny} className="dl-score" />
              : <><path d={`M0 ${ny - nd / 2} L${nd} ${ny} L0 ${ny + nd / 2} Z`} className="dl-cut" /><path d={`M${p.w} ${ny - nd / 2} L${p.w - nd} ${ny} L${p.w} ${ny + nd / 2} Z`} className="dl-cut" /></>}
            {g.butterfly_notch && <><path d={`M0 ${ny + 6 - 1.5} L3 ${ny + 6} L0 ${ny + 6 + 1.5} Z`} className="dl-cut" /><path d={`M${p.w} ${ny + 6 - 1.5} L${p.w - 3} ${ny + 6} L${p.w} ${ny + 6 + 1.5} Z`} className="dl-cut" /></>}
            <text x={nd + 1.5} y={ny + 1} className="dl-note">{g.tear_notch.type.replace(/_/g, " ")} {ny} mm</text>
          </g>
        )}
        {layers.cuts && p.face && g.hang_hole.type === "round" && <circle cx={p.w / 2} cy={g.hang_hole.offset_mm} r={g.hang_hole.size_mm / 2} className="dl-cut" />}
        {layers.cuts && p.face && g.hang_hole.type === "euro" && (
          <rect x={p.w / 2 - g.hang_hole.size_mm * 1.6} y={g.hang_hole.offset_mm - g.hang_hole.size_mm / 2} width={g.hang_hole.size_mm * 3.2} height={g.hang_hole.size_mm} rx={g.hang_hole.size_mm / 2} className="dl-cut" />
        )}
        {layers.cuts && spoutCut > 0 && <path d={spoutRight ? `M${p.w - spoutCut} 0 L${p.w} 0 L${p.w} ${spoutCut} Z` : `M0 0 L${spoutCut} 0 L0 ${spoutCut} Z`} className="dl-cut" />}
        {layers.windows && p.face && kw.enabled && (
          <rect x={kw.x_mm} y={kw.y_mm} width={kw.width_mm} height={kw.height_mm} rx={kw.radius_mm} className={`dl-win ${sel?.kind === "line" && sel.key === "window" ? "on" : ""}`}
            data-hit={`kwin:${p.role}`} style={{ cursor: tool === "select" && "window_x_mm" in kl ? "move" : undefined }} />
        )}
        {layers.windows && wandMasks[p.role] && <image href={wandMasks[p.role]} width={p.w} height={p.h} preserveAspectRatio="none" />}
        {layers.windows && windows.map(({ w, i }) => w.kind === "wand"
          ? <circle key={`w${i}`} cx={w.points[0][0] * p.w} cy={w.points[0][1] * p.h} r={2} className={`dl-wand ${sel?.kind === "window" && sel.index === i ? "on" : ""}`} data-hit={`win:${i}`} />
          : <polygon key={`w${i}`} points={windowPoints(w, p).map((q) => q.join(",")).join(" ")} className={`dl-win ${sel?.kind === "window" && sel.index === i ? "on" : ""}`} data-hit={`win:${i}`} />)}
        {layers.safe && <rect x={safe[0]} y={safe[1]} width={safe[2]} height={safe[3]} className="dl-safe" />}
        {layers.cut && <rect x={0} y={0} width={p.w} height={p.h} rx={r} className="dl-outline" />}
        {layers.cut && p.face && g.template === "shaped_diecut" && g.outline_svg && (
          <image href={`data:image/svg+xml;utf8,${encodeURIComponent(g.outline_svg)}`} width={p.w} height={p.h} preserveAspectRatio="none" opacity={0.6} />
        )}
        {layers.dims && (
          <g className="dl-dims">
            <line x1={0} y1={-8} x2={p.w} y2={-8} markerStart="url(#dl-arrow)" markerEnd="url(#dl-arrow)" />
            <text x={p.w / 2} y={-9.5} textAnchor="middle">{p.w} mm</text>
            <line x1={-8} y1={0} x2={-8} y2={p.h} markerStart="url(#dl-arrow)" markerEnd="url(#dl-arrow)" />
            <text x={-9.5} y={p.h / 2} textAnchor="middle" transform={`rotate(-90 ${-9.5} ${p.h / 2})`}>{p.h} mm</text>
            {p.face && s.side > 0 && <><line x1={0} y1={p.h + 8} x2={s.side} y2={p.h + 8} markerStart="url(#dl-arrow)" markerEnd="url(#dl-arrow)" /><text x={s.side / 2} y={p.h + 13} textAnchor="middle">{s.side}</text></>}
            {p.face && top > 0 && <><line x1={p.w + 8} y1={0} x2={p.w + 8} y2={top} markerStart="url(#dl-arrow)" markerEnd="url(#dl-arrow)" /><text x={p.w + 10} y={top / 2 + 1} >{top}</text></>}
            {p.face && bottom > 0 && <><line x1={p.w + 8} y1={p.h - bottom} x2={p.w + 8} y2={p.h} markerStart="url(#dl-arrow)" markerEnd="url(#dl-arrow)" /><text x={p.w + 10} y={p.h - bottom / 2 + 1}>{bottom}</text></>}
          </g>
        )}
        {/* editing (never exported): dieline handles, logo / text outlines, selection, snap guides */}
        {p.face && !inside && tool === "select" && (
          <g data-ui="">
            {g.zipper.enabled && lineHandle("zipper_offset_from_top_mm", p.role, s.side, g.zipper.y_from_top_mm, p.w - s.side, g.zipper.y_from_top_mm)}
            {top > 0 && lineHandle("top_seal_mm", p.role, 0, top, p.w, top)}
            {bottom > 0 && lineHandle("bottom_seal_mm", p.role, 0, p.h - bottom, p.w, p.h - bottom)}
            {s.side > 0 && lineHandle("side_seal_mm", p.role, s.side, 0, s.side, p.h)}
            {s.side > 0 && lineHandle("side_seal_mm", p.role, p.w - s.side, 0, p.w - s.side, p.h)}
            {g.tear_notch.type !== "none" && lineHandle("tear_notch_offset_mm", p.role, 0, ny, nd * 3, ny)}
            {g.hang_hole.type !== "none" && lineHandle("hang_hole_offset_mm", p.role, p.w / 2 - g.hang_hole.size_mm * 2, g.hang_hole.offset_mm, p.w / 2 + g.hang_hole.size_mm * 2, g.hang_hole.offset_mm)}
          </g>
        )}
        {!inside && layers.artwork && overlays.length > 0 && (
          <g data-ui="">
            {overlays.map((o) => {
              const pts = overlayCorners(o, m, aspects[String(o.file_id)]);
              const on = sel?.kind === "overlay" && sel.id === o.id;
              return <polygon key={o.id} points={pts.map((q) => q.join(",")).join(" ")} data-hit={`ov:${p.role}:${o.id}`}
                className={`dl-ov ${on ? "on" : ""} ${badOverlays.has(o.id) ? "bad" : ""}`} style={{ cursor: tool === "select" ? "move" : undefined }} />;
            })}
          </g>
        )}
        {selected && <rect data-ui="" x={-1} y={-1} width={p.w + 2} height={p.h + 2} rx={r} className="dl-selected" />}
        {guides?.role === p.role && (
          <g data-ui="">
            {guides.x !== undefined && <line x1={guides.x} y1={-4} x2={guides.x} y2={p.h + 4} className="dl-guide" />}
            {guides.y !== undefined && <line x1={-4} y1={guides.y} x2={p.w + 4} y2={guides.y} className="dl-guide" />}
          </g>
        )}
        {sketch?.role === p.role && (
          <g data-ui="">
            {winMode === "rect" && sketch.pts.length > 1
              ? <rect x={Math.min(sketch.pts[0][0], sketch.pts[1][0])} y={Math.min(sketch.pts[0][1], sketch.pts[1][1])} width={Math.abs(sketch.pts[1][0] - sketch.pts[0][0])} height={Math.abs(sketch.pts[1][1] - sketch.pts[0][1])} className="dl-sketch" />
              : <polyline points={sketch.pts.map((q) => q.join(",")).join(" ")} className="dl-sketch" />}
          </g>
        )}
      </g>
    );
  };

  // rulers: mm from the sheet's top-left (the first panel's corner)
  const step = niceStep(vp.k);
  const rulerTicks = (axis: "x" | "y") => {
    const len = axis === "x" ? size.w : size.h, off = axis === "x" ? vp.tx : vp.ty;
    const first = Math.ceil(-off / vp.k / step) * step, out: ReactNode[] = [];
    for (let v = first; (v * vp.k + off) < len; v += step) {
      const px = v * vp.k + off;
      for (let s2 = 1; s2 < 5; s2++) {
        const q = px + (s2 * step * vp.k) / 5;
        out.push(axis === "x" ? <line key={`m${v}-${s2}`} x1={q} y1={14} x2={q} y2={18} /> : <line key={`m${v}-${s2}`} x1={14} y1={q} x2={18} y2={q} />);
      }
      const label = inside && axis === "x" ? Math.round(sheet.width - v) : v;
      out.push(axis === "x"
        ? <g key={v}><line x1={px} y1={8} x2={px} y2={18} /><text x={px + 3} y={10}>{label}</text></g>
        : <g key={v}><line x1={8} y1={px} x2={18} y2={px} /><text x={10} y={px - 3} transform={`rotate(-90 10 ${px - 3})`}>{label}</text></g>);
    }
    return out;
  };

  const selOverlay = sel?.kind === "overlay" ? panelOf(draft, sel.role).overlays.find((o) => o.id === sel.id) ?? null : null;
  const selPanel = sel?.kind === "panel" ? panelOf(draft, sel.role) : null;
  const measureLen = measure ? Math.hypot(measure.b[0] - measure.a[0], measure.b[1] - measure.a[1]) : 0;
  const issues = allChecks.length, bad = allChecks.filter((c) => c.level === "bad").length;
  const gotoCheck = (c: Check) => {
    setMenu(null);
    if (c.target?.kind === "overlay") setSel({ kind: "overlay", role: c.role, id: c.target.id });
    else if (c.target?.kind === "window") setSel({ kind: "window", index: c.target.index });
    else if (c.target?.kind === "line") setSel({ kind: "line", key: c.target.key, role: c.role });
    else setSel({ kind: "panel", role: c.role });
    setTool("select");
  };
  const cursorStyle = tool === "pan" ? (drag.current?.kind === "pan" ? "grabbing" : "grab") : tool === "select" ? "default" : "crosshair";

  return (
    <div className="kl-studio">
      <div className="kl-top">
        <div className="kl-title">
          <b>Keyline & Dieline Studio</b>
          {dirty ? <span className="badge warn">preview · not applied</span> : <span className="badge ok">saved</span>}
          {msg && <span className="small muted">{msg}</span>}
          <DesignPicker designs={designs} picked={[design]} onChange={(p) => setDesign(p[0])} />
        </div>
        <div className="kl-actions">
          <div className="seg-toggle">
            <button onClick={undo} disabled={!past.current.length} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon d={I.undo} size={16} /></button>
            <button onClick={redo} disabled={!future.current.length} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Icon d={I.redo} size={16} /></button>
          </div>
          <div className="seg-toggle">
            <button onClick={() => zoomAt(0.8)} title="Zoom out (-)" aria-label="Zoom out"><Icon d={I.minus} size={16} /></button>
            <button onClick={() => { userView.current = false; fit(); }} title="Fit the sheet (0)" className="kl-zoom">{Math.round(vp.k * 100 / 3.78)}%</button>
            <button onClick={() => zoomAt(1.25)} title="Zoom in (+)" aria-label="Zoom in"><Icon d={I.plus} size={16} /></button>
          </div>
          <div className="seg-toggle">
            <button className={!inside ? "on" : ""} onClick={() => setInside(false)} title="The printed outside">Outside</button>
            <button className={inside ? "on" : ""} onClick={() => { setInside(true); setSel(null); }} title="The inside of the film, mirrored">Inside</button>
          </div>
          <div className="kl-menu-wrap">
            <button className={menu === "layers" ? "on" : ""} onClick={() => setMenu(menu === "layers" ? null : "layers")}><Icon d={I.layers} size={16} /> Layers</button>
            {menu === "layers" && (
              <div className="kl-menu">
                {LAYERS.map(([l, label]) => <label key={l} className="check"><input type="checkbox" checked={layers[l]} onChange={(e) => setLayer(l, e.target.checked)} /> {label}</label>)}
              </div>
            )}
          </div>
          <div className="kl-menu-wrap">
            <button className={menu === "checks" ? "on" : ""} onClick={() => setMenu(menu === "checks" ? null : "checks")} title="Print and seal checks">
              <Icon d={I.check} size={16} /> Checks {issues > 0 && <span className={`badge ${bad ? "bad" : "warn"}`}>{issues}</span>}
            </button>
            {menu === "checks" && (
              <div className="kl-menu wide">
                {issues === 0 && <div className="small"><span className="badge ok">all clear</span> Text and logos are inside the safe zone, windows clear of the seals, zipper and notches in place.</div>}
                {allChecks.map((c, i) => (
                  <button key={i} className="kl-check" onClick={() => gotoCheck(c)}><span className={`badge ${c.level === "bad" ? "bad" : "warn"}`}>{c.level === "bad" ? "fix" : "check"}</span> {c.message}</button>
                ))}
              </div>
            )}
          </div>
          <div className="kl-menu-wrap">
            <button className={menu === "export" ? "on" : ""} onClick={() => setMenu(menu === "export" ? null : "export")}><Icon d={I.download} size={16} /> Export</button>
            {menu === "export" && (
              <div className="kl-menu">
                <label className="check"><input type="checkbox" checked={exportArt} onChange={(e) => setExportArt(e.target.checked)} /> With artwork</label>
                <button onClick={() => doExport("svg")}>SVG (vector, mm)</button>
                <button onClick={() => doExport("pdf")}>PDF (print dialog, true size)</button>
                <button onClick={() => doExport("png")}>PNG (300 dpi)</button>
                <div className="small muted">The layers that are switched on are exported; editing handles are left out.</div>
              </div>
            )}
          </div>
          <button className={split ? "on" : ""} onClick={() => setSplit(!split)} title="The 3D pouch beside the dieline, updating live"><Icon d={I.split} size={16} /> 3D beside</button>
          <button className={side ? "on" : ""} onClick={() => setSide(!side)} title="Show or hide the Adjust panel"><Icon d={I.layers} size={16} /> Adjust</button>
          <button onClick={onSwitchTo3D}><Icon d={I.cube} size={16} /> 3D tab</button>
          <button className="primary" disabled={busy || running || !dirty} onClick={() => onApply(false)} title="Save the draft: re-render the 3D model, renders and GLB">{busy ? "Applying…" : "Apply and re-render"}</button>
        </div>
      </div>

      <div className={`kl-body ${split ? "split" : ""} ${side ? "" : "no-side"}`}>
        <div className="kl-rail">
          {TOOLS.map(([t, label, key, d]) => (
            <button key={t} className={tool === t ? "on" : ""} onClick={() => { setTool(t); setMeasure(null); }} title={`${label} (${key})`} aria-label={label}><Icon d={d} /></button>
          ))}
        </div>

        <div className="kl-canvas" ref={wrap}>
          <svg ref={svgRef} className="kl-svg" style={{ cursor: cursorStyle }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
            onPointerEnter={() => { hovering.current = true; }} onPointerLeave={() => { hovering.current = false; setCursor(null); }} onContextMenu={(e) => e.preventDefault()}>
            <defs>
              <marker id="dl-arrow" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0 L6 3 L0 6 Z" fill={BLUE} /></marker>
              <pattern id="dl-clear" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#eaf4ff" /><rect width="3" height="3" fill="#d7e8fb" /><rect x="3" y="3" width="3" height="3" fill="#d7e8fb" /></pattern>
              <pattern id="dl-grid" width={step} height={step} patternUnits="userSpaceOnUse"><path d={`M${step} 0 L0 0 0 ${step}`} fill="none" stroke="rgba(79,70,229,.14)" strokeWidth={1 / vp.k} /></pattern>
              {panels.map((p) => <clipPath key={p.role} id={`clip-${p.role}`}><rect width={p.w} height={p.h} rx={p.face ? g.corner_radius_mm : 0} /></clipPath>)}
            </defs>
            <g transform={`translate(${vp.tx} ${vp.ty}) scale(${vp.k})`} style={{ ["--px" as string]: `${1 / vp.k}` }}>
              {layers.grid && <rect data-ui="" x={-MARGIN_MM * 4} y={-MARGIN_MM * 4} width={sheet.width + MARGIN_MM * 8} height={sheet.height + MARGIN_MM * 8} fill="url(#dl-grid)" />}
              <g data-sheet="" transform={inside ? `translate(${sheet.width} 0) scale(-1 1)` : undefined}>
                {panels.map(drawPanel)}
                {measure && (
                  <g data-ui="" className="dl-measure">
                    <line x1={measure.a[0]} y1={measure.a[1]} x2={measure.b[0]} y2={measure.b[1]} />
                    <circle cx={measure.a[0]} cy={measure.a[1]} r={3 / vp.k} /><circle cx={measure.b[0]} cy={measure.b[1]} r={3 / vp.k} />
                  </g>
                )}
              </g>
            </g>
          </svg>
          <svg className="kl-ruler top">{rulerTicks("x")}</svg>
          <svg className="kl-ruler left">{rulerTicks("y")}</svg>
          <div className="kl-ruler-corner">mm</div>

          {tool === "window" && (
            <div className="kl-float top">
              <span className="small">Window:</span>
              <div className="seg-toggle">
                <button className={winMode === "rect" ? "on" : ""} onClick={() => setWinMode("rect")}>Rectangle</button>
                <button className={winMode === "free" ? "on" : ""} onClick={() => setWinMode("free")}>Free shape</button>
              </div>
              <span className="small muted">Drag on the front or back. Pick-area windows are made in the 3D view.</span>
            </div>
          )}
          {(tool === "text" || tool === "logo") && <div className="kl-float top small">Click on a panel where the {tool === "text" ? "text" : "logo"} should go.</div>}
          {tool === "measure" && (
            <div className="kl-float top small">
              {measure ? <>Distance <b>{measureLen.toFixed(1)} mm</b> · ↔ {Math.abs(measure.b[0] - measure.a[0]).toFixed(1)} · ↕ {Math.abs(measure.b[1] - measure.a[1]).toFixed(1)} mm {measure.done && "· click to measure again"}</> : "Click two points to measure between them."}
            </div>
          )}

          {sel && !inside && (
            <div className="kl-inspector" ref={cardRef} style={cardStyle}>
              <div className="kl-inspector-head" onPointerDown={cardDrag} onDoubleClick={() => { setCardPos(null); try { localStorage.removeItem("dieline-card"); } catch { /* private window */ } }}
                title="Drag to move · double-click to put it back">
                <b>{sel.kind === "panel" ? `${sel.role.replace(/_/g, " ")} artwork` : sel.kind === "overlay" ? (selOverlay?.kind === "text" ? "Text" : "Logo") : sel.kind === "window" ? `Window ${sel.index + 1}` : sel.key === "window" ? "Window (keyline)" : LINE_KEYS[sel.key]?.label}</b>
                <button className="icon-btn" onClick={() => setSel(null)} aria-label="Close"><Icon d={I.close} size={16} /></button>
              </div>
              {sel.kind === "panel" && selPanel && (
                textures[sel.role].color ? <div className="small muted">A plain-colour panel: set its colour under "Artwork per panel" on the right.</div> : (
                  <div className="stack">
                    <div className="small muted">Drag the artwork to move it; it snaps back to the centre.</div>
                    <label className="small">Scale {Math.round(selPanel.scale * 100)}%
                      <input type="range" min={0.5} max={2} step={0.01} value={selPanel.scale} onChange={(e) => setPanel(sel.role, { scale: Number(e.target.value) })} />
                    </label>
                    <div className="row">
                      <button onClick={() => setPanel(sel.role, { rotation: (selPanel.rotation + 180) % 360 })}>Turn 180°</button>
                      {Math.abs(textures[sel.role].width_mm - textures[sel.role].height_mm) < 0.5 && <button onClick={() => setPanel(sel.role, { rotation: (selPanel.rotation + 90) % 360 })}>Turn 90°</button>}
                      <label className="check"><input type="checkbox" checked={selPanel.flip_x} onChange={(e) => setPanel(sel.role, { flip_x: e.target.checked })} /> Mirror</label>
                      <label className="check"><input type="checkbox" checked={selPanel.flip_y} onChange={(e) => setPanel(sel.role, { flip_y: e.target.checked })} /> Flip</label>
                    </div>
                    <div className="small muted">Offset {selPanel.offset_x_mm} / {selPanel.offset_y_mm} mm</div>
                    <button onClick={() => setPanel(sel.role, { offset_x_mm: 0, offset_y_mm: 0, scale: 1, rotation: 0, flip_x: false, flip_y: false })}>Back to as printed</button>
                  </div>
                )
              )}
              {sel.kind === "overlay" && selOverlay && (
                <OverlayControls o={selOverlay} panel={textures[sel.role]} files={files}
                  onChange={(patch) => setOverlay(sel.role, sel.id, patch)} onRemove={() => removeOverlay(sel.role, sel.id)} onOrder={(dir) => orderOverlay(sel.role, sel.id, dir)} />
              )}
              {sel.kind === "window" && draft.windows[sel.index] && (
                <div className="stack">
                  <div className="small">{draft.windows[sel.index].face} · {{ wand: "picked area", free: "free shape", rect: "rectangle" }[draft.windows[sel.index].kind]}</div>
                  <button className="danger" onClick={deleteSelected}><Icon d={I.trash} size={14} /> Remove window</button>
                </div>
              )}
              {sel.kind === "line" && sel.key === "window" && (
                <div className="grid2">
                  {(["window_x_mm", "window_y_mm", "window_width_mm", "window_height_mm", "window_corner_radius_mm"] as const).map((k) => (
                    <label key={k} className="small">{{ window_x_mm: "From left", window_y_mm: "From top", window_width_mm: "Width", window_height_mm: "Height", window_corner_radius_mm: "Corners" }[k]} (mm)
                      <input type="number" step={0.5} value={String(draft.keyline[k] ?? kl[k]?.value ?? "")} onChange={(e) => setKey(k, e.target.value === "" ? null : Number(e.target.value))} />
                    </label>
                  ))}
                </div>
              )}
              {sel.kind === "line" && sel.key in LINE_KEYS && (
                <label className="small">{LINE_KEYS[sel.key].label} (mm)
                  <input type="number" step={0.5} min={0} value={String(draft.keyline[sel.key] ?? kl[sel.key]?.value ?? "")} onChange={(e) => setKey(sel.key, e.target.value === "" ? null : Number(e.target.value))} />
                  <span className="muted">Or drag the line on the dieline.</span>
                </label>
              )}
            </div>
          )}

          <div className="kl-status small">
            {cursor ? <>{cursor.role ? `${cursor.role.replace(/_/g, " ")} · ` : ""}x {cursor.x.toFixed(1)} · y {cursor.y.toFixed(1)} mm</> : `${panels.length} panel${panels.length === 1 ? "" : "s"} · ${g.template.replace(/_/g, " ")}`}
            <span className="muted"> · scroll to zoom · Space+drag or middle button to pan · Del removes · Ctrl+Z undo</span>
          </div>
          <input ref={logoInput} type="file" hidden accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp,application/pdf,.pdf" onChange={(e) => { onLogoFile(e.target.files?.[0]); e.target.value = ""; }} />
        </div>

        {split && (
          <div className="kl-split">
            <Viewer scene={liveScene} draft={draft} name={itemCode} onWindows={setWindows} />
          </div>
        )}

        {side && <aside className="kl-side">
          {running ? <div className="msg warn small">The job is running: edits wait until it finishes.</div> : (
            <AdjustPanel scene={liveScene} job={job} draft={draft} dirty={dirty} busy={busy} isAdmin={isAdmin}
              onChange={change} onApply={onApply} onReset={onReset} onUpload={onUpload} />
          )}
        </aside>}
      </div>
    </div>
  );
}
