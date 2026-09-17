"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Search, CheckCircle2, XCircle, Clock, ExternalLink, RefreshCw, Paperclip } from "lucide-react";
import { STATUS_LABELS, downloadApprovalDocument } from "@/lib/access";
import { toast } from "@/lib/toast";

interface ApprovalRequest {
  id: string;
  designName: string;
  designSlug: string;
  designerName: string;
  designerEmail: string;
  status: string;
  remarks: string | null;
  headStatus?: string | null;
  headRemarks?: string | null;
  headReviewer?: string | null;
  documentName?: string | null;
  customerEmail?: string | null;
  customerStatus?: string | null;
  customerRemarks?: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

interface HistorySectionProps {
  initialRequests: ApprovalRequest[];
  role: string;
  /** Whether this user may share approved designs with customers (Head of Designer / Administrator) */
  canShare: boolean;
  customers?: { name: string | null; email: string | null }[];
}

type Tab = "ALL" | "PENDING" | "APPROVED" | "REJECTED";
const isPending = (status: string) => status === "PENDING";

function FormattedDate({ date }: { date: string | Date }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <span className="opacity-0">Loading...</span>;
  }

  return <span>{new Date(date).toLocaleString()}</span>;
}

function Remark({ title, text, tone }: { title: string; text: string; tone: "good" | "bad" | "neutral" }) {
  const styles = {
    good: "bg-emerald-50/50 border-emerald-100 text-emerald-800",
    bad: "bg-rose-50/50 border-rose-100 text-rose-800",
    neutral: "bg-slate-50 border-slate-100 text-slate-700",
  }[tone];
  return (
    <div className={`p-2.5 rounded-lg border text-[10px] leading-normal font-semibold ${styles}`}>
      <span className="font-extrabold uppercase text-[8px] tracking-wider block mb-0.5 opacity-80">{title}</span>
      &ldquo;{text}&rdquo;
    </div>
  );
}

export function HistorySection({
  initialRequests,
  role,
  canShare,
  customers = []
}: HistorySectionProps) {
  const [requests, setRequests] = useState<ApprovalRequest[]>(initialRequests);
  const [filter, setFilter] = useState<Tab>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [shareSelection, setShareSelection] = useState<Record<string, string>>({});

  // Follow fresh server data after router.refresh() (e.g. a decision made from the bell)
  useEffect(() => {
    setRequests(initialRequests);
  }, [initialRequests]);

  const isDesignerOnly = role === "Designer";

  // The server already limits requests to what this role may see
  const matchesTab = (req: ApprovalRequest, tab: Tab) =>
    tab === "ALL" || (tab === "PENDING" ? isPending(req.status) : req.status === tab);

  const query = searchQuery.toLowerCase();
  const searched = requests
    .filter((req) => matchesTab(req, filter))
    .filter((req) =>
      req.designName.toLowerCase().includes(query) ||
      req.designerName.toLowerCase().includes(query) ||
      (req.remarks && req.remarks.toLowerCase().includes(query)) ||
      (req.headRemarks && req.headRemarks.toLowerCase().includes(query)) ||
      (req.customerEmail && req.customerEmail.toLowerCase().includes(query))
    );

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/approvals");
      if (res.ok) {
        const data = await res.json();
        setRequests(data);
      }
    } catch (e) {
      console.error("Failed to refresh history", e);
    } finally {
      setRefreshing(false);
    }
  };

  const updateSharing = async (id: string, email: string | null) => {
    try {
      const res = await fetch(`/api/approvals/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerEmail: email }),
      });

      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({}))).message || "Request failed");
      }

      toast.success(email ? "Design shared" : "Customer access removed", email ? `Shared with ${email}.` : undefined);
      handleRefresh(); // Refresh approvals list
    } catch (e: any) {
      console.error(e);
      toast.error(email ? "Failed to share design" : "Failed to remove access", e.message);
    }
  };

  const tabs: Tab[] = ["ALL", "PENDING", "APPROVED", "REJECTED"];

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
      {/* Header and Controls */}
      <div className="p-5 border-b border-slate-200 bg-slate-50/50 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-bold text-slate-800 tracking-tight flex items-center gap-2">
            📜 3D Mockup Review History
          </h3>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {isDesignerOnly
              ? "Review feedback and status reports for your submitted designs."
              : "Comprehensive audit logs of all submitted, approved and rejected packaging designs."}
          </p>
        </div>

        <div className="flex items-center gap-2 self-end md:self-auto">
          {/* Refresh Button */}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="p-1.5 border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-500 hover:text-slate-800 transition-colors cursor-pointer"
            title="Refresh History"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>

          {/* Search bar */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search design name, remarks, or customer..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-3 py-1.5 w-64 text-[11px] border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white text-slate-800 placeholder-slate-400"
            />
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 bg-white px-4">
        {tabs.map((tab) => {
          const count = requests.filter((r) => matchesTab(r, tab)).length;
          return (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`px-4 py-2.5 text-[11px] font-bold tracking-wider uppercase border-b-2 transition-all cursor-pointer ${
                filter === tab
                  ? "border-brand-600 text-brand-600"
                  : "border-transparent text-slate-400 hover:text-slate-600"
              }`}
            >
              {tab.toLowerCase()} ({count})
            </button>
          );
        })}
      </div>

      {/* List items */}
      <div className="p-5 bg-white divide-y divide-slate-100">
        {searched.length === 0 ? (
          <div className="py-12 text-center text-slate-400 flex flex-col items-center justify-center gap-2">
            <span className="text-xl">📂</span>
            <p className="text-xs font-semibold">No review history items found</p>
            <p className="text-[10px] text-slate-400 max-w-xs">
              Submitted designs and their review decisions will appear here as permanent audit records.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
            {searched.map((req) => (
              <div
                key={req.id}
                className="p-4 border border-slate-100 bg-slate-50/30 rounded-xl hover:border-slate-200 transition-all flex flex-col justify-between gap-3 shadow-2xs"
              >
                <div className="space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-bold text-slate-800 line-clamp-1">
                      {req.designName}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-wider flex items-center gap-1 shrink-0 ${
                        req.status === "APPROVED"
                          ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                          : req.status === "REJECTED"
                          ? "bg-rose-50 text-rose-700 border border-rose-200"
                          : "bg-amber-50 text-amber-700 border border-amber-200"
                      }`}
                    >
                      {req.status === "APPROVED" ? (
                        <CheckCircle2 className="w-2.5 h-2.5 text-emerald-600" />
                      ) : req.status === "REJECTED" ? (
                        <XCircle className="w-2.5 h-2.5 text-rose-600" />
                      ) : (
                        <Clock className="w-2.5 h-2.5 text-amber-600 animate-pulse" />
                      )}
                      {STATUS_LABELS[req.status] || req.status}
                    </span>
                  </div>

                  <div className="text-[10px] text-slate-500 font-semibold space-y-0.5">
                    {!isDesignerOnly && (
                      <p>Submitted by: <span className="text-slate-700">{req.designerName} ({req.designerEmail})</span></p>
                    )}
                    <p className="flex items-center gap-1">
                      <Clock className="w-3 h-3 text-slate-400" />
                      {isPending(req.status) ? "Submitted: " : "Reviewed: "}
                      <FormattedDate date={isPending(req.status) ? req.createdAt : req.updatedAt} />
                    </p>
                    {req.customerEmail && req.status === "APPROVED" && (
                      <p>
                        Customer: <span className="text-slate-700">{req.customerEmail}</span>{" "}
                        <span className={
                          req.customerStatus === "APPROVED" ? "text-emerald-600" : req.customerStatus === "REJECTED" ? "text-rose-600" : "text-amber-600"
                        }>
                          ({req.customerStatus === "APPROVED" ? "approved" : req.customerStatus === "REJECTED" ? "requested changes" : "awaiting review"})
                        </span>
                      </p>
                    )}
                  </div>
                </div>

                {/* Share approved designs with a specific customer account */}
                {canShare && req.status === "APPROVED" && (
                  <div className="mt-2 p-3 bg-white border border-slate-100 rounded-lg space-y-2">
                    <label className="block text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                      ✉️ Share with Specific Customer Account
                    </label>
                    <div className="flex items-center gap-2">
                      <select
                        value={shareSelection[req.id] ?? req.customerEmail ?? ""}
                        onChange={(e) => setShareSelection((prev) => ({ ...prev, [req.id]: e.target.value }))}
                        className="w-full px-2.5 py-1.5 text-[11px] border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white text-slate-800 font-medium"
                      >
                        <option value="" disabled>Select a customer...</option>
                        {customers.map((c, i) => (
                          <option key={c.email || i} value={c.email || ""}>
                            {c.name || "Unknown"} ({c.email})
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => {
                          const email = shareSelection[req.id] ?? req.customerEmail;
                          if (email) updateSharing(req.id, email);
                        }}
                        className="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-[10px] font-bold rounded-lg transition-all shadow-3xs shrink-0 cursor-pointer"
                      >
                        Share
                      </button>
                    </div>
                    {req.customerEmail && (
                      <div className="flex items-center justify-between pt-0.5">
                        <p className="text-[9px] text-emerald-600 font-semibold flex items-center gap-1">
                          ✓ Currently shared with: <span className="underline font-bold text-emerald-700">{req.customerEmail}</span>
                        </p>
                        <button
                          onClick={() => updateSharing(req.id, null)}
                          className="text-[9px] text-rose-500 hover:text-rose-700 font-bold underline cursor-pointer"
                        >
                          Remove Access
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {req.remarks && (
                  <Remark
                    title={`Head of Designer${req.headReviewer ? ` (${req.headReviewer})` : ""}`}
                    text={req.remarks}
                    tone={req.status === "REJECTED" ? "bad" : "good"}
                  />
                )}
                {/* Remarks from an earlier review step (designs reviewed before the flow was simplified) */}
                {req.headRemarks && (
                  <Remark title="Earlier review" text={req.headRemarks} tone={req.headStatus === "REJECTED" ? "bad" : "neutral"} />
                )}
                {req.customerRemarks && (
                  <Remark title="Customer Remarks" text={req.customerRemarks} tone={req.customerStatus === "REJECTED" ? "bad" : "good"} />
                )}

                <div className="flex items-center justify-between pt-2 border-t border-slate-100/80">
                  <div>
                    {req.documentName && (
                      <button
                        onClick={() => downloadApprovalDocument(req.id)}
                        className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-600 hover:text-emerald-700 hover:underline cursor-pointer select-none"
                        title={`Download Design Brief: ${req.documentName}`}
                      >
                        <Paperclip className="w-3 h-3" />
                        <span>Download Brief</span>
                      </button>
                    )}
                  </div>
                  <Link
                    href={`/mockup-detail/${req.designSlug}`}
                    className="inline-flex items-center gap-1 text-[10px] font-bold text-brand-600 hover:text-brand-700 cursor-pointer"
                  >
                    Open 3D Model <ExternalLink className="w-3 h-3" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
