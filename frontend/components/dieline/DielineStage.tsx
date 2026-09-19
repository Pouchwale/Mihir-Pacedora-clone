"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DielineItem, DielineState } from "@/lib/dieline/types";
import { computeSheetLayout, type PouchSizeMm, type Rect, type SheetLayout } from "@/lib/dieline/layout";

export type StageTool = "select" | "hand";

interface Props {
  state: DielineState;
  size: PouchSizeMm;
  selectedId: string | null;
  tool: StageTool;
  onSelect: (id: string | null) => void;
  /** Live change while dragging (not recorded in history) */
  onChangeItem: (id: string, patch: Partial<DielineItem>) => void;
  /** Called when a drag / resize / rotate ends, so the workspace records history */
  onCommit: () => void;
  zoom: number;
  onZoom: (zoom: number) => void;
}

const HATCH_ID = "dieline-seal-hatch";

/** The flat sheet: keyline zones, mm labels and the artwork items, with drag/resize/rotate handles. */
export function DielineStage({ state, size, selectedId, tool, onSelect, onChangeItem, onCommit, zoom, onZoom }: Props) {
  const layout = useMemo(() => computeSheetLayout(state.pouchType, size, state.keyline), [state.pouchType, size, state.keyline]);
  const svgRef = useRef<SVGSVGElement>(null);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [viewport, setViewport] = useState({ w: 800, h: 600 });
  const fittedRef = useRef(false);

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setViewport({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Fit the sheet into the view the first time it has a size
  const fit = useCallback(() => {
    const margin = 70;
    const z = Math.max(0.2, Math.min((viewport.w - margin * 2) / layout.width, (viewport.h - margin * 2) / layout.height));
    onZoom(z);
    setPan({ x: (viewport.w - layout.width * z) / 2, y: (viewport.h - layout.height * z) / 2 });
  }, [viewport, layout.width, layout.height, onZoom]);
  useEffect(() => {
    if (!fittedRef.current && viewport.w > 100) { fittedRef.current = true; fit(); }
  }, [viewport, fit]);
  useEffect(() => { (window as any).__dielineFit = fit; return () => { delete (window as any).__dielineFit; }; }, [fit]);

  const toSheet = useCallback((clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left - pan.x) / zoom, y: (clientY - r.top - pan.y) / zoom };
  }, [pan, zoom]);

  // ---- wheel: zoom around the cursor; shift+wheel pans
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.shiftKey) { setPan((p) => ({ x: p.x - e.deltaY, y: p.y })); return; }
    const r = svgRef.current!.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.max(0.15, Math.min(12, zoom * factor));
    setPan({ x: cx - ((cx - pan.x) / zoom) * next, y: cy - ((cy - pan.y) / zoom) * next });
    onZoom(next);
  };

  // ---- pointer interactions
  type Drag =
    | { kind: "pan"; startX: number; startY: number; panX: number; panY: number }
    | { kind: "move"; id: string; startX: number; startY: number; itemX: number; itemY: number }
    | { kind: "resize"; id: string; corner: number; keepAspect: boolean }
    | { kind: "rotate"; id: string };
  const dragRef = useRef<Drag | null>(null);

  const startPan = (e: React.PointerEvent) => {
    dragRef.current = { kind: "pan", startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button === 1 || tool === "hand" || e.altKey) { startPan(e); return; }
    if (e.button === 0) { onSelect(null); startPan(e); }
  };
  const onItemDown = (e: React.PointerEvent, item: DielineItem) => {
    if (tool === "hand" || e.button === 1) return;
    e.stopPropagation();
    onSelect(item.id);
    if (item.locked) return;
    dragRef.current = { kind: "move", id: item.id, startX: e.clientX, startY: e.clientY, itemX: item.x, itemY: item.y };
  };
  const onHandleDown = (e: React.PointerEvent, item: DielineItem, corner: number) => {
    e.stopPropagation();
    dragRef.current = { kind: "resize", id: item.id, corner, keepAspect: item.type === "image" ? !e.shiftKey : e.shiftKey };
  };
  const onRotateDown = (e: React.PointerEvent, item: DielineItem) => {
    e.stopPropagation();
    dragRef.current = { kind: "rotate", id: item.id };
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === "pan") { setPan({ x: d.panX + e.clientX - d.startX, y: d.panY + e.clientY - d.startY }); return; }
      const item = state.items.find((it) => it.id === d.id);
      if (!item) return;
      if (d.kind === "move") {
        let x = d.itemX + (e.clientX - d.startX) / zoom;
        let y = d.itemY + (e.clientY - d.startY) / zoom;
        if (!e.shiftKey) ({ x, y } = snap(item, x, y, layout));
        onChangeItem(d.id, { x, y });
      } else if (d.kind === "resize") {
        const p = toSheet(e.clientX, e.clientY);
        // Pointer position in the item's own (rotated) frame
        const a = (-item.rotation * Math.PI) / 180;
        const dx = p.x - item.x, dy = p.y - item.y;
        const lx = dx * Math.cos(a) - dy * Math.sin(a);
        const ly = dx * Math.sin(a) + dy * Math.cos(a);
        let w = Math.max(2, Math.abs(lx) * 2);
        let h = Math.max(2, Math.abs(ly) * 2);
        if (d.keepAspect) {
          const ratio = item.w / item.h;
          if (w / h > ratio) h = w / ratio; else w = h * ratio;
        }
        const patch: Partial<DielineItem> = { w, h };
        if (item.type === "text") (patch as any).fontSizeMm = Math.max(1, item.fontSizeMm * (h / item.h));
        onChangeItem(d.id, patch);
      } else if (d.kind === "rotate") {
        const p = toSheet(e.clientX, e.clientY);
        let deg = (Math.atan2(p.y - item.y, p.x - item.x) * 180) / Math.PI + 90;
        if (!e.shiftKey) deg = Math.round(deg / 5) * 5; else deg = Math.round(deg);
        onChangeItem(d.id, { rotation: ((deg % 360) + 360) % 360 });
      }
    };
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d && d.kind !== "pan") onCommit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [state.items, zoom, toSheet, onChangeItem, onCommit, layout]);

  const items = state.items.filter((it) => it.face === state.activeFace);
  const selected = items.find((it) => it.id === selectedId) || null;
  const labelPx = 11 / zoom; // keeps labels the same size on screen at any zoom
  const stroke = 1 / zoom;

  return (
    <svg
      ref={svgRef}
      className={`w-full h-full select-none touch-none ${tool === "hand" ? "cursor-grab" : "cursor-default"}`}
      onWheel={onWheel}
      onPointerDown={onBackgroundDown}
      role="img"
      aria-label={`Dieline ${layout.width.toFixed(1)} by ${layout.height.toFixed(1)} millimetres`}
    >
      <defs>
        <pattern id={HATCH_ID} width={3} height={3} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={3} stroke="#94a3b8" strokeWidth={0.6} />
        </pattern>
        {layout.faces.map((f) => (
          <clipPath key={f.panel} id={`clip-${f.panel}`}>
            <rect x={f.outer.x} y={f.outer.y} width={f.outer.w} height={f.outer.h} />
          </clipPath>
        ))}
      </defs>
      <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {/* Sheet (bleed area is the light red border, film colour inside the cut line) */}
        <rect x={0} y={0} width={layout.width} height={layout.height} fill="#fee2e2" />
        {layout.faces.map((f) => (
          <rect key={f.panel} x={f.cut.x} y={f.cut.y} width={f.cut.w} height={f.cut.h} fill="#ffffff" />
        ))}

        {/* Artwork */}
        {items.map((it) => (
          <g key={it.id} clipPath={it.clip === "panel" ? `url(#clip-${it.panel})` : undefined}>
            <g
              transform={`translate(${it.x} ${it.y}) rotate(${it.rotation}) scale(${it.flipX ? -1 : 1} ${it.flipY ? -1 : 1})`}
              opacity={it.opacity}
              onPointerDown={(e) => onItemDown(e, it)}
              style={{ cursor: it.locked ? "not-allowed" : tool === "hand" ? "grab" : "move" }}
            >
              <ItemShape item={it} />
            </g>
          </g>
        ))}

        {/* Keyline overlay: never covers pointer events on artwork */}
        <g pointerEvents="none">
          {layout.faces.map((f) => (
            <g key={f.panel}>
              {f.zones.filter((z) => z.kind === "seal").map((z, i) => (
                <rect key={`seal${i}`} x={z.x} y={z.y} width={z.w} height={z.h} fill={`url(#${HATCH_ID})`} opacity={0.45} />
              ))}
              {f.zones.filter((z) => z.kind === "band").map((z, i) => (
                <g key={`band${i}`}>
                  <rect x={z.x} y={z.y} width={z.w} height={z.h} fill="#e2e8f0" opacity={0.35} />
                  <text x={z.x + f.cut.w / 2} y={z.y + z.h / 2} fontSize={Math.min(labelPx, z.h * 0.7)} fill="#475569" textAnchor="middle" dominantBaseline="middle" fontWeight={600}>{z.label}</text>
                </g>
              ))}
              {f.zones.filter((z) => z.kind === "gusset").map((z, i) => (
                <g key={`gusset${i}`}>
                  <rect x={z.x} y={z.y} width={z.w} height={z.h} fill="#fef3c7" opacity={0.35} />
                  {/* Gusset: the fold is a curve when the pouch stands (like the real bottom) */}
                  <path d={`M ${z.x} ${z.y} Q ${z.x + z.w / 2} ${z.y + z.h * 0.9} ${z.x + z.w} ${z.y}`} fill="none" stroke="#64748b" strokeWidth={stroke} strokeDasharray={`${3 / zoom} ${2 / zoom}`} />
                  <text x={z.x + z.w / 2} y={z.y + z.h / 2} fontSize={labelPx} fill="#92400e" textAnchor="middle" dominantBaseline="middle" fontWeight={600}>{z.label}</text>
                </g>
              ))}
              {f.folds.map((fold, i) => (
                <line key={`fold${i}`} x1={f.cut.x} y1={fold.y} x2={f.cut.x + f.cut.w} y2={fold.y} stroke="#64748b" strokeWidth={stroke} strokeDasharray={`${3 / zoom} ${2 / zoom}`} />
              ))}
              {/* Safe area */}
              <rect x={f.safe.x} y={f.safe.y} width={f.safe.w} height={f.safe.h} fill="none" stroke="#16a34a" strokeWidth={stroke} strokeDasharray={`${2 / zoom} ${2 / zoom}`} opacity={0.7} />
              {/* Cut line and bleed edge */}
              <rect x={f.cut.x} y={f.cut.y} width={f.cut.w} height={f.cut.h} fill="none" stroke="#0f172a" strokeWidth={1.5 * stroke} />
              <rect x={f.outer.x} y={f.outer.y} width={f.outer.w} height={f.outer.h} fill="none" stroke="#ef4444" strokeWidth={stroke} strokeDasharray={`${2 / zoom} ${2 / zoom}`} />
              <text x={f.cut.x + f.cut.w / 2} y={f.outer.y - 14 / zoom} fontSize={labelPx * 1.1} fill="#0f172a" textAnchor="middle" fontWeight={700}>{f.label.toUpperCase()}</text>
              {/* Side seal labels */}
              <text x={f.cut.x + state.keyline.sideSealMm / 2} y={f.cut.y + f.cut.h / 2} fontSize={Math.min(labelPx, state.keyline.sideSealMm * 0.6)} fill="#475569" textAnchor="middle" dominantBaseline="middle" transform={`rotate(-90 ${f.cut.x + state.keyline.sideSealMm / 2} ${f.cut.y + f.cut.h / 2})`} fontWeight={600}>Side seal {state.keyline.sideSealMm} mm</text>
            </g>
          ))}
          {/* Dimensions */}
          <Dimension x1={layout.faces[0].cut.x} x2={layout.faces[0].cut.x + layout.faces[0].cut.w} y={layout.height + 10 / zoom} label={`${fmt(size.width)} mm`} zoom={zoom} />
          <Dimension x1={layout.faces[1].cut.x} x2={layout.faces[1].cut.x + layout.faces[1].cut.w} y={layout.height + 10 / zoom} label={`${fmt(size.width)} mm`} zoom={zoom} />
          <Dimension x1={0} x2={layout.width} y={layout.height + 26 / zoom} label={`Sheet ${fmt(layout.width)} mm`} zoom={zoom} />
          <VDimension y1={layout.faces[0].cut.y} y2={layout.faces[0].cut.y + layout.faces[0].cut.h} x={-10 / zoom} label={`${fmt(layout.faceHeight)} mm`} zoom={zoom} />
          <VDimension y1={0} y2={layout.height} x={layout.width + 10 / zoom} label={`${fmt(layout.height)} mm`} zoom={zoom} />
          <text x={layout.faces[0].cut.x + layout.faces[0].cut.w / 2} y={-18 / zoom - labelPx * 1.5} fontSize={labelPx} fill="#64748b" textAnchor="middle">Bleed {state.keyline.bleedMm} mm · Print area {fmt(layout.faces[0].print.w)} × {fmt(layout.faces[0].print.h)} mm</text>
        </g>

        {/* Selection handles */}
        {selected && !selected.locked && (
          <g transform={`translate(${selected.x} ${selected.y}) rotate(${selected.rotation})`}>
            <rect x={-selected.w / 2} y={-selected.h / 2} width={selected.w} height={selected.h} fill="none" stroke="#2563eb" strokeWidth={1.5 * stroke} pointerEvents="none" />
            {[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy], i) => (
              <rect
                key={i}
                x={(sx * selected.w) / 2 - 5 / zoom}
                y={(sy * selected.h) / 2 - 5 / zoom}
                width={10 / zoom}
                height={10 / zoom}
                fill="#ffffff"
                stroke="#2563eb"
                strokeWidth={1.5 * stroke}
                style={{ cursor: i % 2 === 0 ? "nwse-resize" : "nesw-resize" }}
                onPointerDown={(e) => onHandleDown(e, selected, i)}
              />
            ))}
            <line x1={0} y1={-selected.h / 2} x2={0} y2={-selected.h / 2 - 22 / zoom} stroke="#2563eb" strokeWidth={stroke} pointerEvents="none" />
            <circle cx={0} cy={-selected.h / 2 - 22 / zoom} r={6 / zoom} fill="#ffffff" stroke="#2563eb" strokeWidth={1.5 * stroke} style={{ cursor: "grab" }} onPointerDown={(e) => onRotateDown(e, selected)} />
          </g>
        )}
        {selected && selected.locked && (
          <rect x={selected.x - selected.w / 2} y={selected.y - selected.h / 2} width={selected.w} height={selected.h} fill="none" stroke="#94a3b8" strokeWidth={1.5 * stroke} strokeDasharray={`${3 / zoom} ${3 / zoom}`} transform={`rotate(${selected.rotation} ${selected.x} ${selected.y})`} pointerEvents="none" />
        )}
      </g>
    </svg>
  );
}

function ItemShape({ item }: { item: DielineItem }) {
  const w = item.w, h = item.h;
  if (item.type === "image") {
    return <image href={item.src} x={-w / 2} y={-h / 2} width={w} height={h} preserveAspectRatio="none" />;
  }
  if (item.type === "rect") {
    return <rect x={-w / 2} y={-h / 2} width={w} height={h} fill={item.fill} stroke={item.strokeMm > 0 ? item.stroke : "none"} strokeWidth={item.strokeMm} />;
  }
  if (item.type === "ellipse") {
    return <ellipse cx={0} cy={0} rx={w / 2} ry={h / 2} fill={item.fill} stroke={item.strokeMm > 0 ? item.stroke : "none"} strokeWidth={item.strokeMm} />;
  }
  if (item.type !== "text") return null;
  const lines = item.text.split("\n");
  const lineH = item.fontSizeMm * 1.2;
  const startY = -((lines.length - 1) * lineH) / 2;
  const tx = item.align === "left" ? -w / 2 : item.align === "right" ? w / 2 : 0;
  return (
    <g>
      {/* transparent hit area so empty text can still be grabbed */}
      <rect x={-w / 2} y={-h / 2} width={w} height={h} fill="transparent" />
      <text fontSize={item.fontSizeMm} fill={item.color} fontWeight={item.bold ? 700 : 400} fontFamily={item.fontFamily} textAnchor={item.align === "left" ? "start" : item.align === "right" ? "end" : "middle"} dominantBaseline="middle">
        {lines.map((line, i) => <tspan key={i} x={tx} y={startY + i * lineH}>{line}</tspan>)}
      </text>
    </g>
  );
}

function Dimension({ x1, x2, y, label, zoom }: { x1: number; x2: number; y: number; label: string; zoom: number }) {
  const s = 1 / zoom;
  return (
    <g>
      <line x1={x1} y1={y} x2={x2} y2={y} stroke="#2563eb" strokeWidth={s} />
      <line x1={x1} y1={y - 3 * s} x2={x1} y2={y + 3 * s} stroke="#2563eb" strokeWidth={s} />
      <line x1={x2} y1={y - 3 * s} x2={x2} y2={y + 3 * s} stroke="#2563eb" strokeWidth={s} />
      <text x={(x1 + x2) / 2} y={y + 12 * s} fontSize={11 * s} fill="#2563eb" textAnchor="middle" fontWeight={600}>{label}</text>
    </g>
  );
}

function VDimension({ y1, y2, x, label, zoom }: { y1: number; y2: number; x: number; label: string; zoom: number }) {
  const s = 1 / zoom;
  return (
    <g>
      <line x1={x} y1={y1} x2={x} y2={y2} stroke="#2563eb" strokeWidth={s} />
      <line x1={x - 3 * s} y1={y1} x2={x + 3 * s} y2={y1} stroke="#2563eb" strokeWidth={s} />
      <line x1={x - 3 * s} y1={y2} x2={x + 3 * s} y2={y2} stroke="#2563eb" strokeWidth={s} />
      <text x={x} y={(y1 + y2) / 2} fontSize={11 * s} fill="#2563eb" textAnchor="middle" fontWeight={600} transform={`rotate(-90 ${x} ${(y1 + y2) / 2})`} dy={-4 * s}>{label}</text>
    </g>
  );
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

/** Snap the item centre / edges to the panel edges, print area and centre lines (within ~1.5 mm). */
function snap(item: DielineItem, x: number, y: number, layout: SheetLayout) {
  const tol = 1.5;
  const xs: number[] = [], ys: number[] = [];
  layout.faces.forEach((f) => {
    [f.outer, f.cut, f.print].forEach((r: Rect) => {
      xs.push(r.x, r.x + r.w, r.x + r.w / 2);
      ys.push(r.y, r.y + r.h, r.y + r.h / 2);
    });
  });
  const half = { w: item.w / 2, h: item.h / 2 };
  let bx = x, by = y;
  for (const t of xs) {
    for (const edge of [x - half.w, x, x + half.w]) {
      if (Math.abs(edge - t) < tol) { bx = x + (t - edge); break; }
    }
    if (bx !== x) break;
  }
  for (const t of ys) {
    for (const edge of [y - half.h, y, y + half.h]) {
      if (Math.abs(edge - t) < tol) { by = y + (t - edge); break; }
    }
    if (by !== y) break;
  }
  return { x: bx, y: by };
}
