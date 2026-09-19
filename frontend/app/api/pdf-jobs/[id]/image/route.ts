import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { authorizeJob } from "@/lib/pdfJobAuth";
import { PANELS } from "@/lib/pdfPipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET ?panel=front|back|gusset : the cleaned, bleed-trimmed texture (JPEG, max 2048 px)
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const auth = await authorizeJob(params.id);
  if (auth.error) return auth.error;
  const panel = new URL(request.url).searchParams.get("panel") || "";
  if (!(PANELS as readonly string[]).includes(panel)) return NextResponse.json({ message: "Unknown panel" }, { status: 400 });
  const file = path.join(auth.dir, panel, "texture_web.jpg");
  if (!fs.existsSync(file)) return NextResponse.json({ message: "No artwork for this panel" }, { status: 404 });
  return new NextResponse(fs.readFileSync(file), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" } });
}
