"use client";

import Link from "next/link";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useToastStore } from "@/lib/toast";

const TONES = {
  success: { icon: CheckCircle2, className: "border-emerald-200", iconClass: "text-emerald-600" },
  error: { icon: XCircle, className: "border-rose-200", iconClass: "text-rose-600" },
  info: { icon: Info, className: "border-slate-200", iconClass: "text-brand-600" },
} as const;

/** Renders popup notifications at the top centre of the screen (no bouncing animations). */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[10000] flex flex-col gap-2 w-[calc(100%-2rem)] max-w-md"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const tone = TONES[t.tone];
        const Icon = tone.icon;
        const body = (
          <>
            <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${tone.iconClass}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-slate-900">{t.title}</p>
              {t.message && <p className="text-xs text-slate-600 mt-0.5 break-words">{t.message}</p>}
            </div>
          </>
        );
        return (
          <div
            key={t.id}
            role="status"
            className={`flex items-start gap-3 bg-white border ${tone.className} rounded-xl shadow-lg px-4 py-3`}
          >
            {t.href ? (
              <Link href={t.href} onClick={() => dismiss(t.id)} className="flex items-start gap-3 min-w-0 flex-1">
                {body}
              </Link>
            ) : (
              <div className="flex items-start gap-3 min-w-0 flex-1">{body}</div>
            )}
            <button
              onClick={() => dismiss(t.id)}
              className="p-1 -m-1 text-slate-400 hover:text-slate-700 rounded"
              aria-label="Dismiss notification"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
