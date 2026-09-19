import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { UserNav } from "@/components/layout/UserNav";
import { LibraryGrid } from "@/components/dashboard/LibraryGrid";
import { HistorySection } from "@/components/dashboard/HistorySection";
import { AllDesignsSection } from "@/components/dashboard/AllDesignsSection";
import { UserManagementSection } from "@/components/dashboard/UserManagement";
import { KeylineDefaultsSection } from "@/components/dashboard/KeylineDefaults";
import { redirect } from "next/navigation";
import { FolderHeart, Sparkles } from "lucide-react";
import { HEAD_OF_DESIGNER, STATUS, canShareWithCustomers } from "@/lib/access";
import { listVisibleApprovals } from "@/lib/approvals";
import { withThumbnailUrls } from "@/lib/templateAccess";
import { CustomerDisclaimer } from "@/components/ui/CustomerDisclaimer";

export default async function Home() {
  const session = await getServerSession(authOptions);
  
  if (!session) {
    redirect("/auth/signin");
  }

  const userId = (session?.user as any)?.id;

  // Fetch roles
  const role = (session?.user as any)?.accountType || "Customer";
  const isHead = role === HEAD_OF_DESIGNER;
  const isDesigner = role === "Designer" || isHead || role === "Administrator";
  const isCustomer = role === "Customer";
  const canShare = canShareWithCustomers(role);

  const userEmail = ((session?.user as any)?.email || "").toLowerCase();
  const isAdminView = role === "Administrator";

  // Template card columns (thumbnails are resolved separately without loading image data)
  const cardSelect = {
    id: true,
    name: true,
    description: true,
    updatedAt: true,
    modelFile: true,
    isPublic: true,
    isDefault: true,
    slug: true,
    authorId: true,
    author: { select: { name: true, image: true } },
  } as const;

  // Independent queries run in parallel
  const [approvalRows, ownTemplates, allDesignRows, customers] = await Promise.all([
    // One entry per design (latest request)
    listVisibleApprovals(session),
    userId && !isCustomer && !isAdminView
      ? prisma.template.findMany({ where: { authorId: userId }, orderBy: { createdAt: "desc" }, select: cardSelect })
      : Promise.resolve([]),
    // The Head of Designer can browse every designer's saved design (including never-submitted work)
    isHead
      ? prisma.template.findMany({
          where: { isDefault: false, authorId: { not: null }, author: { accountType: { not: "Customer" } } },
          orderBy: { updatedAt: "desc" },
          select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true, author: { select: { name: true, email: true } } },
        })
      : Promise.resolve([]),
    canShare
      ? prisma.user.findMany({ where: { accountType: "Customer", isActive: true }, select: { email: true, name: true } })
      : Promise.resolve([]),
  ]);
  const approvalRequests = approvalRows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  // Library cards: the Head of Designer also sees designs waiting for review and all approved designs
  // (with the customer they are shared with); customers see the approved designs shared with them.
  let templates: any[] = ownTemplates;
  if (isHead || isCustomer) {
    const extraSlugs = approvalRequests
      .filter((req) =>
        isCustomer
          ? req.customerEmail?.toLowerCase() === userEmail
          : req.status === STATUS.PENDING || req.status === STATUS.APPROVED
      )
      .map((req) => req.designSlug);
    if (extraSlugs.length > 0) {
      const ownSlugs = new Set(ownTemplates.map((t) => t.slug));
      const extra = await prisma.template.findMany({
        where: { slug: { in: extraSlugs.filter((slug) => !ownSlugs.has(slug)) } },
        orderBy: { createdAt: "desc" },
        select: cardSelect,
      });
      templates = [...ownTemplates, ...extra];
    }
  }

  const [libraryTemplates, allDesigns] = await Promise.all([
    withThumbnailUrls(templates),
    withThumbnailUrls(allDesignRows),
  ]);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Premium Dashboard Header */}
      <header className="h-16 border-b border-slate-200 bg-white flex items-center justify-between px-6 sticky top-0 z-50 shrink-0">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 group">
            <img src="/images/logo2.jpg" alt="Icon" decoding="async" className="h-8 w-auto object-contain transition-transform duration-500 ease-out group-hover:scale-105" />
            <img src="/images/logo1-96.png" alt="Gujarat Print Pack Mockup" decoding="async" className="h-8 w-auto object-contain hidden sm:block transition-transform duration-500 ease-out group-hover:scale-110 group-hover:-rotate-6" />
          </Link>
          <span className="text-slate-300">|</span>
          <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{isCustomer ? "Review Department" : "Library"}</span>
          {isDesigner && (
            <Link href="/pdf-mockup" className="text-xs font-bold text-brand-600 hover:text-brand-700 uppercase tracking-widest">PDF to Mockup</Link>
          )}
        </div>
        
        <div className="flex items-center gap-4">
          <UserNav />
        </div>
      </header>

      {/* Hero section */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-brand-900 py-12 px-6 sm:px-12 text-center relative overflow-hidden">
        <div className="absolute inset-0 opacity-10 bg-[radial-gradient(#eabcce_1px,transparent_1px)] [background-size:16px_16px]"></div>
        <div className="max-w-3xl mx-auto relative z-10">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand-500/20 text-brand-200 text-[10px] font-bold uppercase tracking-wider mb-4 border border-brand-500/30">
            <Sparkles className="w-3.5 h-3.5" /> 3D Packaging Mockups
          </span>
          <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
            {isCustomer ? "Review Your 3D Packaging Designs" : "Create Custom 3D Packaging in Seconds"}
          </h1>
          <p className="mt-3 text-sm sm:text-base text-slate-300 max-w-xl mx-auto leading-relaxed">
            {isCustomer ? "Review the latest custom mockups sent by our design team, and easily approve or request changes directly in 3D." : "Select a template, customize materials, lights, and drop your design directly on 3D objects with instant live rendering."}
          </p>
        </div>
      </div>

      {/* Main dashboard content */}
      <main className="flex-1 py-10 px-6 sm:px-12 max-w-7xl mx-auto w-full">
        <div className="space-y-8">
          {session && role === "Administrator" ? (
            <>
              <UserManagementSection />
              <div className="pt-8 border-t border-slate-200">
                <KeylineDefaultsSection />
              </div>
              {/* Administrators can review and share designs too (e.g. a Head of Designer's own designs) */}
              <div id="history" className="pt-8 border-t border-slate-200">
                <HistorySection
                  initialRequests={approvalRequests}
                  role={role}
                  canShare={canShare}
                  customers={customers}
                />
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200">
                <div>
                  <h2 className="text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2">
                    <FolderHeart className="w-5 h-5 text-brand-500" />
                    {isCustomer ? "Designs Shared For Your Review" : isHead ? "Pending Design Approvals" : session ? "Your Designs" : "Featured Templates"}
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    {isCustomer 
                      ? "These are the 3D mockups waiting for your approval. Click to view them in 3D." 
                      : isHead
                        ? "Review custom brand mockups submitted by designers, and share approved designs with customers."
                        : session 
                        ? "Create, edit and submit your packaging designs. Changes are saved automatically." 
                        : "Sign in to customize products and persist templates under your private space."}
                  </p>
                </div>
                {!session && (
                  <Link
                    href="/auth/signin"
                    className="inline-flex items-center justify-center px-4 py-2 text-xs font-bold text-brand-600 border border-brand-200 hover:border-brand-500 bg-white rounded-md transition-all shadow-sm"
                  >
                    Sign in to see private templates
                  </Link>
                )}
              </div>

              {/* Grid layout */}
              <LibraryGrid initialTemplates={libraryTemplates} userId={userId} userRole={role} approvalRequests={approvalRequests} customers={customers} />
              {isCustomer && (
                <CustomerDisclaimer className="rounded-lg border border-red-200 bg-red-50 py-2.5" />
              )}
            </>
          )}

          {/* All saved designs for reviewers */}
          {isHead && (
            <div id="all-designs" className="pt-8 border-t border-slate-200">
              <AllDesignsSection designs={allDesigns} approvals={approvalRequests} />
            </div>
          )}

          {/* History Section for Designers and Heads of Designer */}
          {isDesigner && role !== "Administrator" && (
            <div id="history" className="pt-8 border-t border-slate-200">
              <HistorySection
                initialRequests={approvalRequests}
                role={role}
                canShare={canShare}
                customers={customers}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
