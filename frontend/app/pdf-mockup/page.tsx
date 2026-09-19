import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { canDesign } from "@/lib/access";
import { UserNav } from "@/components/layout/UserNav";
import { PdfMockupClient } from "@/components/pdf/PdfMockupClient";

export const dynamic = "force-dynamic";

export default async function PdfMockupPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/auth/signin");
  if (!canDesign((session.user as any)?.accountType || "")) redirect("/");

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="h-16 border-b border-slate-200 bg-white flex items-center justify-between px-6 sticky top-0 z-50 shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/logo2.jpg" alt="" className="h-8 w-auto object-contain" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/logo1-96.png" alt="Gujarat Print Pack Mockup" className="h-8 w-auto object-contain hidden sm:block" />
          </Link>
          <span className="text-slate-300">|</span>
          <Link href="/" className="text-xs font-bold text-slate-400 uppercase tracking-widest hover:text-slate-700">Library</Link>
          <span className="text-xs font-bold text-slate-900 uppercase tracking-widest border-b-2 border-brand-600 pb-0.5">PDF to Mockup</span>
        </div>
        <UserNav />
      </header>
      <PdfMockupClient />
    </div>
  );
}
