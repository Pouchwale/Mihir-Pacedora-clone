import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { approvalScope } from "@/lib/access";

// GET: Fetch the attached brief for a single approval request the user can see
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const doc = await prisma.approvalRequest.findFirst({
      where: { id: params.id, ...approvalScope(session) },
      select: { documentData: true, documentName: true, designSlug: true, createdAt: true },
    });
    // Only the latest request of a design is visible (matches the approvals list)
    const newer = doc
      ? await prisma.approvalRequest.count({ where: { designSlug: doc.designSlug, createdAt: { gt: doc.createdAt } } })
      : 0;
    if (!doc || newer > 0) {
      return NextResponse.json({ message: "Document not found" }, { status: 404 });
    }

    return NextResponse.json({ documentData: doc.documentData, documentName: doc.documentName });
  } catch (error: any) {
    console.error("GET approval document error:", error);
    return NextResponse.json({ message: "An unexpected error occurred" }, { status: 500 });
  }
}
