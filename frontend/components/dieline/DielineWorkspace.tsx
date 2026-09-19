"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Box, Circle, Hand, ImagePlus, Layers, Lock, Maximize2, Minus, MousePointer2, Plus, Redo2, RotateCw, Square, Trash2, Type, Undo2, Unlock, FlipHorizontal2, FlipVertical2, ChevronUp, ChevronDown, Ruler, Copy } from "lucide-react";
import { useEditorStore } from "@/store/useEditorStore";
import { useShallow } from "zustand/react/shallow";
import { DielineStage, type StageTool } from "./DielineStage";
import { KeylineFields } from "./KeylineFields";
import { DEFAULT_KEYLINES, POUCH_TYPE_LABELS, newItemId, pouchTypeForModel, sanitizeKeyline, type DielineFace, type DielineImageItem, type DielineItem, type DielinePanel, type DielineState, type Keyline, type PouchType } from "@/lib/dieline/types";
import { computeSheetLayout, faceOf, pouchSizeFromScale, sizeScaleFromPouch, type Rect } from "@/lib/dieline/layout";
import { fitRect } from "@/lib/dieline/render";
import { toast } from "@/lib/toast";

const PACKAGE_COLORS = ["#ffffff", "#f5f5f4", "#e7e5e4", "#facc15", "#f9a8d4", "#92400e", "#166534", "#1e3a8a", "#111827"];
const MAX_UPLOAD_PX = 2048;
const HISTORY_LIMIT = 60;

/** The 2D dieline editor: place artwork on the flat keyline while the 3D pouch updates live. */
export function DielineWorkspace() {
  const { dieline, setDieline, fileName, sizeScale, setSizeScale, setAllMaterialColors, materials, setToggle } = useEditorStore(
    useShallow((s) => ({ dieline: s.dieline, setDieline: s.setDieline, fileName: s.fileName, sizeScale: s.sizeScale, setSizeScale: s.setSizeScale, setAllMaterialColors: s.setAllMaterialColors, materials: s.materials, setToggle: s.setToggle }))
  );
  const pouchType = pouchTypeForModel(fileName);
  const size = useMemo(() => pouchSizeFromScale(sizeScale), [sizeScale]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<StageTool>("select");
  const [zoom, setZoom] = useState(1);
  const [rail, setRail] = useState<"uploads" | "text" | "shapes" | "keyline">("uploads");
  const [uploads, setUploads] = useState<{ src: string; name: string; w: number; h: number }[]>([]);
  const [defaults, setDefaults] = useState<Record<PouchType, Keyline> | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);

  // ---- history (undo / redo) of the dieline state
  const history = useRef<{ past: DielineState[]; future: DielineState[] }>({ past: [], future: [] });
  const [historyVersion, setHistoryVersion] = useState(0);
  const commit = useCallback(() => {
    const current = useEditorStore.getState().dieline;
    if (!current) return;
    const h = history.current;
    const last = h.past[h.past.length - 1];
    if (last && JSON.stringify(last) === JSON.stringify(current)) return;
    h.past = [...h.past.slice(-HISTORY_LIMIT), current];
    h.future = [];
    setHistoryVersion((v) => v + 1);
  }, []);
  const update = useCallback((fn: (prev: DielineState) => DielineState, record = true) => {
    setDieline((prev) => (prev ? fn(prev) : prev));
    if (record) setTimeout(commit, 0);
  }, [setDieline, commit]);
  const undo = () => {
    const h = history.current;
    if (h.past.length < 2) return;
    const current = h.past[h.past.length - 1];
    h.future = [current, ...h.future];
    h.past = h.past.slice(0, -1);
    setDieline(h.past[h.past.length - 1]);
    setHistoryVersion((v) => v + 1);
  };
  const redo = () => {
    const h = history.current;
    if (!h.future.length) return;
    const [next, ...rest] = h.future;
    h.future = rest;
    h.past = [...h.past, next];
    setDieline(next);
    setHistoryVersion((v) => v + 1);
  };

  // ---- keyline defaults (admin-editable) and first-time dieline creation
  useEffect(() => {
    fetch("/api/keylines").then((r) => (r.ok ? r.json() : null)).then((d) => d && setDefaults(d)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!pouchType || dieline) return;
    if (!defaults) return;
    const fresh: DielineState = { pouchType, keyline: sanitizeKeyline(defaults[pouchType], DEFAULT_KEYLINES[pouchType]), items: [], activeFace: "outside" };
    setDieline(fresh);
    history.current = { past: [fresh], future: [] };
  }, [pouchType, dieline, defaults, setDieline]);
  useEffect(() => {
    if (dieline && history.current.past.length === 0) history.current = { past: [dieline], future: [] };
  }, [dieline]);

  // ---- keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (!selectedId) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeItem(selectedId); }
      const step = e.shiftKey ? 5 : 1;
      const nudge = (dx: number, dy: number) => update((p) => ({ ...p, items: p.items.map((it) => (it.id === selectedId && !it.locked ? { ...it, x: it.x + dx, y: it.y + dy } : it)) }));
      if (e.key === "ArrowLeft") { e.preventDefault(); nudge(-step, 0); }
      if (e.key === "ArrowRight") { e.preventDefault(); nudge(step, 0); }
      if (e.key === "ArrowUp") { e.preventDefault(); nudge(0, -step); }
      if (e.key === "ArrowDown") { e.preventDefault(); nudge(0, step); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, update]);

  if (!pouchType) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-slate-50 text-center p-8">
        <Ruler className="w-8 h-8 text-slate-300" />
        <p className="text-sm font-bold text-slate-700">No dieline for this model yet</p>
        <p className="text-xs text-slate-400 max-w-sm">The 2D dieline editor supports the Stand-Up Pouch and flat three-side-seal pouches. Other models use the per-side artwork slots.</p>
        <button type="button" onClick={() => setToggle("editorView", "3d")} className="mt-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-bold">Back to 3D view</button>
      </div>
    );
  }
  if (!dieline) {
    return <div className="flex-1 flex items-center justify-center text-xs text-slate-400 bg-slate-50">Loading keyline defaults…</div>;
  }

  const layout = computeSheetLayout(dieline.pouchType, size, dieline.keyline);
  const selected = dieline.items.find((it) => it.id === selectedId) || null;
  const patchItem = (id: string, patch: Partial<DielineItem>, record = true) =>
    update((p) => ({ ...p, items: p.items.map((it) => (it.id === id ? ({ ...it, ...patch } as DielineItem) : it)) }), record);
  const removeItem = (id: string) => { update((p) => ({ ...p, items: p.items.filter((it) => it.id !== id) })); setSelectedId(null); };
  const addItem = (item: DielineItem) => { update((p) => ({ ...p, items: [...p.items, item] })); setSelectedId(item.id); };
  const baseItem = (panel: DielinePanel, rect: Rect) => ({ id: newItemId(), face: dieline.activeFace, x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, rotation: 0, opacity: 1, clip: "panel" as const, panel });

  // ---- uploads: keep proportions, fill the chosen panel (incl. bleed), crop the rest
  const placeImage = (up: { src: string; name: string; w: number; h: number }, panel: DielinePanel, mode: "fill" | "fit" | "sheet") => {
    const target = mode === "sheet" ? { x: 0, y: 0, w: layout.width, h: layout.height } : faceOf(layout, panel).outer;
    const box = fitRect(up.w, up.h, target, mode === "fit" ? "fit" : "fill");
    const item: DielineImageItem = { ...baseItem(panel, target), type: "image", src: up.src, name: up.name, naturalW: up.w, naturalH: up.h, x: box.x, y: box.y, w: box.w, h: box.h, clip: mode === "sheet" ? "none" : "panel" };
    addItem(item);
  };
  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    files.forEach((file) => {
      if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) { toast.error("Unsupported file", "Please upload a JPG, PNG, WebP or SVG image."); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let w = img.width, h = img.height;
          const scale = Math.min(1, MAX_UPLOAD_PX / Math.max(w, h));
          w = Math.round(w * scale); h = Math.round(h * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.drawImage(img, 0, 0, w, h);
          // PNG / SVG keep their transparency (needed for clear film); photos become JPEG
          const keepAlpha = file.type === "image/png" || file.type === "image/svg+xml" || file.type === "image/webp";
          const src = keepAlpha ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.88);
          const up = { src, name: file.name, w, h };
          setUploads((list) => [up, ...list]);
          placeImage(up, "front", "fill");
        };
        img.onerror = () => toast.error("Could not read image", file.name);
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    });
  };

  const addText = () => {
    const f = faceOf(layout, "front");
    addItem({ ...baseItem("front", f.safe), type: "text", text: "Your text", fontSizeMm: 10, color: "#111827", bold: true, fontFamily: "Arial, Helvetica, sans-serif", align: "center", w: Math.min(80, f.safe.w), h: 14, clip: "none" });
  };
  const addShape = (type: "rect" | "ellipse") => {
    const f = faceOf(layout, "front");
    const s = Math.min(40, f.safe.w, f.safe.h);
    addItem({ ...baseItem("front", f.safe), type, fill: "#facc15", stroke: "#111827", strokeMm: 0, w: s, h: s, clip: "none" });
  };
  const duplicate = (it: DielineItem) => addItem({ ...it, id: newItemId(), x: it.x + 5, y: it.y + 5 });
  const reorder = (id: string, dir: 1 | -1) => update((p) => {
    const i = p.items.findIndex((it) => it.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= p.items.length) return p;
    const items = [...p.items];
    [items[i], items[j]] = [items[j], items[i]];
    return { ...p, items };
  });
  const setFace = (face: DielineFace) => { update((p) => ({ ...p, activeFace: face }), false); setSelectedId(null); };
  const setKeyline = (keyline: Keyline) => update((p) => ({ ...p, keyline }));
  const resetKeyline = () => setKeyline(sanitizeKeyline(defaults?.[dieline.pouchType], DEFAULT_KEYLINES[dieline.pouchType]));
  const setPouchSize = (key: "width" | "height" | "depth", value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    setSizeScale(sizeScaleFromPouch({ ...size, [key]: value }));
  };
  const items = dieline.items.filter((it) => it.face === dieline.activeFace);

  return (
    <div className="flex-1 flex min-w-0 bg-slate-100" data-testid="dieline-workspace">
      {/* Left rail */}
      <div className="w-16 bg-white border-r border-slate-200 flex flex-col items-center py-3 gap-1 shrink-0">
        {[
          { id: "uploads", label: "Uploads", icon: ImagePlus },
          { id: "text", label: "Text", icon: Type },
          { id: "shapes", label: "Shapes", icon: Square },
          { id: "keyline", label: "Keyline", icon: Ruler },
        ].map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" onClick={() => setRail(id as any)} aria-pressed={rail === id} className={`w-14 py-2 rounded-lg flex flex-col items-center gap-1 text-[9px] font-bold ${rail === id ? "bg-brand-50 text-brand-700" : "text-slate-500 hover:bg-slate-50"}`}>
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {/* Rail content */}
      <div className="w-60 bg-white border-r border-slate-200 flex flex-col shrink-0 overflow-y-auto">
        {rail === "uploads" && (
          <div className="p-3 space-y-3">
            <button type="button" onClick={() => uploadInput.current?.click()} className="w-full py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-bold flex items-center justify-center gap-1.5"><ImagePlus className="w-3.5 h-3.5" /> Upload JPG, PNG, SVG</button>
            <input ref={uploadInput} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" multiple className="hidden" aria-label="Upload artwork" onChange={onUpload} />
            <p className="text-[9px] text-slate-400">New uploads fill the front panel without stretching. Click an upload to place it again.</p>
            <div className="grid grid-cols-2 gap-2">
              {uploads.map((up, i) => (
                <div key={i} className="group relative rounded-lg border border-slate-200 overflow-hidden bg-slate-50 aspect-square">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={up.src} alt={up.name} className="w-full h-full object-contain" />
                  <div className="absolute inset-0 bg-slate-900/70 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center gap-1 text-[9px] font-bold">
                    <button type="button" className="bg-white text-slate-800 px-2 py-0.5 rounded" onClick={() => placeImage(up, "front", "fill")}>Fill front</button>
                    <button type="button" className="bg-white text-slate-800 px-2 py-0.5 rounded" onClick={() => placeImage(up, "back", "fill")}>Fill back</button>
                    <button type="button" className="bg-white text-slate-800 px-2 py-0.5 rounded" onClick={() => placeImage(up, "front", "sheet")}>Whole sheet</button>
                  </div>
                </div>
              ))}
            </div>
            {uploads.length === 0 && <p className="text-[10px] text-slate-400 italic">No uploads yet in this session.</p>}
          </div>
        )}
        {rail === "text" && (
          <div className="p-3 space-y-2">
            <button type="button" onClick={addText} className="w-full py-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-[11px] font-bold flex items-center justify-center gap-1.5"><Type className="w-3.5 h-3.5" /> Add text</button>
            <p className="text-[9px] text-slate-400">Text is placed inside the front safe area. Edit it in the panel on the right.</p>
          </div>
        )}
        {rail === "shapes" && (
          <div className="p-3 space-y-2">
            <button type="button" onClick={() => addShape("rect")} className="w-full py-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-[11px] font-bold flex items-center justify-center gap-1.5"><Square className="w-3.5 h-3.5" /> Rectangle</button>
            <button type="button" onClick={() => addShape("ellipse")} className="w-full py-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-[11px] font-bold flex items-center justify-center gap-1.5"><Circle className="w-3.5 h-3.5" /> Ellipse</button>
          </div>
        )}
        {rail === "keyline" && (
          <div className="p-3 space-y-3">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Pouch size</span>
              <span className="text-[9px] text-slate-400 block mb-1.5">{POUCH_TYPE_LABELS[dieline.pouchType]} · same as the Size tab</span>
              <div className="grid grid-cols-3 gap-1.5">
                {([["width", "Width"], ["height", "Height"], ["depth", "Depth"]] as const).map(([key, label]) => (
                  <label key={key} className="block">
                    <span className="text-[8px] font-bold text-slate-500 uppercase">{label}</span>
                    <input type="number" min={10} max={600} step={1} value={size[key]} aria-label={`Pouch ${label} mm`} onChange={(e) => setPouchSize(key, Number(e.target.value))} className="w-full px-1.5 py-1 text-[10px] border border-slate-200 rounded text-right" />
                  </label>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Keyline (mm)</span>
              <button type="button" onClick={resetKeyline} className="text-[9px] font-bold text-brand-600 hover:text-brand-700">Reset to default</button>
            </div>
            <KeylineFields pouchType={dieline.pouchType} keyline={dieline.keyline} onChange={setKeyline} />
          </div>
        )}
      </div>

      {/* Stage */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-11 bg-white border-b border-slate-200 flex items-center gap-1 px-2 shrink-0">
          <button type="button" onClick={() => setToggle("editorView", "3d")} className="px-2.5 py-1.5 rounded-lg bg-slate-900 text-white text-[10px] font-bold flex items-center gap-1.5"><ArrowLeft className="w-3 h-3" /> 3D View</button>
          <span className="mx-2 h-5 w-px bg-slate-200" />
          <button type="button" aria-label="Select tool" aria-pressed={tool === "select"} onClick={() => setTool("select")} className={`p-1.5 rounded ${tool === "select" ? "bg-brand-50 text-brand-700" : "text-slate-500 hover:bg-slate-50"}`}><MousePointer2 className="w-4 h-4" /></button>
          <button type="button" aria-label="Hand tool" aria-pressed={tool === "hand"} onClick={() => setTool("hand")} className={`p-1.5 rounded ${tool === "hand" ? "bg-brand-50 text-brand-700" : "text-slate-500 hover:bg-slate-50"}`}><Hand className="w-4 h-4" /></button>
          <span className="mx-2 h-5 w-px bg-slate-200" />
          <button type="button" aria-label="Undo" onClick={undo} disabled={history.current.past.length < 2} className="p-1.5 rounded text-slate-500 hover:bg-slate-50 disabled:opacity-30"><Undo2 className="w-4 h-4" /></button>
          <button type="button" aria-label="Redo" onClick={redo} disabled={history.current.future.length === 0} className="p-1.5 rounded text-slate-500 hover:bg-slate-50 disabled:opacity-30"><Redo2 className="w-4 h-4" /></button>
          <span className="mx-2 h-5 w-px bg-slate-200" />
          <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.15, z / 1.2))} className="p-1.5 rounded text-slate-500 hover:bg-slate-50"><Minus className="w-4 h-4" /></button>
          <span className="text-[10px] font-mono text-slate-600 w-12 text-center" data-testid="dieline-zoom">{Math.round(zoom * 100 / 3)}%</span>
          <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(12, z * 1.2))} className="p-1.5 rounded text-slate-500 hover:bg-slate-50"><Plus className="w-4 h-4" /></button>
          <button type="button" aria-label="Fit to view" onClick={() => (window as any).__dielineFit?.()} className="p-1.5 rounded text-slate-500 hover:bg-slate-50"><Maximize2 className="w-4 h-4" /></button>
          <span className="flex-1" />
          <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200" role="tablist" aria-label="Print side">
            {(["outside", "inside"] as DielineFace[]).map((face) => (
              <button key={face} type="button" role="tab" aria-selected={dieline.activeFace === face} onClick={() => setFace(face)} className={`px-3 py-1 rounded-md text-[10px] font-bold capitalize ${dieline.activeFace === face ? "bg-white text-brand-700 shadow-sm" : "text-slate-500"}`}>{face}</button>
            ))}
          </div>
          <span className="text-[9px] text-slate-400 ml-2 hidden xl:inline">{layout.width.toFixed(1)} × {layout.height.toFixed(1)} mm · {items.length} item(s)</span>
        </div>
        <div className="flex-1 relative overflow-hidden" style={{ backgroundImage: "radial-gradient(#cbd5e1 0.6px, transparent 0.6px)", backgroundSize: "16px 16px" }}>
          <DielineStage state={dieline} size={size} selectedId={selectedId} tool={tool} onSelect={setSelectedId} onChangeItem={(id, patch) => patchItem(id, patch, false)} onCommit={commit} zoom={zoom} onZoom={setZoom} />
        </div>
      </div>

      {/* Properties */}
      <div className="w-64 bg-white border-l border-slate-200 overflow-y-auto shrink-0">
        <div className="p-3 border-b border-slate-100">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1.5">Package colour</span>
          <div className="flex flex-wrap gap-1.5">
            {PACKAGE_COLORS.map((c) => (
              <button key={c} type="button" aria-label={`Package colour ${c}`} aria-pressed={materials.Front?.color?.toLowerCase() === c} onClick={() => setAllMaterialColors(c)} className={`w-6 h-6 rounded-full border-2 ${materials.Front?.color?.toLowerCase() === c ? "border-brand-600" : "border-slate-200"}`} style={{ background: c }} />
            ))}
            <label className="w-6 h-6 rounded-full border-2 border-dashed border-slate-300 flex items-center justify-center text-slate-400 cursor-pointer" aria-label="Custom package colour">
              <Plus className="w-3 h-3" />
              <input type="color" className="sr-only" onChange={(e) => setAllMaterialColors(e.target.value)} />
            </label>
          </div>
          <p className="text-[8px] text-slate-400 mt-1">Colour of unprinted film. Artwork prints on top.</p>
        </div>

        {selected ? (
          <div className="p-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 capitalize">{selected.type === "image" ? "Image" : selected.type}</span>
              <div className="flex gap-0.5">
                <button type="button" aria-label="Duplicate" onClick={() => duplicate(selected)} className="p-1 rounded text-slate-500 hover:bg-slate-50"><Copy className="w-3.5 h-3.5" /></button>
                <button type="button" aria-label={selected.locked ? "Unlock" : "Lock"} onClick={() => patchItem(selected.id, { locked: !selected.locked })} className="p-1 rounded text-slate-500 hover:bg-slate-50">{selected.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}</button>
                <button type="button" aria-label="Delete" onClick={() => removeItem(selected.id)} className="p-1 rounded text-red-500 hover:bg-red-50"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>

            {selected.type === "image" && (
              <div>
                <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider block mb-1">Fit to panel (no stretching)</span>
                <div className="grid grid-cols-2 gap-1">
                  {(["front", "back"] as DielinePanel[]).map((panel) => (
                    <div key={panel} className="contents">
                      <button type="button" onClick={() => { const b = fitRect(selected.naturalW, selected.naturalH, faceOf(layout, panel).outer, "fill"); patchItem(selected.id, { ...b, rotation: 0, panel, clip: "panel" }); }} className="px-2 py-1.5 rounded border border-slate-200 hover:bg-slate-50 text-[10px] font-bold capitalize">Fill {panel}</button>
                      <button type="button" onClick={() => { const b = fitRect(selected.naturalW, selected.naturalH, faceOf(layout, panel).cut, "fit"); patchItem(selected.id, { ...b, rotation: 0, panel, clip: "panel" }); }} className="px-2 py-1.5 rounded border border-slate-200 hover:bg-slate-50 text-[10px] font-bold capitalize">Fit {panel}</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => { const b = fitRect(selected.naturalW, selected.naturalH, { x: 0, y: 0, w: layout.width, h: layout.height }, "fill"); patchItem(selected.id, { ...b, rotation: 0, clip: "none" }); }} className="col-span-2 px-2 py-1.5 rounded border border-slate-200 hover:bg-slate-50 text-[10px] font-bold">Fill whole sheet (across panels)</button>
                </div>
              </div>
            )}

            <div>
              <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider block mb-1">Overlap</span>
              <label className="flex items-start gap-2 text-[10px] text-slate-600 cursor-pointer">
                <input type="checkbox" checked={selected.clip === "none"} onChange={(e) => patchItem(selected.id, { clip: e.target.checked ? "none" : "panel" })} className="mt-0.5 accent-brand-600" />
                <span><b>Run across panels</b><br /><span className="text-slate-400">Off: cropped to the {selected.panel} panel and its bleed.</span></span>
              </label>
              {selected.clip === "panel" && (
                <div className="flex gap-1 mt-1.5">
                  {(["front", "back"] as DielinePanel[]).map((panel) => (
                    <button key={panel} type="button" aria-pressed={selected.panel === panel} onClick={() => patchItem(selected.id, { panel })} className={`px-2 py-1 rounded text-[9px] font-bold border capitalize ${selected.panel === panel ? "bg-brand-600 text-white border-brand-600" : "border-slate-200 text-slate-600"}`}>{panel}</button>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              {([["x", "X (centre)"], ["y", "Y (centre)"], ["w", "Width"], ["h", "Height"]] as const).map(([key, label]) => (
                <label key={key} className="block">
                  <span className="text-[8px] font-bold text-slate-500 uppercase">{label} mm</span>
                  <input type="number" step={0.5} value={Math.round(selected[key] * 10) / 10} aria-label={`${label} mm`} disabled={selected.locked} onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    if ((key === "w" || key === "h") && v <= 0) return;
                    const patch: Partial<DielineItem> = { [key]: v } as any;
                    if (selected.type === "image" && (key === "w" || key === "h")) {
                      const ratio = selected.naturalW / selected.naturalH;
                      if (key === "w") (patch as any).h = v / ratio; else (patch as any).w = v * ratio;
                    }
                    patchItem(selected.id, patch);
                  }} className="w-full px-1.5 py-1 text-[10px] border border-slate-200 rounded text-right disabled:bg-slate-50" />
                </label>
              ))}
            </div>

            <div className="flex items-center gap-1">
              <label className="flex-1 block">
                <span className="text-[8px] font-bold text-slate-500 uppercase">Rotate °</span>
                <input type="number" step={1} value={Math.round(selected.rotation)} aria-label="Rotation degrees" onChange={(e) => patchItem(selected.id, { rotation: ((Number(e.target.value) % 360) + 360) % 360 })} className="w-full px-1.5 py-1 text-[10px] border border-slate-200 rounded text-right" />
              </label>
              <button type="button" aria-label="Rotate 90 degrees" onClick={() => patchItem(selected.id, { rotation: (selected.rotation + 90) % 360 })} className="mt-3 p-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50"><RotateCw className="w-3.5 h-3.5" /></button>
              <button type="button" aria-label="Flip horizontally" onClick={() => patchItem(selected.id, { flipX: !selected.flipX })} className="mt-3 p-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50"><FlipHorizontal2 className="w-3.5 h-3.5" /></button>
              <button type="button" aria-label="Flip vertically" onClick={() => patchItem(selected.id, { flipY: !selected.flipY })} className="mt-3 p-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50"><FlipVertical2 className="w-3.5 h-3.5" /></button>
            </div>

            <label className="block">
              <span className="flex justify-between text-[8px] font-bold text-slate-500 uppercase"><span>Opacity</span><span>{Math.round(selected.opacity * 100)}%</span></span>
              <input type="range" min={5} max={100} value={Math.round(selected.opacity * 100)} aria-label="Opacity" onChange={(e) => patchItem(selected.id, { opacity: Number(e.target.value) / 100 }, false)} onPointerUp={commit} className="w-full accent-brand-600" />
            </label>

            {selected.type === "text" && (
              <div className="space-y-1.5">
                <textarea value={selected.text} aria-label="Text content" onChange={(e) => patchItem(selected.id, { text: e.target.value })} rows={3} className="w-full px-2 py-1 text-[11px] border border-slate-200 rounded" />
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="block"><span className="text-[8px] font-bold text-slate-500 uppercase">Size mm</span><input type="number" min={1} step={0.5} value={selected.fontSizeMm} aria-label="Font size mm" onChange={(e) => patchItem(selected.id, { fontSizeMm: Math.max(1, Number(e.target.value)) })} className="w-full px-1.5 py-1 text-[10px] border border-slate-200 rounded text-right" /></label>
                  <label className="block"><span className="text-[8px] font-bold text-slate-500 uppercase">Colour</span><input type="color" value={selected.color} aria-label="Text colour" onChange={(e) => patchItem(selected.id, { color: e.target.value })} className="w-full h-6 border border-slate-200 rounded" /></label>
                </div>
                <div className="flex gap-1">
                  <button type="button" aria-pressed={selected.bold} onClick={() => patchItem(selected.id, { bold: !selected.bold })} className={`px-2 py-1 rounded text-[10px] font-black border ${selected.bold ? "bg-slate-900 text-white border-slate-900" : "border-slate-200"}`}>B</button>
                  {(["left", "center", "right"] as const).map((a) => (
                    <button key={a} type="button" aria-pressed={selected.align === a} onClick={() => patchItem(selected.id, { align: a })} className={`px-2 py-1 rounded text-[9px] font-bold border capitalize ${selected.align === a ? "bg-slate-900 text-white border-slate-900" : "border-slate-200"}`}>{a}</button>
                  ))}
                </div>
                <select value={selected.fontFamily} aria-label="Font" onChange={(e) => patchItem(selected.id, { fontFamily: e.target.value })} className="w-full px-1.5 py-1 text-[10px] border border-slate-200 rounded bg-white">
                  <option value="Arial, Helvetica, sans-serif">Arial</option>
                  <option value="Georgia, serif">Georgia</option>
                  <option value="'Trebuchet MS', sans-serif">Trebuchet</option>
                  <option value="Impact, sans-serif">Impact</option>
                  <option value="'Courier New', monospace">Courier</option>
                </select>
              </div>
            )}
            {(selected.type === "rect" || selected.type === "ellipse") && (
              <div className="grid grid-cols-3 gap-1.5">
                <label className="block"><span className="text-[8px] font-bold text-slate-500 uppercase">Fill</span><input type="color" value={selected.fill} aria-label="Fill colour" onChange={(e) => patchItem(selected.id, { fill: e.target.value })} className="w-full h-6 border border-slate-200 rounded" /></label>
                <label className="block"><span className="text-[8px] font-bold text-slate-500 uppercase">Border</span><input type="color" value={selected.stroke} aria-label="Border colour" onChange={(e) => patchItem(selected.id, { stroke: e.target.value })} className="w-full h-6 border border-slate-200 rounded" /></label>
                <label className="block"><span className="text-[8px] font-bold text-slate-500 uppercase">Border mm</span><input type="number" min={0} step={0.5} value={selected.strokeMm} aria-label="Border width mm" onChange={(e) => patchItem(selected.id, { strokeMm: Math.max(0, Number(e.target.value)) })} className="w-full px-1.5 py-1 text-[10px] border border-slate-200 rounded text-right" /></label>
              </div>
            )}

            <div>
              <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider block mb-1">Layer</span>
              <div className="flex gap-1">
                <button type="button" onClick={() => reorder(selected.id, 1)} className="flex-1 px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 text-[10px] font-bold flex items-center justify-center gap-1"><ChevronUp className="w-3 h-3" /> Forward</button>
                <button type="button" onClick={() => reorder(selected.id, -1)} className="flex-1 px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 text-[10px] font-bold flex items-center justify-center gap-1"><ChevronDown className="w-3 h-3" /> Back</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-3 space-y-3">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1"><Layers className="w-3 h-3" /> Layers ({items.length})</span>
              <p className="text-[9px] text-slate-400 mt-1">Click an item on the dieline or in this list. Drag to move, corners to resize, the top handle to rotate. Arrow keys nudge 1 mm.</p>
            </div>
            <ul className="space-y-1">
              {[...items].reverse().map((it) => (
                <li key={it.id}>
                  <button type="button" onClick={() => setSelectedId(it.id)} className="w-full flex items-center gap-2 p-1.5 rounded border border-slate-100 hover:bg-slate-50 text-left">
                    {it.type === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={it.src} alt="" className="w-7 h-7 object-cover rounded" />
                    ) : (
                      <span className="w-7 h-7 rounded bg-slate-100 flex items-center justify-center text-slate-500">{it.type === "text" ? <Type className="w-3.5 h-3.5" /> : <Box className="w-3.5 h-3.5" />}</span>
                    )}
                    <span className="flex-1 min-w-0">
                      <span className="block text-[10px] font-bold text-slate-700 truncate">{it.type === "image" ? it.name || "Image" : it.type === "text" ? it.text.slice(0, 20) || "Text" : it.type}</span>
                      <span className="block text-[8px] text-slate-400">{it.clip === "panel" ? `${it.panel} panel` : "across panels"} · {Math.round(it.w)}×{Math.round(it.h)} mm</span>
                    </span>
                    {it.locked && <Lock className="w-3 h-3 text-slate-400" />}
                  </button>
                </li>
              ))}
              {items.length === 0 && <li className="text-[10px] text-slate-400 italic">Nothing on the {dieline.activeFace} yet. Upload an image to start.</li>}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
