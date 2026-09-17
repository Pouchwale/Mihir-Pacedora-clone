import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { templateAccessWhere } from "@/lib/templateAccess";

// GET: Raw stored model data (OBJ text or base64 GLB data URL) for a user-uploaded template.
// Responses are revalidated with an ETag based on the design's last update, so an unchanged
// model (up to tens of MB) is not downloaded again.
export async function GET(request: Request, { params }: { params: { slug: string } }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const where = await templateAccessWhere(session, params.slug);
    const meta = await prisma.template.findFirst({ where, select: { id: true, updatedAt: true } });
    if (!meta) {
      return NextResponse.json({ error: "Model not found" }, { status: 404 });
    }

    const etag = `"${meta.id}-${meta.updatedAt.getTime()}"`;
    const cacheHeaders = {
      ETag: etag,
      "Cache-Control": "private, no-cache",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers: cacheHeaders });
    }

    const template = await prisma.template.findUnique({ where: { id: meta.id }, select: { objData: true } });
    if (!template?.objData) {
      return NextResponse.json({ error: "Model not found" }, { status: 404 });
    }
    return new NextResponse(template.objData, {
      headers: { ...cacheHeaders, "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    console.error("Error fetching template model:", error);
    return NextResponse.json({ error: "Failed to fetch model" }, { status: 500 });
  }
}
