import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import path from "path";
import { authOptions } from "@/lib/auth";
import { canDesign, canSeeAllDesigns } from "@/lib/access";
import { jobDir, pipelineStatus, readJson } from "@/lib/pdfPipeline";

/** Signed-in designer (Designer / Head of Designer / Administrator). */
export async function requireDesigner() {
  const session = await getServerSession(authOptions);
  const user = session?.user as { id?: string; accountType?: string } | undefined;
  if (!session || !user?.id) return { error: NextResponse.json({ message: "Unauthorized" }, { status: 401 }) };
  if (!canDesign(user.accountType || "")) {
    return { error: NextResponse.json({ message: "Only designers can create mockups from PDFs" }, { status: 403 }) };
  }
  return { user: { id: user.id, role: user.accountType || "" } };
}

/** The job folder, only for its owner (or a Head of Designer / Administrator). */
export async function authorizeJob(id: string) {
  const auth = await requireDesigner();
  if (auth.error) return { error: auth.error };
  const status = pipelineStatus();
  if (!status.ready) return { error: NextResponse.json({ message: status.reason }, { status: 503 }) };
  const dir = jobDir(status.root, id);
  const meta = dir ? readJson<any>(path.join(dir, "meta.json")) : null;
  if (!dir || !meta || (meta.ownerId !== auth.user.id && !canSeeAllDesigns(auth.user.role))) {
    return { error: NextResponse.json({ message: "Job not found" }, { status: 404 }) };
  }
  return { dir, meta, status };
}
