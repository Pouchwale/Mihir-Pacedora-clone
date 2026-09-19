// Server-side bridge to the local approval-PDF pipeline (pdf_pipeline/, Python, fully offline).
// A job = one folder: uploaded PDFs go to the shared library, the pipeline writes status.json,
// job.json, job.log and the textures into the job folder.
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

export const JOB_ID = /^[a-f0-9]{16}$/;
export const PANELS = ["front", "back", "gusset"] as const;
export const MAX_PDF_BYTES = 80 * 1024 * 1024;
export const MAX_FILES = 6;

function pipelineRoot(): string | null {
  for (const candidate of [path.join(process.cwd(), "pdf_pipeline"), path.join(process.cwd(), "..", "pdf_pipeline")]) {
    if (fs.existsSync(path.join(candidate, "pouchpdf"))) return candidate;
  }
  return null;
}

function pythonPath(root: string): string | null {
  for (const p of [path.join(root, ".venv", "Scripts", "python.exe"), path.join(root, ".venv", "bin", "python")]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function pipelineStatus(): { ready: true; root: string; python: string } | { ready: false; reason: string } {
  const root = pipelineRoot();
  if (!root) return { ready: false, reason: "The pdf_pipeline folder was not found next to the app." };
  const python = pythonPath(root);
  if (!python) return { ready: false, reason: "The PDF pipeline is not installed yet. Run setup from pdf_pipeline/README.md (python -m venv .venv, then pip install -r requirements.txt)." };
  return { ready: true, root, python };
}

export const paths = (root: string) => ({
  library: path.join(root, "output", "library"),
  jobs: path.join(root, "output", "webjobs"),
  db: path.join(root, "output", "web-index.sqlite"),
});

export const newJobId = () => randomBytes(8).toString("hex");

/** Keeps the item number and panel words, drops anything unsafe for a filename. */
export function safePdfName(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9 ._&()\-]/g, "_").replace(/\.+/g, ".").slice(0, 150);
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

export function jobDir(root: string, id: string): string | null {
  if (!JOB_ID.test(id)) return null;
  const dir = path.join(paths(root).jobs, id);
  return fs.existsSync(dir) ? dir : null;
}

export function readJson<T = any>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Starts the pipeline for a job in the background; progress is read from status.json. */
export function startJob(root: string, python: string, dir: string, mainPdf: string, reviewedFile?: string) {
  const p = paths(root);
  fs.mkdirSync(p.jobs, { recursive: true });
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ stage: "queued", time: Date.now() / 1000 }));
  const args = ["-m", "pouchpdf", "--db", p.db, "--out", p.jobs, "job", "--job-dir", dir, "--library", p.library, "--main", mainPdf];
  if (reviewedFile) args.push("--reviewed", reviewedFile);
  const log = fs.openSync(path.join(dir, "process.log"), "a");
  const child = spawn(python, args, { cwd: root, stdio: ["ignore", log, log], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  child.on("error", (err) => {
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ stage: "error", message: `Could not start the pipeline: ${err.message}` }));
  });
  child.on("exit", (code) => {
    const status = readJson<{ stage: string }>(path.join(dir, "status.json"));
    if (code !== 0 && status?.stage !== "error" && status?.stage !== "done") {
      fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ stage: "error", message: `The pipeline stopped unexpectedly (exit code ${code}). See process.log in the job folder.` }));
    }
  });
  child.unref();
}

/** What the browser gets: no absolute file paths. */
export function publicJob(id: string, dir: string) {
  const meta = readJson<any>(path.join(dir, "meta.json")) || {};
  const status = readJson<any>(path.join(dir, "status.json")) || { stage: "queued" };
  const job = status.stage === "done" ? readJson<any>(path.join(dir, "job.json")) : null;
  const panels: Record<string, any> = {};
  if (job?.panels) {
    for (const [name, p] of Object.entries<any>(job.panels)) {
      panels[name] = {
        available: !!p.source && !!p.web_jpg,
        sourceFile: p.source ? path.basename(p.source) : null,
        code: p.code ?? null,
        method: p.method ?? null,
        layersOff: p.layers_off ?? [],
        inksMasked: p.inks_masked ?? [],
        trimMm: p.trim_mm ?? null,
        bleedMm: p.bleed_mm ?? null,
        textureMm: p.texture_mm ?? null,
        fallbackRgb: p.fallback_rgb ?? null,
        averageRgb: p.average_rgb ?? null,
        warnings: p.warnings ?? [],
      };
    }
  }
  let log = "";
  try {
    log = fs.readFileSync(path.join(dir, "job.log"), "utf8").replace(/[A-Za-z]:\\[^\s]*\\/g, "");
  } catch {
    // no log until the job has finished
  }
  return {
    id,
    createdAt: meta.createdAt ?? null,
    files: meta.files ?? [],
    mainFile: meta.mainFile ?? null,
    stage: status.stage,
    error: status.message ?? null,
    itemNo: job?.item_no ?? meta.itemNo ?? null,
    specs: job?.specs ?? null,
    needsReview: job?.needs_review ?? false,
    warnings: job?.warnings ?? [],
    panels,
    log,
  };
}
