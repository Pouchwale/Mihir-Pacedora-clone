import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canShareWithCustomers } from "@/lib/access";

// Depends on the signed-in user, so never prerender at build time
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const role = (session.user as any)?.accountType;
    if (!canShareWithCustomers(role)) {
      return NextResponse.json({ message: "Forbidden" }, { status: 403 });
    }

    const customers = await prisma.user.findMany({
      where: {
        accountType: "Customer",
        isActive: true
      },
      select: {
        id: true,
        name: true,
        email: true
      },
      orderBy: { name: "asc" }
    });

    return NextResponse.json(customers);
  } catch (error: any) {
    console.error("GET customers error:", error);
    return NextResponse.json(
      { message: error.message || "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
