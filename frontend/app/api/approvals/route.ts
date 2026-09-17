import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { STATUS, approvalListSelect, canDesign, canSeeAllDesigns, sessionUser } from "@/lib/access";
import { listVisibleApprovals } from "@/lib/approvals";
import { LIMITS, badRequest, checkString, isSafeDocument, readJson } from "@/lib/http";

// GET: Fetch approval requests visible to the current user (optionally ?slug=)
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const slug = req.nextUrl.searchParams.get("slug");
    const approvals = await listVisibleApprovals(session, slug);

    return NextResponse.json(approvals);
  } catch (error: any) {
    console.error("GET approvals error:", error);
    return NextResponse.json({ message: "An unexpected error occurred" }, { status: 500 });
  }
}

// POST: Create a new approval request & simulate email log
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const user = sessionUser(session);
    if (!canDesign(user.role) && !canSeeAllDesigns(user.role)) {
      return NextResponse.json({ message: "Only designers and reviewers can submit designs for approval" }, { status: 403 });
    }

    const parsed = await readJson(req);
    if (parsed.error) return parsed.error;
    const { designName, designSlug, documentData, documentName } = parsed.body;
    const invalid =
      checkString(designName, "Design name", LIMITS.name) ||
      checkString(designSlug, "Design", LIMITS.name + 20) ||
      checkString(documentData, "Attached document", LIMITS.documentData) ||
      checkString(documentName, "Document name", LIMITS.fileName) ||
      (!isSafeDocument(documentData) ? "Attached document must be a PDF or Word file" : null);
    if (invalid) return badRequest(invalid);
    if (!designName || !designSlug) {
      return NextResponse.json(
        { message: "Design name and slug are required" },
        { status: 400 }
      );
    }

    const template = await prisma.template.findUnique({
      where: { slug: designSlug },
      select: {
        authorId: true,
        isDefault: true,
        documentName: true,
        author: { select: { name: true, email: true, accountType: true } },
      },
    });
    if (!template) {
      return NextResponse.json({ message: "Design not found" }, { status: 404 });
    }
    const isOwner = template.authorId === user.id;
    // Heads of Designer and Administrators may start the approval of any designer's
    // saved design (e.g. older designs that were never submitted)
    const onBehalf = !isOwner && canSeeAllDesigns(user.role);
    if (!isOwner && !onBehalf) {
      return NextResponse.json({ message: "You can only submit your own designs" }, { status: 403 });
    }
    if (template.isDefault || !template.author) {
      return NextResponse.json({ message: "Built-in templates cannot be submitted for approval" }, { status: 400 });
    }

    // Every submission is reviewed by the Head of Designer
    const initialStatus = STATUS.PENDING;
    const resetReview = {
      status: initialStatus,
      remarks: null,
      headStatus: null,
      headRemarks: null,
      headReviewer: null,
      // A resubmitted design must be approved again before the customer reviews it
      customerStatus: null,
      customerRemarks: null,
    };

    // The request always belongs to the design's author, even when a reviewer starts it
    const designerName = (onBehalf ? template.author.name : user.name) || "Designer";
    const designerEmail = (onBehalf ? template.author.email : user.email).toLowerCase();

    // When a reviewer starts it, carry over the brief attached to the saved design
    let attachment: { documentData?: string | null; documentName?: string | null } =
      documentData !== undefined ? { documentData, documentName } : {};
    if (onBehalf && documentData === undefined && template.documentName) {
      const doc = await prisma.template.findUnique({
        where: { slug: designSlug },
        select: { documentData: true, documentName: true },
      });
      attachment = { documentData: doc?.documentData ?? null, documentName: doc?.documentName ?? null };
    }

    // Check if an approval request for this design already exists
    const existingRequest = await prisma.approvalRequest.findFirst({
      where: { designSlug },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    const request = existingRequest
      ? // Auto-update the existing request instead of creating a duplicate
        await prisma.approvalRequest.update({
          where: { id: existingRequest.id },
          data: {
            designName,
            designerName,
            designerEmail,
            ...resetReview, // Clear any previous review decisions and remarks
            // Only update document if a new one is provided, else keep existing
            ...attachment,
          },
          select: approvalListSelect,
        })
      : await prisma.approvalRequest.create({
          data: {
            designName,
            designSlug,
            designerName,
            designerEmail,
            status: initialStatus,
            documentData: attachment.documentData || null,
            documentName: attachment.documentName || null,
          },
          select: approvalListSelect,
        });

    // Simulated email to the Head of Designer
    console.log(`[EMAIL SIMULATION] To: head-of-design@promockup.com | Approval Request: ${designName} | Review: /mockup-detail/${designSlug}`);

    return NextResponse.json(
      { message: "Approval request submitted successfully", request },
      { status: 201 }
    );
  } catch (error: any) {
    console.error("POST approvals error:", error);
    return NextResponse.json({ message: "An unexpected error occurred" }, { status: 500 });
  }
}
