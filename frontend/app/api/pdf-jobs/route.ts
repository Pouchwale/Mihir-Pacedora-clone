import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { canSeeAllDesigns } from "@/lib/access";
import { requireDesigner } from "@/lib/pdfJobAuth";
import { MAX_FILES, MAX_PDF_BYTES, newJobId, paths, pipelineStatus, publicJob, readJson, safePdfName, startJob } from "@/lib/pdfPipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ITEM_NO = /(FGPO\d+)/i;

// GET: is the pipeline installed + the recent jobs of this user
export async function GET() {
  const auth = await requireDesigner();
  if (auth.error) return auth.error;
  const status = pipelineStatus();
  if (!status.ready) return NextResponse.json({ ready: false, reason: status.reason, jobs: [] });
  const dir = paths(status.root).jobs;
  const jobs = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .map((id) => ({ id, meta: readJson<any>(path.join(dir, id, "meta.json")) }))
    .filter((j) => j.meta && (j.meta.ownerId === auth.user.id || canSeeAllDesigns(auth.user.role)))
    .sort((a, b) => (b.meta.createdAt || 0) - (a.meta.createdAt || 0))
    .slice(0, 12)
    .map((j) => {
      const full = publicJob(j.id, path.join(dir, j.id));
      return { id: j.id, createdAt: full.createdAt, itemNo: full.itemNo, mainFile: full.mainFile, stage: full.stage, needsReview: full.needsReview, warnings: full.warnings.length };
    });
  return NextResponse.json({ ready: true, jobs });
}

// POST (multipart, field "files"): store the PDFs in the library and start a job
export async function POST(request: Request) {
  const auth = await requireDesigner();
  if (auth.error) return auth.error;
  const status = pipelineStatus();
  if (!status.ready) return NextResponse.json({ message: status.reason }, { status: 503 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ message: "Upload could not be read" }, { status: 400 });
  }
  const files = form.getAll("files").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
  if (files.length === 0) return NextResponse.json({ message: "Attach at least one approval PDF" }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ message: `Attach at most ${MAX_FILES} PDFs at once` }, { status: 400 });

  const p = paths(status.root);
  fs.mkdirSync(p.library, { recursive: true });
  const checked: { name: string; itemNo: string; bytes: Buffer }[] = [];
  for (const file of files) {
    if (file.size > MAX_PDF_BYTES) return NextResponse.json({ message: `${file.name} is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB` }, { status: 413 });
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return NextResponse.json({ message: `${file.name} is not a PDF file` }, { status: 400 });
    const name = safePdfName(file.name);
    const itemNo = name.match(ITEM_NO)?.[1].toUpperCase();
    if (!itemNo) return NextResponse.json({ message: `${file.name}: the file name must contain the item number (FGPO + digits)` }, { status: 400 });
    checked.push({ name, itemNo, bytes });
  }
  // Nothing is written until every file passed the checks
  for (const f of checked) fs.writeFileSync(path.join(p.library, f.name), f.bytes);
  const saved = checked.map((f) => ({ name: f.name, itemNo: f.itemNo, size: f.bytes.length }));
  // The sheet to build from: the first "front" sheet, else the first file
  const main = saved.find((f) => /fro?nt|fornt/i.test(f.name)) || saved[0];

  const id = newJobId();
  const dir = path.join(p.jobs, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ ownerId: auth.user.id, createdAt: Date.now(), files: saved, mainFile: main.name, itemNo: main.itemNo }));
  startJob(status.root, status.python, dir, path.join(p.library, main.name));
  return NextResponse.json({ id }, { status: 201 });
}
