"use client";

import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import { LogOut, User as UserIcon, Bell, Paperclip } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { downloadApprovalDocument, STATUS_LABELS } from "@/lib/access";
import { usePolling } from "@/lib/usePolling";
import { toast } from "@/lib/toast";

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

/** A decision on a design that the user should hear about. */
interface Update {
  key: string;
  req: any;
  title: string;
  message: string;
  approved: boolean;
}

function readSeen(storageKey: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? new Set(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeSeen(storageKey: string, seen: Set<string>) {
  try {
    // Keep the list bounded
    localStorage.setItem(storageKey, JSON.stringify(Array.from(seen).slice(-500)));
  } catch {
    /* storage unavailable: notifications simply repeat after reload */
  }
}

export function UserNav() {
  const { data: session } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  // Keep dashboard sections (library, history, all designs) in sync after deciding from the bell.
  // Not on the editor page, where a refresh would reload the whole 3D editor.
  const refreshDashboard = () => {
    if (pathname === "/") router.refresh();
  };

  const [approvals, setApprovals] = useState<any[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [remarks, setRemarks] = useState("");
  const [submittingRejection, setSubmittingRejection] = useState(false);
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const toasted = useRef<Set<string>>(new Set());

  const role = (session?.user as any)?.accountType || "Customer";
  const userId = (session?.user as any)?.id as string | undefined;
  const isAdministrator = role === "Administrator";
  const isReviewer = role === "Head of Designer" || isAdministrator;
  const isDesignerRole = role === "Designer";
  // Designers, Heads of Designer and Administrators get the notification bell
  const hasBell = isReviewer || isDesignerRole;
  // A Head of Designer can't approve their own design (an Administrator can approve any)
  const myEmail = session?.user?.email?.toLowerCase();
  const canActOn = (req: any) =>
    isReviewer && req.status === "PENDING" && (isAdministrator || req.designerEmail?.toLowerCase() !== myEmail);
  const seenKey = `notifications-seen:${userId}`;

  // Decisions to notify about: customer approvals/change requests (designers: their own designs,
  // reviewers: all designs) and, for designers, the Head of Designer's review decision.
  const updates: Update[] = approvals
    .flatMap((req): Update[] => {
      const list: Update[] = [];
      if (req.customerStatus === "APPROVED" || req.customerStatus === "REJECTED") {
        const approved = req.customerStatus === "APPROVED";
        list.push({
          key: `${req.id}:customer:${req.customerStatus}:${req.customerRemarks || ""}`,
          req,
          approved,
          title: approved ? `Customer approved "${req.designName}"` : `Customer requested changes on "${req.designName}"`,
          message: approved
            ? `${req.customerEmail || "The customer"} approved the design.`
            : `${req.customerEmail || "The customer"}: ${req.customerRemarks || "Changes requested"}`,
        });
      }
      if (isDesignerRole && (req.status === "APPROVED" || req.status === "REJECTED") && req.headReviewer) {
        const approved = req.status === "APPROVED";
        list.push({
          key: `${req.id}:review:${req.status}:${req.remarks || ""}`,
          req,
          approved,
          title: approved ? `"${req.designName}" was approved` : `"${req.designName}" needs changes`,
          message: `${req.headReviewer}${req.remarks ? `: ${req.remarks}` : approved ? " approved your design." : " rejected your design."}`,
        });
      }
      return list;
    })
    .sort((a, b) => new Date(b.req.updatedAt).getTime() - new Date(a.req.updatedAt).getTime());

  const fetchApprovals = async () => {
    try {
      const res = await fetch("/api/approvals");
      if (res.ok) {
        setApprovals(await res.json());
      }
    } catch (e) {
      console.error("Failed to load approvals in nav", e);
    }
  };

  usePolling(fetchApprovals, 20000, !!session && hasBell);

  // Popups for new decisions. On first use everything already there counts as seen.
  useEffect(() => {
    if (!userId || approvals.length === 0) return;
    const stored = readSeen(seenKey);
    if (!stored) {
      const initial = new Set(updates.map((u) => u.key));
      writeSeen(seenKey, initial);
      setSeen(initial);
      return;
    }
    setSeen(stored);
    const fresh = updates.filter((u) => !stored.has(u.key) && !toasted.current.has(u.key));
    fresh.slice(0, 3).forEach((u) => {
      toasted.current.add(u.key);
      (u.approved ? toast.success : toast.info)(u.title, u.message, `/mockup-detail/${u.req.designSlug}`);
    });
    fresh.slice(3).forEach((u) => toasted.current.add(u.key));
    if (fresh.length) refreshDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvals, userId]);

  const openBell = () => {
    const opening = !showNotifications;
    setShowNotifications(opening);
    if (opening && updates.length) {
      const next = new Set(seen);
      updates.forEach((u) => next.add(u.key));
      writeSeen(seenKey, next);
      setSeen(next);
    }
  };

  const handleRejectRequest = async (id: string) => {
    if (!remarks.trim()) {
      toast.error("Remarks required", "Please enter rejection remarks before submitting.");
      return;
    }

    setSubmittingRejection(true);
    try {
      const res = await fetch(`/api/approvals/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "REJECTED", remarks }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.message || "Rejection update failed");
      }

      setRejectingId(null);
      setRemarks("");
      toast.info("Design rejected", "The designer has been sent your remarks.");
      fetchApprovals();
      refreshDashboard();
    } catch (e: any) {
      console.error(e);
      toast.error("Failed to reject request", e.message);
    } finally {
      setSubmittingRejection(false);
    }
  };

  const handleApproveRequest = async (id: string) => {
    try {
      const res = await fetch(`/api/approvals/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "APPROVED" }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.message || "Approval failed");
      }

      toast.success("Design approved");
      fetchApprovals();
      refreshDashboard();
    } catch (e: any) {
      console.error(e);
      toast.error("Failed to approve request", e.message);
    }
  };

  if (!session) {
    return (
      <Link
        href="/auth/signin"
        className="inline-flex items-center justify-center px-4 py-2 text-xs font-bold uppercase tracking-wider text-white bg-brand-600 hover:bg-brand-700 rounded-md transition-colors"
      >
        Sign In
      </Link>
    );
  }

  const badgeStyles = ( {
    Administrator: "bg-purple-50 text-purple-700 border-purple-200",
    Designer: "bg-blue-50 text-blue-700 border-blue-200",
    Customer: "bg-slate-50 text-slate-600 border-slate-200",
    "Head of Designer": "bg-teal-50 text-teal-700 border-teal-200",
  } as Record<string, string> )[role] || "bg-slate-50 text-slate-600 border-slate-200";

  const pending = approvals.filter(canActOn);
  const unreadCount = updates.filter((u) => !seen.has(u.key)).length;
  const badgeCount = pending.length + unreadCount;

  return (
    <div className="flex items-center gap-4 z-50">
      {/* Admin Users Dashboard Button */}
      {role === "Administrator" && (
        <Link
          href="/admin/users"
          className="relative p-2 text-slate-500 hover:text-brand-600 hover:bg-slate-50 rounded-md transition-colors border border-slate-200 shadow-xs flex items-center justify-center w-9 h-9"
          title="User Management"
        >
          <UserIcon className="w-4 h-4" />
        </Link>
      )}

      {/* Notifications bell: designs to review and decisions on designs */}
      {hasBell && (
        <div className="relative">
          <button
            onClick={openBell}
            className={`relative p-2 text-slate-500 hover:text-brand-600 hover:bg-slate-50 rounded-md transition-colors border border-slate-200 shadow-xs flex items-center justify-center w-9 h-9 ${
              badgeCount > 0 ? "border-amber-300 bg-amber-50/50" : ""
            }`}
            title="Notifications"
            aria-label={`Notifications${badgeCount ? ` (${badgeCount} new)` : ""}`}
          >
            <Bell className={`w-4 h-4 ${badgeCount > 0 ? "text-amber-600" : ""}`} />
            {badgeCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 bg-red-500 text-white text-[8px] font-black rounded-full flex items-center justify-center">
                {badgeCount}
              </span>
            )}
          </button>

          {showNotifications && (
            <div className="absolute right-0 mt-2 w-80 bg-white border border-slate-200 rounded-xl shadow-xl z-50 overflow-hidden">
              <div className="max-h-[420px] overflow-y-auto divide-y divide-slate-100">
                {isReviewer && (
                  <div>
                    <div className="p-3 bg-slate-50 flex items-center justify-between sticky top-0">
                      <span className="text-xs font-bold text-slate-700">Waiting for your review</span>
                      <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-black uppercase tracking-wider">{pending.length}</span>
                    </div>
                    {pending.length === 0 ? (
                      <div className="p-4 text-center text-xs text-slate-400">No pending requests</div>
                    ) : (
                      pending.map((req) => (
                        <div key={req.id} className="p-3 text-left space-y-2 border-t border-slate-100">
                          <div>
                            <div className="text-[10px] font-bold text-slate-800">
                              {req.designerName} ({req.designerEmail})
                            </div>
                            <div
                              className="text-xs text-brand-600 font-bold underline cursor-pointer truncate mt-1"
                              onClick={() => { setShowNotifications(false); router.push(`/mockup-detail/${req.designSlug}`); }}
                            >
                              {req.designName}
                            </div>
                            <div className="text-[9px] text-slate-400 mt-0.5">
                              <FormattedDate date={req.createdAt} />
                            </div>
                            {req.documentName && (
                              <div className="flex items-center gap-1.5 mt-1.5 bg-slate-50 border border-slate-100 rounded-md p-1.5">
                                <Paperclip className="w-3 h-3 text-emerald-600 shrink-0" />
                                <button
                                  onClick={() => downloadApprovalDocument(req.id)}
                                  className="text-[9px] text-emerald-700 hover:text-emerald-800 hover:underline font-bold text-left truncate max-w-[190px]"
                                  title={`Download Design Document: ${req.documentName}`}
                                >
                                  {req.documentName}
                                </button>
                              </div>
                            )}
                          </div>

                          {rejectingId !== req.id ? (
                            <div className="flex items-center justify-between pt-1">
                              <span className="px-1.5 py-0.5 rounded text-[8px] font-bold uppercase bg-amber-50 text-amber-700 border border-amber-200">
                                {STATUS_LABELS[req.status] || req.status}
                              </span>
                              <div className="flex items-center gap-1.5">
                                <Button
                                  size="xs"
                                  onClick={() => handleApproveRequest(req.id)}
                                  className="bg-emerald-600 hover:bg-emerald-700 text-white text-[9px] font-bold px-2 py-0.5 h-6 uppercase tracking-wider rounded-md"
                                >
                                  Approve
                                </Button>
                                <Button
                                  size="xs"
                                  onClick={() => { setRejectingId(req.id); setRemarks(""); }}
                                  className="bg-rose-600 hover:bg-rose-700 text-white text-[9px] font-bold px-2 py-0.5 h-6 uppercase tracking-wider rounded-md"
                                >
                                  Reject
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="mt-2 p-2 bg-rose-50/50 rounded-lg border border-rose-100 space-y-2">
                              <textarea
                                value={remarks}
                                onChange={(e) => setRemarks(e.target.value)}
                                className="w-full text-[10px] p-1.5 border border-rose-200 rounded focus:outline-none focus:ring-1 focus:ring-rose-400 bg-white text-slate-800"
                                placeholder="Enter rejection remarks..."
                                rows={2}
                              />
                              <div className="flex items-center justify-end gap-1.5">
                                <button
                                  onClick={() => { setRejectingId(null); setRemarks(""); }}
                                  className="px-2 py-0.5 border border-slate-200 text-slate-500 rounded text-[8px] hover:bg-slate-50 font-bold"
                                >
                                  Cancel
                                </button>
                                <button
                                  onClick={() => handleRejectRequest(req.id)}
                                  disabled={submittingRejection}
                                  className="px-2.5 py-0.5 bg-rose-600 hover:bg-rose-700 text-white rounded text-[8px] font-bold shadow-sm"
                                >
                                  {submittingRejection ? "Submitting..." : "Submit Rejection"}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}

                <div>
                  <div className="p-3 bg-slate-50 flex items-center justify-between sticky top-0">
                    <span className="text-xs font-bold text-slate-700">Updates</span>
                    {unreadCount > 0 && (
                      <span className="text-[10px] bg-brand-100 text-brand-700 px-1.5 py-0.5 rounded font-black uppercase tracking-wider">{unreadCount} new</span>
                    )}
                  </div>
                  {updates.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-400">No approvals or rejections yet</div>
                  ) : (
                    updates.slice(0, 30).map((u) => (
                      <button
                        key={u.key}
                        onClick={() => { setShowNotifications(false); router.push(`/mockup-detail/${u.req.designSlug}`); }}
                        className="w-full text-left p-3 border-t border-slate-100 hover:bg-slate-50 flex gap-2"
                      >
                        <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${u.approved ? "bg-emerald-500" : "bg-rose-500"}`} />
                        <span className="min-w-0">
                          <span className="block text-xs font-bold text-slate-800">{u.title}</span>
                          <span className="block text-[10px] text-slate-500 mt-0.5 break-words">{u.message}</span>
                          <span className="block text-[9px] text-slate-400 mt-0.5"><FormattedDate date={u.req.updatedAt} /></span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* User profile dropdown and metadata */}
      <div className="flex items-center gap-2">
        {session.user?.image ? (
          <img
            src={session.user.image}
            alt={session.user.name || "User avatar"}
            className="w-8 h-8 rounded-full border border-slate-200"
          />
        ) : (
          <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-600">
            <UserIcon className="w-4 h-4" />
          </div>
        )}
        <div className="hidden sm:block text-left">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-bold text-slate-700 leading-none">
              {session.user?.name || "User"}
            </span>
            <span className={`inline-block px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider border ${badgeStyles}`}>
              {role}
            </span>
          </div>
          <div className="text-[10px] text-slate-400 mt-1 leading-none">
            {session.user?.email}
          </div>
        </div>
      </div>

      <button
        onClick={async () => {
          await signOut({ redirect: false });
          window.location.href = "/auth/signin";
        }}
        className="inline-flex items-center justify-center p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
        title="Sign Out"
      >
        <LogOut className="w-4 h-4" />
      </button>
    </div>
  );
}
