"use client";

import { Plus, Trash2 } from "lucide-react";
import type { Keyline, KeylineBand, PouchType } from "@/lib/dieline/types";

// Editable keyline values in mm. Used by the dieline editor (per design) and by the admin defaults.
export function KeylineFields({
  pouchType,
  keyline,
  onChange,
  disabled = false,
}: {
  pouchType: PouchType;
  keyline: Keyline;
  onChange: (next: Keyline) => void;
  disabled?: boolean;
}) {
  const setNum = (key: keyof Keyline, value: string) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return;
    onChange({ ...keyline, [key]: n });
  };
  const setBands = (key: "topBands" | "bottomBands", bands: KeylineBand[]) => onChange({ ...keyline, [key]: bands });
  const bandEditor = (key: "topBands" | "bottomBands", title: string, hint: string) => (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">{title}</span>
        {!disabled && (
          <button
            type="button"
            onClick={() => setBands(key, [...keyline[key], { label: "Band", mm: 10 }])}
            className="text-[9px] font-bold text-brand-600 hover:text-brand-700 flex items-center gap-0.5 cursor-pointer"
            disabled={keyline[key].length >= 8}
          >
            <Plus className="w-3 h-3" /> Add
          </button>
        )}
      </div>
      <p className="text-[8px] text-slate-400 mb-1.5">{hint}</p>
      <div className="space-y-1">
        {keyline[key].map((band, i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              type="text"
              value={band.label}
              maxLength={30}
              disabled={disabled}
              aria-label={`${title} ${i + 1} name`}
              onChange={(e) => setBands(key, keyline[key].map((b, j) => (j === i ? { ...b, label: e.target.value } : b)))}
              className="flex-1 min-w-0 px-2 py-1 text-[10px] border border-slate-200 rounded bg-white disabled:bg-slate-50"
            />
            <input
              type="number"
              value={band.mm}
              min={0}
              max={200}
              step={0.5}
              disabled={disabled}
              aria-label={`${title} ${i + 1} mm`}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0) setBands(key, keyline[key].map((b, j) => (j === i ? { ...b, mm: n } : b)));
              }}
              className="w-16 px-2 py-1 text-[10px] border border-slate-200 rounded bg-white text-right disabled:bg-slate-50"
            />
            <span className="text-[9px] text-slate-400 w-5">mm</span>
            {!disabled && (
              <button type="button" aria-label={`Remove ${title} ${i + 1}`} onClick={() => setBands(key, keyline[key].filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-500 cursor-pointer">
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
        {keyline[key].length === 0 && <p className="text-[9px] text-slate-400 italic">None</p>}
      </div>
    </div>
  );

  const numField = (key: keyof Keyline, label: string, hint: string, max: number) => (
    <label className="block">
      <span className="flex justify-between text-[9px] font-bold text-slate-500 uppercase tracking-wider">
        <span>{label}</span>
      </span>
      <div className="flex items-center gap-1 mt-0.5">
        <input
          type="number"
          value={keyline[key] as number}
          min={0}
          max={max}
          step={0.05}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => setNum(key, e.target.value)}
          className="w-full px-2 py-1 text-[10px] border border-slate-200 rounded bg-white text-right disabled:bg-slate-50"
        />
        <span className="text-[9px] text-slate-400 w-5">mm</span>
      </div>
      <span className="text-[8px] text-slate-400">{hint}</span>
    </label>
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {numField("bleedMm", "Bleed", "Artwork past the cut line", 20)}
        {numField("sideSealMm", "Side seal", "Front/back overlap, each side", 60)}
        {numField("safeMm", "Safe margin", "Keep text inside", 50)}
        {pouchType === "standup_pouch" && numField("gussetFoldMm", "Gusset fold", "Bottom gusset height from the bottom edge", 300)}
      </div>
      {bandEditor("topBands", "Top bands", "From the top edge downwards: seal, zipper, tear notch, hang hole…")}
      {bandEditor("bottomBands", "Bottom bands", "From the bottom edge upwards")}
    </div>
  );
}
