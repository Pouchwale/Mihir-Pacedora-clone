"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";

function ImpersonateContent() {
  const searchParams = useSearchParams();
  const email = searchParams.get("email");
  const token = searchParams.get("token");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!email) {
      setError("No email provided to impersonate.");
      return;
    }

    const performImpersonation = async () => {
      try {
        const result = await signIn("credentials", {
          redirect: false,
          email,
          impersonate: "true",
          token: token || "",
          password: "dummy", // Not checked during impersonation, but required by schema
          accountType: "dummy", // Not checked during impersonation
        });

        if (result?.error) {
          setError(result.error);
        } else {
          // Success! Redirect to home
          window.location.href = "/";
        }
      } catch (e: any) {
        setError(e.message || "Failed to impersonate account.");
      }
    };

    performImpersonation();
  }, [email]);

  return (
    <div className="text-center p-8 bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full">
      <h1 className="text-xl font-black text-slate-900 mb-2">Accessing Account</h1>
      
      {error ? (
        <div className="text-rose-600 bg-rose-50 p-4 rounded-lg text-sm font-bold border border-rose-200">
          {error}
        </div>
      ) : (
        <div className="flex flex-col items-center text-slate-500">
          <Loader2 className="w-8 h-8 animate-spin text-brand-600 mb-4" />
          <p className="text-sm">Please wait while we log you in as <b>{email}</b>...</p>
        </div>
      )}
    </div>
  );
}

export default function ImpersonatePage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50">
      <Suspense fallback={<div className="text-slate-500"><Loader2 className="w-8 h-8 animate-spin" /></div>}>
        <ImpersonateContent />
      </Suspense>
    </div>
  );
}
