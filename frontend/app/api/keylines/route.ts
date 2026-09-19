import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readJson } from "@/lib/http";
import { DEFAULT_KEYLINES, sanitizeKeyline, type PouchType } from "@/lib/dieline/types";
import { KEYLINE_KEY_PREFIX, loadKeylineDefaults } from "@/lib/dieline/keylineDefaults";

export const dynamic = "force-dynamic";

const POUCH_TYPES = Object.keys(DEFAULT_KEYLINES) as PouchType[];

// GET: keyline defaults per pouch type (any signed-in user)
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await loadKeylineDefaults());
  } catch (error) {
    console.error("GET keylines error:", error);
    return NextResponse.json({ message: "Failed to load keyline defaults" }, { status: 500 });
  }
}

// PUT: administrators save (or reset with keyline: null) the default for one pouch type
export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  if ((session.user as any)?.accountType !== "Administrator") {
    return NextResponse.json({ message: "Only administrators can change keyline defaults" }, { status: 403 });
  }
  const parsed = await readJson(request, 64 * 1024);
  if (parsed.error) return parsed.error;
  const { pouchType, keyline } = parsed.body;
  if (!POUCH_TYPES.includes(pouchType)) {
    return NextResponse.json({ message: "Unknown pouch type" }, { status: 400 });
  }
  try {
    const key = KEYLINE_KEY_PREFIX + pouchType;
    if (keyline === null) {
      await prisma.appSetting.deleteMany({ where: { key } });
    } else {
      const value = JSON.stringify(sanitizeKeyline(keyline, DEFAULT_KEYLINES[pouchType as PouchType]));
      await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    return NextResponse.json(await loadKeylineDefaults());
  } catch (error) {
    console.error("PUT keylines error:", error);
    return NextResponse.json({ message: "Failed to save keyline default" }, { status: 500 });
  }
}
