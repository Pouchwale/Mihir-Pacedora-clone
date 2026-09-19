import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { authorizeJob } from "@/lib/pdfJobAuth";
import { paths, publicJob, readJson, startJob } from "@/lib/pdfPipeline";
import { readJson as readBody } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const auth = await authorizeJob(params.id);
  if (auth.error) return auth.error;
  return NextResponse.json(publicJob(params.id, auth.dir));
}

const NUMBER_FIELDS = ["pouch_height_mm", "pouch_closed_width_mm", "pouch_open_width_mm", "gusset_full_width_mm", "sealing_width_mm"];
const BOOL_FIELDS = ["zipper", "round_corner", "butterfly_notch", "transparent_window"];
const TEXT_FIELDS = ["client_name", "item_name", "item_no", "date_of_approval", "pouch_or_roll_form", "sealing_type", "gusset_type", "tear_notch", "finish", "back_code", "gusset_code"];

// PUT: the user reviewed the specs in the form -> run the job again with those values
export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const auth = await authorizeJob(params.id);
  if (auth.error) return auth.error;
  const current = readJson<any>(path.join(auth.dir, "status.json"));
  if (current && !["done", "error"].includes(current.stage)) {
    return NextResponse.json({ message: "This job is still running" }, { status: 409 });
  }
  const parsed = await readBody(request, 64 * 1024);
  if (parsed.error) return parsed.error;
  const input = parsed.body?.specs;
  if (!input || typeof input !== "object") return NextResponse.json({ message: "Missing specs" }, { status: 400 });

  const specs: Record<string, unknown> = {};
  for (const key of NUMBER_FIELDS) {
    const v = input[key];
    if (v === null || v === "" || v === undefined) {
      specs[key] = null;
      continue;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > 5000) return NextResponse.json({ message: `${key} must be a positive number` }, { status: 400 });
    specs[key] = n;
  }
  for (const key of BOOL_FIELDS) specs[key] = input[key] === true ? true : input[key] === false ? false : null;
  for (const key of TEXT_FIELDS) {
    const v = input[key];
    specs[key] = typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null;
  }
  if (specs.finish && !["matt", "gloss"].includes(String(specs.finish))) {
    return NextResponse.json({ message: "finish must be matt or gloss" }, { status: 400 });
  }
  for (const key of ["back_code", "gusset_code"]) {
    if (specs[key] && !/^FGPO\d+$/i.test(String(specs[key]))) return NextResponse.json({ message: `${key} must look like FGPO1234` }, { status: 400 });
    if (specs[key]) specs[key] = String(specs[key]).toUpperCase();
  }
  specs.layers = Array.isArray(input.layers)
    ? input.layers.filter((l: unknown) => typeof l === "string" && l.trim()).slice(0, 6).map((l: string) => l.trim().slice(0, 80))
    : [];

  const reviewedFile = path.join(auth.dir, "reviewed.json");
  fs.writeFileSync(reviewedFile, JSON.stringify(specs));
  startJob(auth.status.root, auth.status.python, auth.dir, path.join(paths(auth.status.root).library, auth.meta.mainFile), reviewedFile);
  return NextResponse.json({ ok: true });
}
