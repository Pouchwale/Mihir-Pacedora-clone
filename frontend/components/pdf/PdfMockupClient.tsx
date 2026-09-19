"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Box, CheckCircle2, FileText, FileUp, History, Image as ImageIcon, Loader2, RefreshCw, ScrollText, Trash2, XCircle } from "lucide-react";
import { toast } from "@/lib/toast";

type Job = {
  id: string;
  createdAt: number | null;
  files: { name: string; itemNo: string; size: number }[];
  mainFile: string | null;
  stage: string;
  error: string | null;
  itemNo: string | null;
  specs: Record<string, any> | null;
  needsReview: boolean;
  warnings: string[];
  panels: Record<string, any>;
  log: string;
};
type JobSummary = { id: string; createdAt: number | null; itemNo: string | null; mainFile: string | null; stage: string; needsReview: boolean; warnings: number };

const STAGES = [
  { id: "indexing", label: "Indexing", hint: "Registering the PDFs by item number" },
  { id: "specs", label: "Reading specs", hint: "Reading the spec table (about 30 s)" },
  { id: "artwork", label: "Artwork", hint: "Cropping to the TrimBox, removing technical marks, trimming bleed" },
  { id: "linking", label: "Linked panels", hint: "Looking up the back and gusset sheets" },
];
const ORDER = ["queued", "indexing", "specs", "artwork", "linking", "done"];

const FIELD_GROUPS: { title: string; fields: { key: string; label: string; kind: "text" | "mm" | "bool" | "finish" }[] }[] = [
  { title: "Job", fields: [
    { key: "client_name", label: "Client name", kind: "text" }, { key: "item_name", label: "Item name", kind: "text" },
    { key: "item_no", label: "Item no.", kind: "text" }, { key: "date_of_approval", label: "Date of approval", kind: "text" } ] },
  { title: "Dimensions", fields: [
    { key: "pouch_height_mm", label: "Pouch height", kind: "mm" }, { key: "pouch_closed_width_mm", label: "Closed width", kind: "mm" },
    { key: "pouch_open_width_mm", label: "Open width", kind: "mm" }, { key: "gusset_full_width_mm", label: "Gusset full width", kind: "mm" },
    { key: "sealing_width_mm", label: "Sealing width", kind: "mm" } ] },
  { title: "Construction", fields: [
    { key: "pouch_or_roll_form", label: "Pouch / roll form", kind: "text" }, { key: "sealing_type", label: "Sealing type", kind: "text" },
    { key: "gusset_type", label: "Gusset", kind: "text" }, { key: "finish", label: "Finish", kind: "finish" } ] },
  { title: "Features", fields: [
    { key: "zipper", label: "Zipper", kind: "bool" }, { key: "tear_notch", label: "Tear notch", kind: "text" },
    { key: "round_corner", label: "Round corner", kind: "bool" }, { key: "butterfly_notch", label: "Butterfly notch", kind: "bool" },
    { key: "transparent_window", label: "Transparent window", kind: "bool" } ] },
  { title: "Linked panels", fields: [
    { key: "back_code", label: "Back code", kind: "text" }, { key: "gusset_code", label: "Gusset code", kind: "text" } ] },
];

const PANEL_LABELS: Record<string, string> = { front: "Front", back: "Back", gusset: "Gusset (bottom)" };
const rgbHex = (rgb?: number[] | null) => (rgb ? "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("") : "#e2e8f0");
const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

function Section({ n, title, icon: Icon, children, aside }: { n: number; title: string; icon: any; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl shadow-sm" aria-labelledby={`sec-${n}`}>
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-slate-100">
        <h2 id={`sec-${n}`} className="flex items-center gap-2.5 text-sm font-bold text-slate-900">
          <span className="w-6 h-6 rounded-full bg-slate-900 text-white text-[11px] flex items-center justify-center">{n}</span>
          <Icon className="w-4 h-4 text-brand-600" /> {title}
        </h2>
        {aside}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function PdfMockupClient() {
  const router = useRouter();
  const [ready, setReady] = useState<boolean | null>(null);
  const [notReadyReason, setNotReadyReason] = useState("");
  const [recent, setRecent] = useState<JobSummary[]>([]);
  const [picked, setPicked] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [dirty, setDirty] = useState(false);
  const [building, setBuilding] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch("/api/pdf-jobs");
      const data = await res.json();
      setReady(!!data.ready);
      setNotReadyReason(data.reason || "");
      setRecent(data.jobs || []);
    } catch {
      setReady(false);
      setNotReadyReason("Could not reach the server.");
    }
  }, []);
  useEffect(() => { loadRecent(); }, [loadRecent]);

  const loadJob = useCallback(async (id: string) => {
    const res = await fetch(`/api/pdf-jobs/${id}`);
    if (!res.ok) { toast.error("Could not load the job"); return null; }
    const data: Job = await res.json();
    setJob(data);
    return data;
  }, []);

  // Poll while the pipeline is running
  const running = !!job && !["done", "error"].includes(job.stage);
  useEffect(() => {
    if (!job || !running) return;
    const t = setInterval(() => loadJob(job.id), 1500);
    return () => clearInterval(t);
  }, [job, running, loadJob]);

  // When a job finishes, fill the form with what was read
  const finishedKey = job && job.stage === "done" ? `${job.id}:${JSON.stringify(job.specs)}` : "";
  useEffect(() => {
    if (job?.stage === "done" && job.specs) { setForm({ ...job.specs }); setDirty(false); loadRecent(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedKey]);

  const addFiles = (list: FileList | File[]) => {
    const pdfs = Array.from(list).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    if (pdfs.length < Array.from(list).length) toast.error("Only PDF files can be attached");
    setPicked((prev) => [...prev, ...pdfs.filter((f) => !prev.some((p) => p.name === f.name && p.size === f.size))].slice(0, 6));
  };

  const start = async () => {
    if (!picked.length) return;
    setUploading(true);
    try {
      const body = new FormData();
      picked.forEach((f) => body.append("files", f));
      const res = await fetch("/api/pdf-jobs", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Upload failed");
      setPicked([]);
      setForm({});
      await loadJob(data.id);
    } catch (e: any) {
      toast.error("Could not start", e.message);
    } finally {
      setUploading(false);
    }
  };

  const saveReview = async () => {
    if (!job) return;
    const res = await fetch(`/api/pdf-jobs/${job.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ specs: form }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast.error("Could not save", data.message); return; }
    toast.info("Re-running with your values");
    await loadJob(job.id);
  };

  const specs = job?.specs;
  const issueFor = (key: string) => specs?.issues?.find((i: string) => i.startsWith(key + ":") || i.toLowerCase().includes(key.replace(/_mm$/, "").replace(/_/g, " ")));
  const isStandUp = /stand/i.test(String(form.sealing_type || "")) && /bottom/i.test(String(form.gusset_type || ""));
  const canBuild = job?.stage === "done" && !job.needsReview && !dirty && isStandUp && !!job.panels.front?.available;

  const build3d = async () => {
    if (!job || !specs) return;
    setBuilding(true);
    try {
      const toDataUrl = async (panel: string) => {
        const res = await fetch(`/api/pdf-jobs/${job.id}/image?panel=${panel}`);
        if (!res.ok) return null;
        const blob = await res.blob();
        return await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result as string); r.onerror = reject; r.readAsDataURL(blob); });
      };
      const [front, back, gusset] = await Promise.all(["front", "back", "gusset"].map((p) => (job.panels[p]?.available ? toDataUrl(p) : Promise.resolve(null))));
      const matt = specs.finish !== "gloss";
      const hasMetPet = (specs.layers || []).some((l: string) => /met/i.test(l));
      const mat = (panel: string) => ({
        // Missing panels get the plain colour sampled from the front artwork
        color: job.panels[panel]?.available ? "#ffffff" : rgbHex(job.panels[panel]?.fallbackRgb || job.panels.front?.averageRgb),
        roughness: matt ? 0.7 : 0.08, metalness: hasMetPet && !matt ? 0.15 : 0, emissive: 0, opacity: 1, clearcoat: matt ? 0 : 1,
      });
      // Filled depth is not on the sheet: shown as 60% of the gusset width (display only)
      const depthMm = Math.round(specs.gusset_full_width_mm * 0.6);
      const sizeScale = [specs.pouch_closed_width_mm / 150, specs.pouch_height_mm / 200, depthMm / 50];
      const editorState = {
        bgColor: "#e9ecef", bgType: "solid", showShadow: true, enableFloat: false, rotation: [0, 20, 0],
        // Real size stays in sizeScale; the view scale only makes the whole pouch fit the camera
        scale: Math.min(1, 1 / Math.max(sizeScale[0], sizeScale[1])),
        sizeScale,
        textures: { front, back, left: null, right: null, top: null, bottom: gusset, overall: null, label: null },
        materials: { Front: mat("front"), Back: mat("back"), Bottom: mat("gusset"), Left: mat("front"), Right: mat("front"), Top: mat("front"), Side: mat("front") },
        innerLayer: hasMetPet ? "met_pet" : "bopp",
        cornerStyles: specs.round_corner ? ["round", "round", "round", "round"] : ["none", "none", "none", "none"],
        cornerSizes: [12, 12, 12, 12],
      };
      const name = `${specs.item_no || job.itemNo} ${specs.client_name || ""}`.trim().slice(0, 100);
      const description = `From approval PDF ${job.mainFile}. ${specs.pouch_closed_width_mm} x ${specs.pouch_height_mm} mm, ${specs.sealing_type}, gusset ${specs.gusset_full_width_mm} mm, ${specs.finish || "?"} finish.`;
      const res = await fetch("/api/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, description, modelFile: "standup_pouch.obj", editorState }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || "Could not create the design");
      toast.success("3D mockup created", "Opening the editor…");
      router.push(`/mockup-detail/${data.slug}`);
    } catch (e: any) {
      toast.error("Could not build the 3D mockup", e.message);
      setBuilding(false);
    }
  };

  const stageIndex = job ? ORDER.indexOf(job.stage) : -1;

  return (
    <main className="flex-1 w-full max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6 items-start">
      <div className="space-y-5 min-w-0">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Approval PDF to 3D mockup</h1>
          <p className="text-xs text-slate-500 mt-1">Attach the job approval sheet. Specs and artwork are read on this computer: nothing is sent to any outside service.</p>
        </div>

        {ready === false && (
          <div role="alert" className="flex gap-3 p-4 rounded-xl border border-amber-200 bg-amber-50 text-xs text-amber-900">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div><b>The PDF pipeline is not available.</b> {notReadyReason}</div>
          </div>
        )}

        {/* 1. Attach */}
        <Section n={1} title="Attach approval PDFs" icon={FileUp}>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
            className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${dragging ? "border-brand-500 bg-brand-50" : "border-slate-200 bg-slate-50/60"}`}
          >
            <FileUp className="w-7 h-7 text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-bold text-slate-700">Drop the PDFs here</p>
            <p className="text-[11px] text-slate-400 mt-1 max-w-md mx-auto">Front sheet is required. Add the back and gusset sheets too if you have them: they are linked automatically by the codes in the Remarks. File names must start with the item number, e.g. FGPO7215_Dog_Food_Front_App.pdf</p>
            <button type="button" onClick={() => fileInput.current?.click()} disabled={!ready} className="mt-4 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white text-xs font-bold">Choose PDF files</button>
            <input ref={fileInput} type="file" accept="application/pdf,.pdf" multiple className="hidden" aria-label="Attach approval PDFs" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
          </div>
          {picked.length > 0 && (
            <ul className="mt-4 space-y-1.5">
              {picked.map((f) => {
                const item = f.name.match(/FGPO\d+/i)?.[0].toUpperCase();
                const panel = /back/i.test(f.name) ? "Back" : /gus+et|bottom/i.test(f.name) ? "Gusset" : /fro?nt|fornt/i.test(f.name) ? "Front" : "Panel ?";
                return (
                  <li key={f.name + f.size} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs">
                    <FileText className="w-4 h-4 text-rose-500 shrink-0" />
                    <span className="flex-1 min-w-0 truncate font-semibold text-slate-700">{f.name}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${item ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{item || "No item number"}</span>
                    <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-bold">{panel}</span>
                    <span className="text-slate-400 w-16 text-right">{fmtSize(f.size)}</span>
                    <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setPicked((p) => p.filter((x) => x !== f))} className="text-slate-400 hover:text-rose-600"><Trash2 className="w-3.5 h-3.5" /></button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-4 flex items-center gap-3">
            <button type="button" onClick={start} disabled={!picked.length || uploading || running || !ready} className="px-5 py-2.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-xs font-bold flex items-center gap-2">
              {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileUp className="w-3.5 h-3.5" />} Read PDF and build
            </button>
            {running && <span className="text-[11px] text-slate-400">A job is running…</span>}
          </div>
        </Section>

        {/* 2. Progress */}
        {job && (
          <Section n={2} title="Progress" icon={RefreshCw} aside={<span className="text-[11px] text-slate-400 truncate max-w-[50%]">{job.mainFile}</span>}>
            <ol className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {STAGES.map((s) => {
                const i = ORDER.indexOf(s.id);
                const state = job.stage === "error" ? (i < stageIndex || stageIndex === -1 ? "idle" : "idle") : i < stageIndex ? "done" : i === stageIndex ? "active" : "idle";
                return (
                  <li key={s.id} className={`p-3 rounded-lg border text-xs ${state === "done" ? "border-emerald-200 bg-emerald-50/60" : state === "active" ? "border-brand-300 bg-brand-50/50" : "border-slate-200 bg-slate-50/50"}`}>
                    <div className="flex items-center gap-1.5 font-bold text-slate-800">
                      {state === "done" ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : state === "active" ? <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-600" /> : <span className="w-3.5 h-3.5 rounded-full border border-slate-300" />}
                      {s.label}
                    </div>
                    <p className="text-[10px] text-slate-500 mt-1">{s.hint}</p>
                  </li>
                );
              })}
            </ol>
            {job.stage === "error" && (
              <div role="alert" className="mt-4 flex gap-2 p-3 rounded-lg border border-rose-200 bg-rose-50 text-xs text-rose-800"><XCircle className="w-4 h-4 shrink-0" /> {job.error || "The job failed."}</div>
            )}
            {job.stage === "done" && (
              <p className={`mt-4 text-xs font-semibold flex items-center gap-1.5 ${job.needsReview ? "text-amber-700" : "text-emerald-700"}`}>
                {job.needsReview ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                {job.needsReview ? "Finished, but some values need your review below before the 3D mockup can be built." : specs?.reviewed_by_user ? "Finished. Your values match the TrimBox." : "Finished. Every value was read with confidence and matches the TrimBox."}
              </p>
            )}
          </Section>
        )}

        {/* 3. Specs */}
        {job?.stage === "done" && specs && (
          <Section n={3} title="Specifications" icon={ScrollText} aside={<span className="text-[11px] text-slate-400">TrimBox {specs.trimbox_mm?.[0]} × {specs.trimbox_mm?.[1]} mm{specs.reviewed_by_user ? " · reviewed by you" : ""}</span>}>
            {specs.issues?.length > 0 && (
              <ul role="alert" className="mb-4 p-3 rounded-lg border border-amber-200 bg-amber-50 text-[11px] text-amber-900 space-y-0.5 list-disc list-inside">
                {specs.issues.map((i: string) => <li key={i}>{i}</li>)}
              </ul>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
              {FIELD_GROUPS.map((g) => (
                <fieldset key={g.title} className="space-y-2">
                  <legend className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{g.title}</legend>
                  {g.fields.map((f) => {
                    const conf = specs.confidence?.[f.key];
                    const bad = form[f.key] === null || form[f.key] === undefined || form[f.key] === "" || !!issueFor(f.key);
                    const set = (v: any) => { setForm((p) => ({ ...p, [f.key]: v })); setDirty(true); };
                    return (
                      <label key={f.key} className="flex items-center gap-2 text-xs">
                        <span className="w-32 shrink-0 text-slate-500">{f.label}</span>
                        {f.kind === "bool" ? (
                          <select value={form[f.key] === true ? "yes" : form[f.key] === false ? "no" : ""} onChange={(e) => set(e.target.value === "yes" ? true : e.target.value === "no" ? false : null)} className={`flex-1 px-2 py-1.5 rounded border bg-white ${bad ? "border-amber-400" : "border-slate-200"}`}>
                            <option value="">Not read</option><option value="yes">Yes</option><option value="no">No</option>
                          </select>
                        ) : f.kind === "finish" ? (
                          <select value={form[f.key] || ""} onChange={(e) => set(e.target.value || null)} className={`flex-1 px-2 py-1.5 rounded border bg-white ${bad ? "border-amber-400" : "border-slate-200"}`}>
                            <option value="">Not read</option><option value="matt">Matt</option><option value="gloss">Gloss</option>
                          </select>
                        ) : (
                          <span className="flex-1 flex items-center gap-1">
                            <input type={f.kind === "mm" ? "number" : "text"} step="0.5" min={0} value={form[f.key] ?? ""} onChange={(e) => set(f.kind === "mm" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)} className={`w-full px-2 py-1.5 rounded border ${bad ? "border-amber-400 bg-amber-50/40" : "border-slate-200"}`} />
                            {f.kind === "mm" && <span className="text-slate-400">mm</span>}
                          </span>
                        )}
                        {typeof conf === "number" && <span title="Reading confidence" className={`w-9 text-right text-[10px] font-mono ${conf < 0.85 ? "text-amber-600" : "text-slate-400"}`}>{Math.round(conf * 100)}%</span>}
                      </label>
                    );
                  })}
                </fieldset>
              ))}
              <fieldset>
                <legend className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Material layers</legend>
                <ol className="space-y-1 text-xs text-slate-700 list-decimal list-inside">
                  {(form.layers || []).map((l: string, i: number) => <li key={i}>{l}</li>)}
                  {(!form.layers || form.layers.length === 0) && <li className="list-none text-slate-400 italic">None read</li>}
                </ol>
              </fieldset>
            </div>
            <div className="mt-5 pt-4 border-t border-slate-100 flex items-center gap-3">
              <button type="button" onClick={saveReview} disabled={!dirty} className="px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white text-xs font-bold">Save my values and re-run</button>
              <span className="text-[11px] text-slate-400">{dirty ? "You changed values: save to validate them against the TrimBox and re-trim the artwork." : "Correct a value if it is wrong. Nothing is ever guessed."}</span>
            </div>
          </Section>
        )}

        {/* 4. Artwork */}
        {job?.stage === "done" && (
          <Section n={4} title="Artwork panels" icon={ImageIcon}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {["front", "back", "gusset"].map((name) => {
                const p = job.panels[name];
                return (
                  <div key={name} className="rounded-lg border border-slate-200 overflow-hidden flex flex-col">
                    <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-800">{PANEL_LABELS[name]}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${p?.available ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{p?.available ? "Artwork" : "Missing"}</span>
                    </div>
                    <div className="aspect-[3/4] bg-[repeating-conic-gradient(#f1f5f9_0%_25%,#fff_0%_50%)] bg-[length:16px_16px] flex items-center justify-center">
                      {p?.available ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/api/pdf-jobs/${job.id}/image?panel=${name}&v=${job.createdAt}`} alt={`${PANEL_LABELS[name]} artwork`} className="max-w-full max-h-full object-contain shadow" />
                      ) : (
                        <div className="w-2/3 h-2/3 rounded shadow-inner flex items-end p-2" style={{ background: rgbHex(p?.fallbackRgb) }}><span className="text-[10px] font-bold text-white/90 drop-shadow">Plain colour {rgbHex(p?.fallbackRgb)}</span></div>
                      )}
                    </div>
                    <dl className="p-3 text-[11px] text-slate-600 space-y-0.5">
                      {p?.available ? (
                        <>
                          <div className="flex justify-between gap-2"><dt className="text-slate-400">File</dt><dd className="truncate font-medium" title={p.sourceFile}>{p.sourceFile}</dd></div>
                          <div className="flex justify-between"><dt className="text-slate-400">Texture</dt><dd>{p.textureMm?.[0]} × {p.textureMm?.[1]} mm</dd></div>
                          <div className="flex justify-between"><dt className="text-slate-400">Bleed removed</dt><dd>{p.bleedMm?.[0]} / {p.bleedMm?.[1]} mm</dd></div>
                          <div className="flex justify-between gap-2"><dt className="text-slate-400 shrink-0">Marks removed</dt><dd className="text-right">{p.method === "layers" ? `layers off: ${p.layersOff.join(", ")}` : p.method === "spot-ink-mask" ? `spot ink filled: ${p.inksMasked.join(", ")}` : "not removed"}</dd></div>
                        </>
                      ) : (
                        <p className="text-amber-700">{p?.code ? `Linked sheet ${p.code} was not attached and is not in the library.` : "No linked code on the sheet."} A plain colour sampled from the front is used.</p>
                      )}
                    </dl>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {/* 5. Warnings + log */}
        {job?.stage === "done" && (
          <Section n={5} title="Warnings and job log" icon={AlertTriangle}>
            {job.warnings.length ? (
              <ul className="space-y-1.5 mb-4">
                {job.warnings.map((w) => <li key={w} className="flex gap-2 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {w}</li>)}
              </ul>
            ) : <p className="text-xs text-emerald-700 mb-4 flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> No warnings.</p>}
            <details>
              <summary className="text-[11px] font-bold text-slate-500 cursor-pointer">Job log</summary>
              <pre className="mt-2 p-3 rounded-lg bg-slate-900 text-slate-100 text-[10px] leading-relaxed overflow-x-auto whitespace-pre-wrap">{job.log || "No log."}</pre>
            </details>
          </Section>
        )}

        {/* 6. 3D */}
        {job?.stage === "done" && (
          <Section n={6} title="3D mockup" icon={Box}>
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <button type="button" onClick={build3d} disabled={!canBuild || building} className="px-6 py-3 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-sm font-bold flex items-center gap-2 shrink-0">
                {building ? <Loader2 className="w-4 h-4 animate-spin" /> : <Box className="w-4 h-4" />} Build 3D mockup
              </button>
              <p className="text-[11px] text-slate-500">
                {job.needsReview ? "Review the highlighted specifications first." : dirty ? "Save your changed values first." : !isStandUp ? "Only stand-up pouches with a bottom gusset can be built automatically for now. Other pouch types are coming." : !job.panels.front?.available ? "The front artwork could not be extracted." :
                  `Creates a ${form.pouch_closed_width_mm} × ${form.pouch_height_mm} mm stand-up pouch with the artwork applied and a ${form.finish} finish, and opens it in the 3D editor where you can rotate, zoom and export it.`}
              </p>
            </div>
          </Section>
        )}
      </div>

      {/* Recent jobs */}
      <aside className="bg-white border border-slate-200 rounded-xl shadow-sm lg:sticky lg:top-20" aria-labelledby="recent-jobs">
        <h2 id="recent-jobs" className="flex items-center gap-2 px-4 py-3 border-b border-slate-100 text-sm font-bold text-slate-900"><History className="w-4 h-4 text-brand-600" /> Recent jobs</h2>
        <ul className="p-2 space-y-1 max-h-[70vh] overflow-y-auto">
          {recent.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => loadJob(r.id)} aria-current={job?.id === r.id} className={`w-full text-left px-3 py-2 rounded-lg text-xs border ${job?.id === r.id ? "border-brand-300 bg-brand-50/50" : "border-transparent hover:bg-slate-50"}`}>
                <span className="flex items-center justify-between gap-2">
                  <span className="font-bold text-slate-800">{r.itemNo || "?"}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${r.stage === "error" ? "bg-rose-50 text-rose-700" : r.stage !== "done" ? "bg-sky-50 text-sky-700" : r.needsReview ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>{r.stage === "error" ? "Failed" : r.stage !== "done" ? "Running" : r.needsReview ? "Review" : "Ready"}</span>
                </span>
                <span className="block text-[10px] text-slate-400 truncate mt-0.5">{r.mainFile}</span>
                <span className="block text-[10px] text-slate-400">{r.createdAt ? new Date(r.createdAt).toLocaleString() : ""}{r.warnings ? ` · ${r.warnings} warning(s)` : ""}</span>
              </button>
            </li>
          ))}
          {recent.length === 0 && <li className="px-3 py-6 text-center text-[11px] text-slate-400">No jobs yet.</li>}
        </ul>
      </aside>
    </main>
  );
}
