import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  STATUS,
  approvalListSelect,
  canReview,
  canShareWithCustomers,
  sessionUser,
} from "@/lib/access";
import { LIMITS, badRequest, checkString, readJson } from "@/lib/http";

const DECISIONS = [STATUS.APPROVED, STATUS.REJECTED] as string[];
const forbidden = (message: string) => NextResponse.json({ message }, { status: 403 });

/**
 * PUT body (send only the part for the action being taken):
 * - { status, remarks }                  Head of Designer's review of a pending design
 * - { customerStatus, customerRemarks }  customer's decision on a design shared with them
 * - { customerEmail }                    share with / unshare from a customer
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { id } = params;
    const parsed = await readJson(req, 64 * 1024);
    if (parsed.error) return parsed.error;
    const body = parsed.body;
    const invalid =
      checkString(body.status, "Status", 20) ||
      checkString(body.remarks, "Remarks", LIMITS.remarks) ||
      checkString(body.customerStatus, "Customer decision", 20) ||
      checkString(body.customerRemarks, "Remarks", LIMITS.remarks) ||
      checkString(body.customerEmail, "Customer email", 254);
    if (invalid) return badRequest(invalid);
    const user = sessionUser(session);

    const existing = await prisma.approvalRequest.findUnique({
      where: { id },
      select: { status: true, customerEmail: true, designerEmail: true },
    });
    if (!existing) {
      return NextResponse.json({ message: "Approval request not found" }, { status: 404 });
    }

    const data: Record<string, string | null> = {};

    // Review by the Head of Designer (or an Administrator)
    if (body.status !== undefined) {
      if (!DECISIONS.includes(body.status)) {
        return NextResponse.json({ message: "Invalid status update" }, { status: 400 });
      }
      const remarks = body.remarks ? String(body.remarks).trim() : null;
      if (body.status === STATUS.REJECTED && !remarks) {
        return NextResponse.json({ message: "Please add remarks explaining the rejection" }, { status: 400 });
      }
      if (existing.status !== STATUS.PENDING) {
        return NextResponse.json({ message: "This design has already been reviewed" }, { status: 409 });
      }
      if (!canReview(user.role)) {
        return forbidden("Only the Head of Designer can review designs");
      }
      // A Head of Designer can't approve their own design (another Head or an Administrator must)
      if (user.role !== "Administrator" && existing.designerEmail.toLowerCase() === user.email) {
        return forbidden("You cannot approve your own design");
      }
      data.status = body.status;
      data.remarks = remarks;
      data.headStatus = body.status;
      data.headReviewer = user.name || user.email;
      // A design already assigned to a customer becomes reviewable by them once approved
      if (body.status === STATUS.APPROVED && existing.customerEmail) data.customerStatus = "PENDING";
    }

    // Customer decision
    if (body.customerStatus !== undefined) {
      const isAssignedCustomer =
        user.role === "Customer" && existing.customerEmail?.toLowerCase() === user.email;
      if (!isAssignedCustomer) return forbidden("Only the customer this design is shared with can review it");
      if (existing.status !== STATUS.APPROVED) return forbidden("This design is not ready for customer review");
      if (!DECISIONS.includes(body.customerStatus)) {
        return NextResponse.json({ message: "Invalid customer decision" }, { status: 400 });
      }
      const customerRemarks = body.customerRemarks ? String(body.customerRemarks).trim() : null;
      if (body.customerStatus === STATUS.REJECTED && !customerRemarks) {
        return NextResponse.json({ message: "Please add remarks explaining the requested changes" }, { status: 400 });
      }
      data.customerStatus = body.customerStatus;
      data.customerRemarks = customerRemarks;
    }

    // Share / unshare with a customer
    if (body.customerEmail !== undefined) {
      if (!canShareWithCustomers(user.role)) {
        return forbidden("Only the Head of Designer can share designs with customers");
      }
      const email = body.customerEmail ? String(body.customerEmail).trim().toLowerCase() : null;
      if (email) {
        if (existing.status !== STATUS.APPROVED) return forbidden("Only approved designs can be shared with customers");
        const customer = await prisma.user.findFirst({
          where: { email, accountType: "Customer", isActive: true },
          select: { id: true },
        });
        if (!customer) {
          return NextResponse.json({ message: "Customer account not found" }, { status: 400 });
        }
      }
      // Re-sharing with the same customer keeps their existing decision
      if (email !== (existing.customerEmail?.toLowerCase() ?? null)) {
        data.customerEmail = email;
        // Sharing with a different customer starts a fresh customer review
        data.customerStatus = email ? "PENDING" : null;
        data.customerRemarks = null;
      } else if (Object.keys(data).length === 0) {
        const unchanged = await prisma.approvalRequest.findUnique({ where: { id }, select: approvalListSelect });
        return NextResponse.json({ message: "Already shared with this customer", request: unchanged });
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ message: "Nothing to update" }, { status: 400 });
    }

    const updatedRequest = await prisma.approvalRequest.update({
      where: { id },
      data,
      select: approvalListSelect,
    });

    return NextResponse.json({
      message: "Approval request successfully updated",
      request: updatedRequest,
    });
  } catch (error: any) {
    console.error("PUT approvals error:", error);
    return NextResponse.json({ message: "An unexpected error occurred" }, { status: 500 });
  }
}
