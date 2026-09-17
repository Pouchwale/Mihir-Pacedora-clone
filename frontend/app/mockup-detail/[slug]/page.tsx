import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { ClientMockupEditor } from "./ClientMockupEditor";
import { loadEditorTemplate, templateAccessWhere } from "@/lib/templateAccess";

export default async function MockupDetailPage({
  params,
}: {
  params: { slug: string }
}) {
  const session = await getServerSession(authOptions);

  // Heavy model/document blobs are fetched by the client after the page renders
  const [template, approvalRequest] = await Promise.all([
    templateAccessWhere(session, params.slug).then(loadEditorTemplate),
    prisma.approvalRequest.findFirst({
      where: { designSlug: params.slug },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  if (!template) {
    return (
      <div className="flex flex-col h-screen w-screen items-center justify-center bg-background">
        <div className="text-red-500">Template not found or access denied.</div>
      </div>
    );
  }

  return (
    <ClientMockupEditor
      template={template}
      approvalRequestId={approvalRequest?.id || null}
    />
  );
}
