"use client";

import { useSession, signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { useState } from "react";

export function ImpersonationBanner() {
  const { data: session } = useSession();
  const [reverting, setReverting] = useState(false);

  // If no session or no originalAdminEmail is present, hide the banner
  if (!session || !(session.user as any)?.originalAdminEmail) return null;

  const handleRevert = async () => {
    setReverting(true);
    try {
      const result = await signIn("credentials", {
        redirect: false,
        revertImpersonation: "true",
        email: "dummy",
        password: "dummy",
        accountType: "dummy"
      });
      if (!result || result.error) {
        throw new Error(result?.error || "Could not return to the admin account");
      }
      window.location.href = "/admin/users";
    } catch (e: any) {
      console.error(e);
      alert(`${e.message}. Please sign in again as the administrator.`);
      setReverting(false);
    }
  };

  return (
    <div className="bg-rose-600 text-white px-4 py-2.5 text-xs font-bold flex items-center justify-center gap-6 z-[9999] shadow-md relative w-full">
      <span className="tracking-wide">
        You are currently impersonating <span className="underline decoration-white/50 underline-offset-2">{(session.user as any).email}</span>.
      </span>
      <button 
        onClick={handleRevert} 
        disabled={reverting}
        className="bg-white text-rose-600 px-4 py-1.5 rounded-md hover:bg-rose-50 transition-colors flex items-center gap-2 shadow-sm font-black uppercase tracking-wider text-[10px]"
      >
        {reverting ? (
          <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Restoring Admin...</>
        ) : (
          "Return to Admin"
        )}
      </button>
    </div>
  );
}
