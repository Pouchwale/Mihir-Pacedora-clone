"use client";

import { SessionProvider, useSession } from "next-auth/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  const isPublicPath = pathname?.startsWith("/auth/");

  useEffect(() => {
    if (status === "unauthenticated" && !isPublicPath) {
      router.replace("/auth/signin");
    }
  }, [status, pathname, router, isPublicPath]);

  // If unauthenticated and on a protected route, hide the cached UI and show a loading state
  if (status === "unauthenticated" && !isPublicPath) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <div className="text-sm font-bold text-slate-400 uppercase tracking-widest animate-pulse">
          Redirecting to Login...
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export default function SessionWrapper({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <AuthGuard>{children}</AuthGuard>
    </SessionProvider>
  );
}
