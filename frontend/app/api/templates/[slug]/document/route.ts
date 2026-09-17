import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { templateAccessWhere } from "@/lib/templateAccess";

// GET: Attached design brief for a template
export async function GET(_request: Request, { params }: { params: { slug: string } }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const template = await prisma.template.findFirst({
      where: await templateAccessWhere(session, params.slug),
      select: { documentData: true, documentName: true },
    });
    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }
    return NextResponse.json(template);
  } catch (error) {
    console.error("Error fetching template document:", error);
    return NextResponse.json({ error: "Failed to fetch document" }, { status: 500 });
  }
}
