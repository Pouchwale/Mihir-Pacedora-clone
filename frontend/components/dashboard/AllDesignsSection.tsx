"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, Layers, Loader2, Search, Send } from "lucide-react";
import { STATUS_LABELS } from "@/lib/access";

interface Design {
  id: string;
  name: string;
  slug: string;
  thumbnail: string | null;
  isRenderedThumbnail?: boolean;
  createdAt: string | Date;
  updatedAt: string | Date;
  author: { name: string | null; email: string } | null;
}

interface AllDesignsSectionProps {
  designs: Design[];
  approvals: { designSlug: string; status: string }[];
}

type Filter = "NOT_SUBMITTED" | "ALL";
const PAGE_SIZE = 24;

/** Every designer's saved design, so reviewers can find older work and start its approval. */
export function AllDesignsSection({ designs, approvals }: AllDesignsSectionProps) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("NOT_SUBMITTED");
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [startingSlug, setStartingSlug] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const statusBySlug = useMemo(() => {
    const map = new Map<string, string>();
    approvals.forEach((a) => {
      if (!map.has(a.designSlug)) map.set(a.designSlug, a.status);
    });
    return map;
  }, [approvals]);

  const notSubmittedCount = designs.filter((d) => !statusBySlug.has(d.slug)).length;
  const q = query.trim().toLowerCase();
  const filtered = designs.filter(
    (d) =>
      (filter === "ALL" || !statusBySlug.has(d.slug)) &&
      (!q ||
        d.name.toLowerCase().includes(q) ||
        d.author?.name?.toLowerCase().includes(q) ||
        d.author?.email.toLowerCase().includes(q))
  );

  const startApproval = async (design: Design) => {
    setStartingSlug(design.slug);
    setMessage(null);
    try {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ designName: design.name, designSlug: design.slug }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Could not start the approval");
      const stage = STATUS_LABELS[data.request?.status] || "review";
      setMessage({ ok: true, text: `"${design.name}" sent for approval (${stage}).` });
      router.refresh();
    } catch (e: any) {
      setMessage({ ok: false, text: e.message });
    } finally {
      setStartingSlug(null);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
      <div className="p-5 border-b border-slate-200 bg-slate-50/50 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <Layers className="w-4 h-4 text-brand-500" /> All Designs
          </h3>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Every design saved by your designers, including older work that was never submitted. Start an approval with one click.
          </p>
        </div>
        <div className="relative self-end md:self-auto">
          <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search design or designer..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setVisible(PAGE_SIZE);
            }}
            className="pl-8 pr-3 py-1.5 w-64 text-[11px] border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white text-slate-800 placeholder-slate-400"
          />
        </div>
      </div>

      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4">
        <div className="flex">
          {([
            ["NOT_SUBMITTED", `Not submitted (${notSubmittedCount})`],
            ["ALL", `All (${designs.length})`],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => {
                setFilter(key);
                setVisible(PAGE_SIZE);
              }}
              className={`px-4 py-2.5 text-[11px] font-bold tracking-wider uppercase border-b-2 transition-all cursor-pointer ${
                filter === key ? "border-brand-600 text-brand-600" : "border-transparent text-slate-400 hover:text-slate-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {message && (
          <span className={`text-[11px] font-semibold pr-2 ${message.ok ? "text-emerald-600" : "text-rose-600"}`}>{message.text}</span>
        )}
      </div>

      <div className="p-5">
        {filtered.length === 0 ? (
          <p className="py-10 text-center text-xs text-slate-400">
            {filter === "NOT_SUBMITTED" ? "Every saved design has already been submitted for approval." : "No designs found."}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered.slice(0, visible).map((design) => {
                const status = statusBySlug.get(design.slug);
                return (
                  <div key={design.id} className="flex gap-3 p-3 border border-slate-100 rounded-xl bg-slate-50/30 hover:border-slate-200 transition-colors">
                    <div className="w-20 h-16 shrink-0 rounded-lg bg-slate-100 overflow-hidden flex items-center justify-center">
                      {design.thumbnail ? (
                        <img src={design.thumbnail} alt={design.name} loading="lazy" decoding="async" className="w-full h-full object-contain" />
                      ) : (
                        <span className="text-[10px] font-black text-slate-400">3D</span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1 flex flex-col justify-between">
                      <div>
                        <p className="text-xs font-bold text-slate-800 truncate" title={design.name}>{design.name}</p>
                        <p className="text-[10px] text-slate-500 truncate">
                          {design.author?.name || "Unknown"} · {new Date(design.updatedAt).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-1.5">
                        {status ? (
                          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500">{STATUS_LABELS[status] || status}</span>
                        ) : (
                          <button
                            onClick={() => startApproval(design)}
                            disabled={startingSlug !== null}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white text-[10px] font-bold rounded-md cursor-pointer"
                          >
                            {startingSlug === design.slug ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                            Start approval
                          </button>
                        )}
                        <Link
                          href={`/mockup-detail/${design.slug}`}
                          className="inline-flex items-center gap-1 text-[10px] font-bold text-brand-600 hover:text-brand-700"
                        >
                          Open <ExternalLink className="w-3 h-3" />
                        </Link>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {filtered.length > visible && (
              <div className="text-center mt-4">
                <button
                  onClick={() => setVisible((v) => v + PAGE_SIZE)}
                  className="px-4 py-1.5 text-[11px] font-bold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Show more ({filtered.length - visible} left)
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
