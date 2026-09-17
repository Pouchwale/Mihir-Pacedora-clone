import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { ClientMockupEditor } from "../mockup-detail/[slug]/ClientMockupEditor";
import { loadEditorTemplate } from "@/lib/templateAccess";
import { canSeeAllDesigns } from "@/lib/access";

export default async function ThreeDModelingPage({
  searchParams,
}: {
  searchParams: { id?: string };
}) {
  const session = await getServerSession(authOptions);
  const rawId = searchParams.id;
  
  // 1. Resolve template by ID or slug or Pacdora ID
  let template = null;
  const userId = (session?.user as any)?.id;
  const role = (session?.user as any)?.accountType || "Customer";
  // Only approvers may open other users' private designs by id
  const visible = canSeeAllDesigns(role)
    ? {}
    : { OR: [{ isPublic: true }, { isDefault: true }, { authorId: userId ?? "" }] };

  if (rawId) {
    // Try to find by id or slug directly
    template = await loadEditorTemplate({
      AND: [
        visible,
        {
          OR: [
            { id: rawId },
            { slug: rawId },
            { slug: rawId.toLowerCase().replace(/[^a-z0-9]+/g, "-") }
          ]
        }
      ]
    });

    // Special mapping for Pacdora ID "ircvbpdc6h"
    if (!template && rawId === "ircvbpdc6h") {
      // Map to 3 gusset zipper pouch
      template = await loadEditorTemplate({ slug: "3-gusset-zipper-pouch" });
    }
  }

  // 2. If still no template found, fallback to the default "3 gusset Zipper Pouch" or the first public default template
  if (!template) {
    template = await loadEditorTemplate({ isDefault: true });
  }

  // 3. If no default template exists at all (database empty), show instructions
  if (!template) {
    return (
      <div className="flex flex-col h-screen w-screen items-center justify-center bg-slate-50 p-6 text-center">
        <div className="w-16 h-16 bg-brand-600 rounded-full flex items-center justify-center text-white font-black text-2xl mb-4 shadow">P</div>
        <h1 className="text-xl font-bold text-slate-800 tracking-tight">No Mockup Templates Loaded</h1>
        <p className="text-sm text-slate-500 max-w-sm mt-2 leading-relaxed">
          Please run the database seed command to load all premium 3D dieline templates in your system.
        </p>
      </div>
    );
  }

  // 5. Fetch corresponding approval request if it exists
  const approvalRequest = await prisma.approvalRequest.findFirst({
    where: { designSlug: template.slug },
    select: { id: true },
      orderBy: { createdAt: "desc" }
  });

  return (
    <div className="relative w-full h-full">
      {/* Dynamic resolved notification toast */}
      {rawId === "ircvbpdc6h" && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 pointer-events-none mt-4 select-none">
          <div className="bg-emerald-600/90 text-white px-4 py-2 rounded-full text-[10px] font-bold uppercase tracking-wider flex items-center gap-2 shadow-lg backdrop-blur-sm border border-emerald-500">
            <span>✨</span> Resolved Pacdora Mockup ID: ircvbpdc6h → 3 gusset Zipper Pouch
          </div>
        </div>
      )}
      {rawId && rawId !== "ircvbpdc6h" && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 pointer-events-none mt-4 select-none">
          <div className="bg-slate-900/90 text-white px-4 py-2 rounded-full text-[10px] font-bold uppercase tracking-wider flex items-center gap-2 shadow-lg backdrop-blur-sm border border-slate-700">
            <span>✨</span> Loaded Preset: {template.name}
          </div>
        </div>
      )}
      <ClientMockupEditor 
        template={template}
        approvalRequestId={approvalRequest?.id || null}
      />
    </div>
  );
}
