"""Runs stages 1-4 for one approval PDF and logs the job."""
from __future__ import annotations

import json
import os
import time

from .artwork import extract_artwork
from .indexer import Index, item_no_from_name, panels_from_name
from .pdfio import has_real_trimbox, open_page, page_geometry
from .specs import extract_specs, validate


def _specs_for(index: Index | None, path: str, log) -> dict:
    cached = index.cached_specs(path) if index else None
    if cached:
        log(f"specs: cached for {os.path.basename(path)}")
        return cached
    t = time.time()
    specs = extract_specs(path)
    log(f"specs: OCR {time.time() - t:.1f}s for {os.path.basename(path)}, {len(specs['issues'])} issue(s)")
    if index:
        index.store_specs(path, specs)
    return specs


def run_job(pdf_path: str, out_root: str, index: Index | None = None, job_dir: str | None = None, on_stage=None, reviewed_specs: dict | None = None) -> dict:
    """reviewed_specs: values the user confirmed in the form. They replace OCR and are validated again."""
    pdf_path = os.path.abspath(pdf_path)
    item_no = item_no_from_name(pdf_path) or "UNKNOWN"
    job_dir = job_dir or os.path.join(out_root, f"{time.strftime('%Y%m%d-%H%M%S')}_{item_no}")
    stage = on_stage or (lambda name: None)
    os.makedirs(job_dir, exist_ok=True)
    lines: list[str] = []

    def log(msg: str):
        lines.append(f"{time.strftime('%H:%M:%S')} {msg}")

    job: dict = {"input": pdf_path, "item_no": item_no, "job_dir": job_dir, "panels": {}, "warnings": []}
    log(f"job start: {pdf_path}")

    # Stage 2 + 3 for the uploaded sheet
    stage("specs")
    if reviewed_specs is not None:
        _doc, page = open_page(pdf_path)
        geo = page_geometry(page)
        issues = validate(reviewed_specs, geo.trim_w_mm, geo.trim_h_mm, has_real_trimbox(page))
        specs = {**reviewed_specs, "trimbox_mm": [round(geo.trim_w_mm, 3), round(geo.trim_h_mm, 3)], "confidence": {}, "issues": issues, "needs_review": bool(issues), "reviewed_by_user": True}
        log(f"specs: reviewed by the user, {len(issues)} issue(s) after validation")
    else:
        specs = _specs_for(index, pdf_path, log)
    job["specs"] = specs
    stage("artwork")
    main_panel = (panels_from_name(pdf_path) or ["front"])[0]
    w, h = specs.get("pouch_closed_width_mm"), specs.get("pouch_height_mm")
    art = extract_artwork(pdf_path, os.path.join(job_dir, main_panel), w, h)
    job["panels"][main_panel] = {"source": pdf_path, **art.to_json()}
    job["warnings"] += [f"{main_panel}: {x}" for x in art.warnings]
    log(f"artwork[{main_panel}]: method={art.method} texture={art.texture_mm} mm")

    # Stage 4: linked panels through the index
    stage("linking")
    for panel, code_key in (("back", "back_code"), ("gusset", "gusset_code")):
        if panel == main_panel:
            continue
        code = specs.get(code_key)
        if not code:
            job["warnings"].append(f"{panel}: no {code_key} in the remarks; a plain colour sampled from the {main_panel} will be used")
            job["panels"][panel] = {"source": None, "fallback_rgb": art.average_rgb}
            continue
        matches = index.lookup(code, panel) if index else []
        if not matches:
            job["warnings"].append(f"{panel}: linked file {code} is not in the indexed folder; a plain colour sampled from the {main_panel} will be used")
            job["panels"][panel] = {"source": None, "code": code, "fallback_rgb": art.average_rgb}
            log(f"link[{panel}]: {code} missing")
            continue
        linked = matches[0]["path"]
        lspecs = _specs_for(index, linked, log)
        if panel == "gusset":
            lw, lh = lspecs.get("pouch_closed_width_mm") or w, lspecs.get("gusset_full_width_mm") or specs.get("gusset_full_width_mm")
        else:
            lw, lh = lspecs.get("pouch_closed_width_mm") or w, lspecs.get("pouch_height_mm") or h
        lart = extract_artwork(linked, os.path.join(job_dir, panel), lw, lh)
        job["panels"][panel] = {"source": linked, "code": code, **lart.to_json()}
        job["warnings"] += [f"{panel}: {x}" for x in lart.warnings]
        log(f"link[{panel}]: {code} -> {os.path.basename(linked)} method={lart.method}")

    job["needs_review"] = bool(specs.get("needs_review"))
    if job["needs_review"]:
        job["warnings"].insert(0, "Specs need review before the 3D model is built: " + "; ".join(specs["issues"]))
    log(f"job done: needs_review={job['needs_review']} warnings={len(job['warnings'])}")

    with open(os.path.join(job_dir, "job.json"), "w", encoding="utf-8") as f:
        json.dump(job, f, indent=2, default=list)
    with open(os.path.join(job_dir, "job.log"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    with open(os.path.join(out_root, "jobs.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps({"time": time.time(), "input": pdf_path, "item_no": item_no, "job_dir": job_dir, "needs_review": job["needs_review"], "warnings": job["warnings"]}) + "\n")
    return job
