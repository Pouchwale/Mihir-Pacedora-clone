import type { Session } from "next-auth";
import { Prisma } from "@prisma/client";
import fs from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";
import { STATUS, canSeeAllDesigns, sessionUser } from "@/lib/access";

/**
 * Where-clause for templates the user may open: reviewers see everything, customers see
 * approved designs shared with them, everyone sees public/default templates and their own.
 */
export async function templateAccessWhere(
  session: Session | null,
  slug: string
): Promise<Prisma.TemplateWhereInput> {
  const { id, email, role } = sessionUser(session);
  if (canSeeAllDesigns(role)) return { slug };

  // Only the latest request for the design counts: older rows (before an unshare or resubmission)
  // must not keep granting access
  const latest = email
    ? await prisma.approvalRequest.findFirst({
        where: { designSlug: slug },
        orderBy: { createdAt: "desc" },
        select: { status: true, customerEmail: true },
      })
    : null;
  if (latest && latest.status === STATUS.APPROVED && latest.customerEmail?.toLowerCase() === email) return { slug };

  return {
    slug,
    OR: [{ isPublic: true }, { isDefault: true }, { authorId: id ?? "" }],
  };
}

/** Editor payload — leaves out the heavy model/document/thumbnail blobs, which load separately. */
export const templateEditorSelect = {
  id: true,
  name: true,
  description: true,
  modelFile: true,
  isPublic: true,
  isDefault: true,
  slug: true,
  editorState: true,
  documentName: true,
  authorId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TemplateSelect;

/** Resolves the editor template props, flagging which heavy blobs exist. */
export async function loadEditorTemplate(where: Prisma.TemplateWhereInput) {
  const template = await prisma.template.findFirst({ where, select: templateEditorSelect });
  if (!template) return null;

  // One query for which heavy blobs exist, without loading them
  const [flags] = await prisma.$queryRaw<{ hasObjData: unknown; hasThumbnail: unknown; hasDocument: unknown }[]>`
    SELECT "objData" IS NOT NULL AS "hasObjData",
           "thumbnail" IS NOT NULL AS "hasThumbnail",
           "documentData" IS NOT NULL AS "hasDocument"
    FROM "Template" WHERE "id" = ${template.id}`;
  const truthy = (v: unknown) => v === true || v === 1 || v === BigInt(1) || v === "1" || v === "t";

  return {
    ...template,
    hasObjData: truthy(flags?.hasObjData),
    // Header only checks whether a thumbnail exists
    thumbnail: truthy(flags?.hasThumbnail) ? "stored" : null,
    hasDocument: truthy(flags?.hasDocument),
    // Whether the model file ships with the app (uploaded designs only have their name)
    hasShippedModel: shippedModelExists(template.modelFile),
  };
}

/**
 * Adds a `thumbnail` (image URL or static path) to template cards without loading the stored
 * base64 images: only whether a thumbnail is a data URL is read from the database.
 */
export async function withThumbnailUrls<T extends { slug: string; updatedAt: Date }>(templates: T[]) {
  if (templates.length === 0) return [];
  const rows = await prisma.$queryRaw<{ slug: string; thumb: string | null }[]>`
    SELECT "slug",
           CASE WHEN substr("thumbnail", 1, 5) = 'data:' THEN 'data:' ELSE "thumbnail" END AS "thumb"
    FROM "Template"
    WHERE "slug" IN (${Prisma.join(templates.map((t) => t.slug))})`;
  const bySlug = new Map(rows.map((r) => [r.slug, r.thumb]));
  return templates.map((template) => {
    const thumb = bySlug.get(template.slug) ?? null;
    const isRendered = thumb === "data:";
    return {
      ...template,
      thumbnail: isRendered
        ? `/api/templates/${encodeURIComponent(template.slug)}/thumbnail?v=${template.updatedAt.getTime()}`
        : thumb,
      isRenderedThumbnail: isRendered,
    };
  });
}

function shippedModelExists(modelFile: string | null | undefined): boolean {
  if (!modelFile) return false;
  const name = path.basename(modelFile);
  if (name !== modelFile) return false;
  const candidates = [
    path.join(process.cwd(), "public", "models", name),
    path.join(process.cwd(), "frontend", "public", "models", name),
  ];
  return candidates.some((file) => fs.existsSync(file));
}
