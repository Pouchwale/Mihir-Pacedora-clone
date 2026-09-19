"use client";

import { useEffect, useState } from "react";
import { Ruler } from "lucide-react";
import { KeylineFields } from "@/components/dieline/KeylineFields";
import { DEFAULT_KEYLINES, POUCH_TYPE_LABELS, type Keyline, type PouchType } from "@/lib/dieline/types";
import { toast } from "@/lib/toast";

// Administrator: default keyline (seal widths, bands, bleed) for each pouch type. Designers start
// from these values and can change them per design.
export function KeylineDefaultsSection() {
  const [defaults, setDefaults] = useState<Record<PouchType, Keyline>>(DEFAULT_KEYLINES);
  const [pouchType, setPouchType] = useState<PouchType>("standup_pouch");
  const [draft, setDraft] = useState<Keyline>(DEFAULT_KEYLINES.standup_pouch);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/keylines")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) { setDefaults(data); setDraft(data[pouchType]); } })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (type: PouchType) => { setPouchType(type); setDraft(defaults[type]); };

  const save = async (keyline: Keyline | null) => {
    setSaving(true);
    try {
      const res = await fetch("/api/keylines", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pouchType, keyline }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to save");
      const data = await res.json();
      setDefaults(data);
      setDraft(data[pouchType]);
      toast.success(keyline ? "Keyline default saved" : "Keyline reset to the built-in values", POUCH_TYPE_LABELS[pouchType]);
    } catch (e: any) {
      toast.error("Could not save keyline default", e.message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(defaults[pouchType]);

  return (
    <section className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-3 border-b border-slate-200">
        <div>
          <h2 className="text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2"><Ruler className="w-5 h-5 text-brand-500" /> Keyline Defaults</h2>
          <p className="text-xs text-slate-400 mt-1">Default seal widths, top/bottom bands, bleed and gusset for each pouch type. New dielines start from these; designers can change them per design.</p>
        </div>
        <div className="flex gap-1.5">
          {(Object.keys(POUCH_TYPE_LABELS) as PouchType[]).map((type) => (
            <button key={type} type="button" onClick={() => select(type)} aria-pressed={pouchType === type} className={`px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-colors ${pouchType === type ? "bg-brand-600 text-white border-brand-600" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
              {POUCH_TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      </div>
      <div className="bg-white border border-slate-200 rounded-xl p-4 max-w-xl">
        <KeylineFields pouchType={pouchType} keyline={draft} onChange={setDraft} />
        <div className="flex items-center gap-2 mt-4 pt-3 border-t border-slate-100">
          <button type="button" disabled={saving || !dirty} onClick={() => save(draft)} className="px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-[11px] font-bold rounded-lg">Save as default</button>
          <button type="button" disabled={saving} onClick={() => save(null)} className="px-4 py-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 text-[11px] font-bold rounded-lg">Reset to built-in</button>
          {dirty && <span className="text-[10px] text-amber-600 font-semibold">Unsaved changes</span>}
        </div>
      </div>
    </section>
  );
}
