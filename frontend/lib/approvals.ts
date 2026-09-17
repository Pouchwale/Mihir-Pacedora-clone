import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { approvalListSelect, approvalScope } from "@/lib/access";

/**
 * Approval requests visible to the user: one (the latest) per design, and only for designs
 * that still exist. Older duplicate rows and requests for deleted designs are kept in the
 * database but no longer clutter lists and notifications.
 */
export async function listVisibleApprovals(session: Session | null, slug?: string | null) {
  const rows = await prisma.approvalRequest.findMany({
    where: { ...approvalScope(session), ...(slug ? { designSlug: slug } : {}) },
    select: approvalListSelect,
    orderBy: { createdAt: "desc" },
  });

  const slugs = Array.from(new Set(rows.map((r) => r.designSlug)));
  const existing = new Set(
    (
      await prisma.template.findMany({
        where: { slug: { in: slugs } },
        select: { slug: true },
      })
    ).map((t) => t.slug)
  );

  const seen = new Set<string>();
  return rows.filter((r) => {
    if (!existing.has(r.designSlug) || seen.has(r.designSlug)) return false;
    seen.add(r.designSlug);
    return true;
  });
}
