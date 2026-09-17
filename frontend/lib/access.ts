import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { downloadDataUrl } from "@/lib/download";
import { toast } from "@/lib/toast";

export const HEAD_OF_DESIGNER = "Head of Designer";
export const ACCOUNT_TYPES = ["Customer", "Designer", HEAD_OF_DESIGNER, "Administrator"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Approval states stored in ApprovalRequest.status */
export const STATUS = {
  PENDING: "PENDING", // waiting for the Head of Designer
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
} as const;

export const STATUS_LABELS: Record<string, string> = {
  PENDING: "Awaiting Head of Designer",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export function sessionUser(session: Session | null) {
  const user = session?.user as
    | { id?: string; email?: string | null; name?: string | null; accountType?: string }
    | undefined;
  return {
    id: user?.id,
    email: user?.email?.toLowerCase() ?? "",
    name: user?.name ?? null,
    role: (user?.accountType as AccountType) || "Customer",
  };
}

export const isAdmin = (role: string) => role === "Administrator";
/** Reviews (approves/rejects) submitted designs */
export const canReview = (role: string) => role === HEAD_OF_DESIGNER || role === "Administrator";
/** Can create designs and submit them for approval */
export const canDesign = (role: string) =>
  role === "Designer" || role === HEAD_OF_DESIGNER || role === "Administrator";
/** Sees every design and approval request (not just their own) */
export const canSeeAllDesigns = (role: string) => role === HEAD_OF_DESIGNER || role === "Administrator";
/** Can share approved designs with customers */
export const canShareWithCustomers = (role: string) => role === HEAD_OF_DESIGNER || role === "Administrator";

/** Approval requests a user is allowed to see. */
export function approvalScope(session: Session | null): Prisma.ApprovalRequestWhereInput {
  const { role, email } = sessionUser(session);
  if (canSeeAllDesigns(role)) return {};
  if (role === "Designer") return { designerEmail: email };
  // Customers only see designs shared with them after they were approved
  return { customerEmail: email, status: STATUS.APPROVED };
}

/** List columns — excludes the (potentially multi-MB) base64 document. */
export const approvalListSelect = {
  id: true,
  designName: true,
  designSlug: true,
  designerName: true,
  designerEmail: true,
  status: true,
  remarks: true,
  headStatus: true,
  headRemarks: true,
  headReviewer: true,
  documentName: true,
  customerEmail: true,
  customerStatus: true,
  customerRemarks: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ApprovalRequestSelect;

/** Downloads an approval request's attached brief on demand. */
export async function downloadApprovalDocument(id: string) {
  try {
    const res = await fetch(`/api/approvals/${id}/document`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Download failed");
    const { documentData, documentName } = await res.json();
    if (!documentData) throw new Error("No document attached");
    if (!downloadDataUrl(documentData, documentName)) throw new Error("The attached file is not a valid document");
  } catch (e: any) {
    console.error("Failed to download document:", e);
    toast.error("Failed to download attached document", e.message);
  }
}
