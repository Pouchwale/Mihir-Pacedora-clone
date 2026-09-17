import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { templateAccessWhere } from "@/lib/templateAccess";

// GET: Rendered preview image stored as a data URL, served as a real (cacheable) image.
// Only raster image types are served, so a stored value can never be rendered as HTML/SVG.
export async function GET(_request: Request, { params }: { params: { slug: string } }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const template = await prisma.template.findFirst({
      where: await templateAccessWhere(session, params.slug),
      select: { thumbnail: true },
    });
    const match = template?.thumbnail?.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
      return NextResponse.json({ error: "Thumbnail not found" }, { status: 404 });
    }
    return new NextResponse(Buffer.from(match[2], "base64"), {
      headers: {
        "Content-Type": match[1],
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        // URLs carry a ?v=<updatedAt> version, so a changed thumbnail gets a new URL
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("Error fetching template thumbnail:", error);
    return NextResponse.json({ error: "Failed to fetch thumbnail" }, { status: 500 });
  }
}
