"""Phase 1: a dimensionally exact 3D pouch from ANY approval PDF, using the existing index and workflow.

    python phase1/run_phase1.py <pdf> [<pdf> ...] [--wait 120] [--details height=225 width=151 sealing="Stand-up" ...]
                                [--pouch-type stand_up_bottom_gusset] [--out phase1/output] [--open] [--no-start]

What it does
  1. Makes sure the local app is up (starts backend/run_local.ps1 when nothing answers on the local URL).
  2. Publishes the phase-1 workflow (phase1/workflow.yaml) into the index if it is missing or changed.
  3. Uploads the PDF as a job on that workflow and follows it: the spec table is read from the PDF's
     own text (words and table cells) wherever it is, OCR only if the profile allows it and the text
     layer gives nothing; the pouch type comes from the index's match rules; the 3D pouch is built to
     the table's height / width / gusset.
  4. When the PDF gives no usable details the job pauses on the details form. The runner answers it:
       - with the values you passed as --details,
       - else with what the operator types on the job page within --wait seconds,
       - else with defaults derived from the PDF (a plain page's size as the pouch size, a gusset of
         30 % of the width when a gusset type is known, a flat three-side-seal pouch otherwise),
     and lists every assumed or merely confirmed value in the summary and in details.json. Missing
     panels get substitutes (back = the front's artwork, gusset / sides a plain film colour). A pause
     the runner cannot answer (a value the schema rejects, a PDF the pipeline refuses, the same
     question coming back) stops that PDF with the reason and the job URL; the batch goes on.
  5. Saves the outputs under --out/<ITEM>/: renders (PNG views), the GLB, the turntable video, the
     keyline previews, the panel textures, and details.json (every value with its confidence and
     source, the geometry, the measured model size, the workflow path, the job URL). --open shows
     the job page with the interactive 3D viewer.

The client side needs only the standard library (PyYAML, when present, lets it compare
workflow.yaml with the published graph; without it the published graph is used as is).
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import mimetypes
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import webbrowser
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent  # mockup-pipeline/
WORKFLOW_KEY = "phase1"
WORKFLOW_FILE = HERE / "workflow.yaml"
LOCAL_SERVER = "http://127.0.0.1:8765"

# --details keys -> spec table fields (the review form's correction paths)
DETAIL_KEYS = {
    "height": "pouch_height_mm", "width": "pouch_closed_width_mm", "closed_width": "pouch_closed_width_mm",
    "open_width": "pouch_open_width_mm", "gusset": "gusset_full_width_mm", "gusset_width": "gusset_full_width_mm",
    "gusset_type": "gusset_type", "sealing": "sealing_type", "sealing_type": "sealing_type", "seal_width": "sealing_width_mm",
    "zipper": "zipper", "notch": "tear_notch", "tear_notch": "tear_notch", "round_corner": "round_corner",
    "window": "transparent_window", "client": "client_name", "item": "item_no", "item_no": "item_no", "form": "pouch_or_roll_form",
    "finish": "finish",
}
SPEC_FIELDS = {
    "client_name", "item_name", "item_no", "date_of_approval", "teeth", "circumference_mm", "inside_b2b_width_mm", "b2b_width_mm",
    "colour_count", "ar_ups", "ac_ups", "value_additions", "pouch_height_mm", "pouch_closed_width_mm", "pouch_open_width_mm",
    "pouch_or_roll_form", "sealing_type", "gusset_type", "gusset_full_width_mm", "zipper", "round_corner", "transparent_window",
    "sealing_width_mm", "tear_notch", "butterfly_notch", "finish", "raw_remarks",
}
NUMERIC = {"pouch_height_mm", "pouch_closed_width_mm", "pouch_open_width_mm", "gusset_full_width_mm", "sealing_width_mm", "teeth",
           "circumference_mm", "inside_b2b_width_mm", "b2b_width_mm", "colour_count", "ar_ups", "ac_ups"}
BOOLEAN = {"zipper", "round_corner", "transparent_window", "butterfly_notch"}
# Spellings people type -> what the spec sheet schema stores (case-insensitive lookup).
ENUM_SPELLINGS: dict[str, dict[str, str]] = {
    "gusset_type": {"none": "None", "no": "None", "na": "None", "n/a": "None", "nil": "None", "-": "None", "": "None",
                    "bottom": "Bottom", "btm": "Bottom", "bottom gusset": "Bottom", "side": "Side", "side gusset": "Side", "yes": "Yes"},
    "finish": {"matt": "matt", "matte": "matt", "gloss": "gloss", "glossy": "gloss", "matt+spot gloss": "matt+spot gloss",
               "matt + spot gloss": "matt+spot gloss", "spot gloss": "matt+spot gloss", "gloss+spot matt": "gloss+spot matt", "spot matt": "gloss+spot matt"},
    "sealing_type": {"stand-up": "Stand-up", "stand up": "Stand-up", "standup": "Stand-up", "standy": "Stand-up", "doypack": "Stand-up",
                     "stand-up+zipper": "Stand-up+Zipper", "standy+zipper": "Stand-up+Zipper", "stand up + zipper": "Stand-up+Zipper",
                     "3 side seal": "3 Side Seal", "three side seal": "3 Side Seal", "3ss": "3 Side Seal", "center seal": "Center Seal",
                     "centre seal": "Center Seal", "back seal": "Back Seal", "pillow": "Pillow", "side gusset": "Side Gusset",
                     "flat bottom": "Flat Bottom", "box pouch": "Box Pouch", "8 side seal": "8 Side Seal", "quad seal": "Quad Seal",
                     "4 side seal": "4 Side Seal", "spout": "Spout", "shaped": "Shaped", "na": "NA"},
    "tear_notch": {"v notch": "V Notch", "v-notch": "V Notch", "vnotch": "V Notch", "straight": "Straight Notch", "straight notch": "Straight Notch",
                   "laser": "Laser Score", "laser score": "Laser Score", "yes": "Yes", "no": "No", "na": "NA"},
    "pouch_or_roll_form": {"pouch": "Pouch Form", "pouch form": "Pouch Form", "roll": "Roll Form", "roll form": "Roll Form"},
}
# Structural checks only a person can judge; after the waiting time they are accepted so the pouch
# still comes out (they stay in the report).
AUTO_ACCEPT = {"trim_width", "trim_height", "keyline_vs_trimbox", "keyline_vs_spec", "sheet_layout", "item_no_mismatch", "filename_code",
               "linked_codes_unparsed", "finish_unparsed", "gusset_too_wide", "open_lt_closed", "zipper_not_drawn", "linked_code_format",
               "linked_code_self", "out_of_range"}
MAX_DEFAULT_SIDE_MM = 600  # a page bigger than this is a print sheet, not a pouch: no size default from it
FINAL = ("DONE", "FAILED", "CANCELLED", "PAUSED")


# ---------------------------------------------------------------- HTTP (stdlib only)
class ApiError(Exception):
    def __init__(self, status: int, payload: Any):
        text = payload if isinstance(payload, str) else json.dumps(payload)
        super().__init__(f"HTTP {status}: {text[:500]}" if status else f"connection: {text[:300]}")
        self.status, self.payload = status, payload


class Api:
    """Cookie-carrying JSON client for the app's API (the tests plug in FastAPI's TestClient instead)."""

    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def _send(self, method: str, path: str, data: bytes | None = None, content_type: str | None = None, timeout: float = 120) -> tuple[int, bytes, str]:
        headers = {"X-Requested-With": "fetch"}
        if content_type:
            headers["Content-Type"] = content_type
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=timeout) as r:
                return r.status, r.read(), r.headers.get("content-type", "")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), exc.headers.get("content-type", "") if exc.headers else ""
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ApiError(0, str(exc)) from exc

    @staticmethod
    def _payload(raw: bytes, ctype: str) -> Any:
        if "json" in ctype and raw:
            try:
                return json.loads(raw.decode())
            except ValueError:
                pass
        return raw.decode(errors="replace")

    def json(self, method: str, path: str, body: Any = None) -> Any:
        status, raw, ctype = self._send(method, path, json.dumps(body).encode() if body is not None else None, "application/json" if body is not None else None)
        payload = self._payload(raw, ctype)
        if status >= 400:
            raise ApiError(status, payload)
        return payload

    def upload(self, path: str, fields: dict[str, str], files: list[tuple[str, Path]]) -> Any:
        boundary = "----phase1" + uuid.uuid4().hex
        parts: list[bytes] = []
        for name, value in fields.items():
            parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode("utf-8"))
        for name, file in files:
            mime = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
            filename = file.name.replace('"', "'")
            parts.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n"
                          f"Content-Type: {mime}\r\n\r\n").encode("utf-8"))
            parts.append(file.read_bytes() + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        status, raw, ctype = self._send("POST", path, b"".join(parts), f"multipart/form-data; boundary={boundary}", timeout=600)
        payload = self._payload(raw, ctype)
        if status >= 400:
            raise ApiError(status, payload)
        return payload

    def download(self, path: str) -> bytes:
        status, raw, ctype = self._send("GET", path, timeout=600)
        if status >= 400:
            raise ApiError(status, self._payload(raw, ctype))
        return raw


# ---------------------------------------------------------------- the phase-1 run
class Stuck(RuntimeError):
    """The job cannot be finished by the runner; a person has to look at it."""


class Phase1:
    MAX_SAME_ANSWER = 2  # the same question coming back after an answer means the answer does not help
    MAX_POLL_FAILURES = 10

    def __init__(self, api: Api, out_dir: Path, wait_s: float = 120, details: dict[str, Any] | None = None,
                 pouch_type: str | None = None, log=print, poll_s: float = 3.0):
        self.api, self.out_dir, self.wait_s, self.poll_s, self.log = api, out_dir, wait_s, poll_s, log
        self.details = details or {}
        self.pouch_type = pouch_type
        self.assumed: dict[str, Any] = {}  # values the runner supplied because nobody else did
        self.confirmed: dict[str, Any] = {}  # weak reads the runner confirmed as they were
        self.answers: list[str] = []
        self.details_applied = False

    # -- setup
    def login(self, email: str, password: str) -> dict:
        return self.api.json("POST", "/api/auth/login", {"email": email, "password": password})

    def ensure_workflow(self) -> int:
        """Publish phase1/workflow.yaml unless the published version already equals it."""
        graph = load_yaml(WORKFLOW_FILE)
        try:
            current = self.api.json("GET", f"/api/workflows/{WORKFLOW_KEY}")
        except ApiError as exc:
            if exc.status != 404:
                raise
            current = None
        published = (current or {}).get("published")
        if graph is None:  # no PyYAML: the published graph is what runs
            if published:
                self.log("PyYAML is not installed: phase1/workflow.yaml was not compared with the published workflow")
                return published["version"]
            raise SystemExit("PyYAML is not installed and no phase1 workflow is published; run with backend/.venv's python once")
        if published and same_graph(published["graph"], graph):
            return published["version"]
        try:
            self.api.json("PUT", f"/api/workflows/{WORKFLOW_KEY}/draft", {"graph": graph})
            out = self.api.json("POST", f"/api/workflows/{WORKFLOW_KEY}/publish", {"reason": "phase 1 runner: publish phase1/workflow.yaml"})
        except ApiError as exc:
            if exc.status == 403 and published:  # an operator account: use what an admin published
                self.log(f"workflow {WORKFLOW_KEY} v{published['version']} differs from phase1/workflow.yaml; only an administrator can publish the file")
                return published["version"]
            raise
        version = out["published"]["version"]
        self.log(f"published workflow {WORKFLOW_KEY} v{version}")
        return version

    # -- the job
    def run_pdf(self, pdf: Path) -> dict:
        self.assumed, self.confirmed, self.answers, self.details_applied = {}, {}, [], False
        up = self.api.upload("/api/uploads", {"workflow": WORKFLOW_KEY, "name": f"phase 1: {pdf.name}"}, [("files", pdf)])
        job_id = up["jobs"][0]
        self.log(f"job #{job_id} started for {pdf.name}: {self.api.base}/jobs/{job_id}")
        try:
            job = self.follow(job_id)
            if self.details and not self.details_applied and job["job"]["status"] == "DONE":
                # the table gave everything, so no pause asked for the details: they still win
                self.api.json("POST", f"/api/jobs/{job_id}/adjust", {"adjust": {"specs": self.details}, "note": "phase 1 runner: --details"})
                self.details_applied = True
                self.note("details from the command line applied over the table's values")
                job = self.follow(job_id)
        except Stuck as exc:
            self.log(f"  !! {exc}")
            job = self.api.json("GET", f"/api/jobs/{job_id}")
            job["job"]["error"] = str(exc)
        report = self.save_outputs(job, pdf)
        return report

    def follow(self, job_id: int) -> dict:
        """Poll the job until it stops; answer every pause (after the waiting time, with defaults)."""
        waited_since: float | None = None
        last_review: str | None = None
        answered: dict[str, int] = {}
        failures = 0
        while True:
            try:
                d = self.api.json("GET", f"/api/jobs/{job_id}")
                failures = 0
            except ApiError as exc:
                failures += 1
                if failures > self.MAX_POLL_FAILURES or exc.status not in (0, 502, 503, 504):
                    raise
                time.sleep(min(30, 2 * failures))
                continue
            status = d["job"]["status"]
            if status in FINAL:
                return d
            if status == "NEEDS_REVIEW":
                review = d["review"] or {}
                details = review.get("details") or {}
                form = details.get("form")
                key = json.dumps([review.get("node"), review.get("step"), review.get("code"), sorted(f"{i.get('code')}@{i.get('field')}" for i in details.get("issues") or [])])
                if form is None:
                    raise Stuck(f"the pipeline cannot take this PDF as it is ({review.get('code')}: {review.get('message')})")
                if key != last_review:
                    last_review, waited_since = key, time.monotonic()
                    self.log(f"  paused at {review.get('node') or review.get('step')}: {review.get('message')}")
                    if form in ("specs", "details"):
                        need = [i["field"] for i in (details.get("issues") or []) if i.get("severity") == "review"]
                        self.log(f"  needs: {', '.join(need) or 'confirmation'} -> fill them on the job page, or wait {self.wait_s:g} s for the defaults")
                if self.answer_now(form) or time.monotonic() - (waited_since or 0) >= self.wait_s:
                    answered[key] = answered.get(key, 0) + 1
                    if answered[key] > self.MAX_SAME_ANSWER:
                        raise Stuck(f"the job keeps asking the same question after {self.MAX_SAME_ANSWER} answers: {review.get('message')}")
                    # answer what is there now, not a payload from before an operator's own answer
                    fresh = self.api.json("GET", f"/api/jobs/{job_id}")
                    if fresh["job"]["status"] == "NEEDS_REVIEW" and (fresh["review"] or {}).get("code") == review.get("code"):
                        self.answer(fresh)
                    last_review = None
            time.sleep(self.poll_s)

    def answer_now(self, form: str | None) -> bool:
        """No point waiting for an operator when the runner already has what the form asks for."""
        if form in ("specs", "details"):
            return bool(self.details) and all(k in self.details for k in ("pouch_height_mm", "pouch_closed_width_mm"))
        if form == "pouch_type":
            return bool(self.pouch_type)
        return form in ("panels", "texture", "workflow_review")  # substitutes / acknowledgements need no one

    def answer(self, d: dict) -> None:
        job_id, review = d["job"]["id"], d["review"]
        details = review.get("details") or {}
        form = details.get("form")
        issues = details.get("issues") or []
        if any(i.get("code") == "bad_correction" for i in issues):
            raise Stuck("a value was rejected by the spec sheet schema: " + "; ".join(f"{i['field']}: {i['message']}" for i in issues if i.get("code") == "bad_correction"))
        if form in ("specs", "details"):
            self.api.json("POST", f"/api/jobs/{job_id}/review", self.specs_answer(d))
        elif form == "pouch_type":
            self.api.json("POST", f"/api/jobs/{job_id}/review", {"action": "pouch_type", "pouch_type": self.pick_type(details), "note": "phase 1 runner"})
        elif form == "panels":
            choices = {m["role"]: ({"substitute": "front"} if m["role"] == "back" else {"substitute": "plain", "color": details.get("default_color") or "#dddddd"})
                       for m in details.get("missing", [])}
            self.note("panels: " + ", ".join(f"{r} = {c.get('substitute')}" for r, c in choices.items()))
            self.api.json("POST", f"/api/jobs/{job_id}/review", {"action": "panels", "panel_choices": choices, "note": "phase 1 runner: substitutes"})
        elif form == "texture":
            self.note("technical marks accepted as masked")
            self.api.json("POST", f"/api/jobs/{job_id}/review", {"action": "texture", "acknowledge": [f"{i['code']}@{i['field']}" for i in issues], "note": "phase 1 runner"})
        elif form == "keyline":
            fields = {i["field"].replace("keyline.", ""): None for i in issues}  # back to the template's values
            self.note("keyline values reset to the template")
            self.api.json("POST", f"/api/jobs/{job_id}/review", {"action": "keyline", "keyline_overrides": fields, "note": "phase 1 runner"})
        elif form == "workflow_review":
            choices = details.get("choices") or []
            self.api.json("POST", f"/api/jobs/{job_id}/review", {"action": "workflow_review", "node": details.get("node"),
                                                                   "edge": choices[0]["edge"] if choices else None, "note": "phase 1 runner: continued"})
        else:
            raise Stuck(f"{review.get('code')}: {review.get('message')}")

    def pick_type(self, details: dict) -> str:
        all_types = details.get("all_types") or {}
        candidates = details.get("candidates") or []
        if self.pouch_type:
            if all_types and self.pouch_type not in all_types:
                raise Stuck(f"--pouch-type {self.pouch_type!r} is not in the index; known: {', '.join(sorted(all_types))}")
            pick = self.pouch_type
        elif len(candidates) > 1 or not candidates:
            pick = "three_side_seal" if "three_side_seal" in (all_types or {"three_side_seal": 1}) else next(iter(candidates or all_types))
            self.assumed["pouch_type"] = pick
        else:
            pick = candidates[0]
            self.assumed["pouch_type"] = pick
        self.note(f"pouch type {pick}")
        return pick

    def specs_answer(self, d: dict) -> dict:
        """Corrections for the specs / details form: --details, then what was read, then defaults."""
        review = d["review"]
        details = review["details"]
        sheet = details.get("sheet") or {}
        table = sheet.get("spec_table") or {}
        measured = sheet.get("measured_keyline") or {}
        issues = details.get("issues") or []
        corrections: dict[str, Any] = {f"spec_table.{f}": v for f, v in self.details.items()}
        self.details_applied = self.details_applied or bool(self.details)
        value_of = lambda f: (table.get(f) or {}).get("value")  # noqa: E731
        known = lambda f: corrections.get(f"spec_table.{f}", value_of(f))  # noqa: E731
        need = {i["field"] for i in issues if i.get("severity") == "review" and i["code"] in ("missing", "low_confidence")}
        # every field a pouch needs, answered at the first pause so the job does not stop twice
        need |= {f for f in ("client_name", "item_no", "pouch_or_roll_form", "sealing_type", "gusset_type", "pouch_height_mm", "pouch_closed_width_mm")
                 if known(f) in (None, "", [])}
        pdf_w, pdf_h = self.default_size(d)
        gusset_kind = str(known("gusset_type") or "").lower()
        width = known("pouch_closed_width_mm")
        defaults: dict[str, Any] = {
            "pouch_closed_width_mm": pdf_w, "pouch_height_mm": pdf_h, "pouch_or_roll_form": "Pouch Form",
            "sealing_type": ("Stand-up+Zipper" if known("zipper") is True else "Stand-up") if gusset_kind in ("bottom", "yes") or (gusset_kind == "" and known("gusset_full_width_mm"))
            else "Side Gusset" if gusset_kind == "side" else "3 Side Seal",
            "gusset_type": "None" if not known("gusset_full_width_mm") else "Bottom",
            "gusset_full_width_mm": round(0.3 * float(width), 1) if gusset_kind in ("bottom", "side", "yes") and width else None,
            "client_name": Path(d["job"]["filename"]).stem.split("_")[0].replace("-", " ").strip() or "unknown",
            "item_no": d["job"].get("item_code") or re.sub(r"[^A-Za-z0-9]+", "", Path(d["job"]["filename"]).stem)[:12] or "ITEM",
        }
        assumed_now: dict[str, Any] = {}
        confirmed_now: dict[str, Any] = {}
        for field in sorted(need):
            if field.startswith("measured_keyline."):
                # a weak or missing measurement of the drawing: confirmed as measured (the keyline
                # falls back to the table / template values where the drawing gave nothing)
                name = field[len("measured_keyline."):]
                corrections.setdefault(field, (measured.get(name) or {}).get("value"))
                continue
            path = f"spec_table.{field}"
            if path in corrections:
                continue
            current = value_of(field)
            if current not in (None, "", []):
                corrections[path] = current  # read, only not confidently: confirmed as read
                confirmed_now[field] = current
                continue
            if field in defaults and defaults[field] is not None:
                corrections[path] = defaults[field]
                assumed_now[field] = defaults[field]
            else:
                corrections[path] = None  # nothing to read and no default: confirmed blank
        self.confirmed.update(confirmed_now)
        self.assumed.update(assumed_now)
        acknowledge = [f"{i['code']}@{i['field']}" for i in issues if i.get("severity") == "review" and i["code"] in AUTO_ACCEPT]
        if acknowledge:
            self.note("checks accepted: " + ", ".join(acknowledge))
        if confirmed_now:  # what this answer decided, not the whole job's history again
            self.note("confirmed as read (weak): " + ", ".join(f"{k} = {v}" for k, v in confirmed_now.items()))
        if assumed_now:
            self.note("assumed: " + ", ".join(f"{k} = {v}" for k, v in assumed_now.items()))
        return {"action": "specs", "corrections": corrections, "acknowledge": acknowledge,
                "note": "phase 1 runner: " + ("details from the command line" if self.details else "PDF-derived defaults")}

    def default_size(self, d: dict) -> tuple[float | None, float | None]:
        """The pouch size to assume when the table has none: a plain page's artwork size; a layered or
        dieline PDF's TrimBox minus its measured bleed; nothing when the page is a print sheet."""
        out = d.get("outputs") or {}
        extracted = out.get("extract_specs") or {}
        trim = out.get("trim_artwork") or {}
        w, h = trim.get("trim_width_mm"), trim.get("trim_height_mm")
        if not (w and h):
            return None, None
        if extracted.get("mode") in ("layers", "separation"):
            m = ((extracted.get("sheet") or {}).get("measured_keyline") or {})
            bleeds = [(m.get(k) or {}).get("value") for k in ("bleed_left_mm", "bleed_right_mm", "bleed_top_mm", "bleed_bottom_mm")]
            if all(isinstance(b, (int, float)) for b in bleeds):
                w, h = w - bleeds[0] - bleeds[1], h - bleeds[2] - bleeds[3]
        if max(w, h) > MAX_DEFAULT_SIDE_MM:
            raise Stuck(f"the PDF's artwork area is {w:.0f} x {h:.0f} mm, a print sheet rather than a pouch; pass --details height= width=")
        return round(float(w), 2), round(float(h), 2)

    def note(self, text: str) -> None:
        self.answers.append(text)
        self.log("  -> " + text)

    # -- outputs
    def save_outputs(self, d: dict, pdf: Path) -> dict:
        job = d["job"]
        job_id = job["id"]
        out = d.get("outputs") or {}
        stem = re.sub(r"[^A-Za-z0-9]+", "_", pdf.stem).strip("_")[:40]
        item = job.get("item_code") or (f"{stem}_job{job_id}" if stem else f"job{job_id}")
        folder = self.out_dir / item
        folder.mkdir(parents=True, exist_ok=True)
        for old in folder.iterdir():  # a rerun of the same item must not leave last time's files behind
            if old.is_file():
                old.unlink()
        saved: list[str] = []

        def grab(key: str | None, name: str) -> None:
            if not key:
                return
            try:
                data = self.api.download(f"/api/jobs/{job_id}/file?key={key}")
            except ApiError as exc:
                self.log(f"  (could not download {name}: {exc})")
                return
            (folder / name).write_bytes(data)
            saved.append(name)

        render = out.get("render") or {}
        for view, key in (render.get("views") or {}).items():
            grab(key, f"render_{view}.png")
        grab(render.get("glb_key"), f"{item}.glb")
        grab(render.get("mp4_key"), f"{item}_turntable.mp4")
        for role, t in ((out.get("texture") or {}).get("textures") or {}).items():
            grab(t.get("preview_key"), f"keyline_{role}.svg")
            grab(t.get("web_key"), f"texture_{role}.webp")
        sheet = (out.get("validate") or out.get("extract_specs") or {}).get("sheet") or {}
        geometry = (out.get("build_geometry") or {}).get("geometry") or {}
        keyline = (out.get("resolve_keyline") or {}).get("keyline") or {}
        wf = d.get("workflow") or {}
        report = {
            "pdf": pdf.name, "job_id": job_id, "job_url": f"{self.api.base}/jobs/{job_id}", "status": job["status"], "error": job.get("error"),
            "review": (d.get("review") or {}).get("message"),
            "pouch_type": job.get("pouch_type"),
            "text_source": (out.get("extract_specs") or {}).get("text_source"),
            "workflow": {"key": wf.get("key"), "version": wf.get("version"), "path": [(p["node"], p["status"], p.get("branch")) for p in wf.get("path", [])]},
            "details": {name: {"value": f.get("value"), "confidence": f.get("confidence")} for name, f in (sheet.get("spec_table") or {}).items() if isinstance(f, dict) and "value" in f},
            "measured_from_drawing": {name: f.get("value") for name, f in (sheet.get("measured_keyline") or {}).items() if isinstance(f, dict) and "value" in f},
            "assumed_by_runner": self.assumed, "confirmed_by_runner": self.confirmed, "runner_answers": self.answers,
            "pouch_mm": {k: geometry.get(k) for k in ("width_mm", "height_mm", "gusset_full_mm", "gusset_depth_mm", "template", "shape") if k in geometry},
            "keyline_mm": {k: (v or {}).get("value") for k, v in (keyline.get("fields") or {}).items()},
            "model_measured_mm": render.get("model_mm"),
            "files": saved,
        }
        (folder / "details.json").write_text(json.dumps(report, indent=1, default=str), encoding="utf-8")
        report["folder"] = str(folder)
        return report


# ---------------------------------------------------------------- helpers
def parse_details(items: list[str]) -> dict[str, Any]:
    """--details key=value pairs -> spec table corrections, spellings normalised, keys checked."""
    out: dict[str, Any] = {}
    for item in items:
        if "=" not in item:
            raise SystemExit(f"--details expects key=value, got {item!r}")
        key, value = item.split("=", 1)
        k = key.strip().lower()
        field = DETAIL_KEYS.get(k, k)
        if field not in SPEC_FIELDS:
            raise SystemExit(f"--details: unknown key {key!r}; use one of {', '.join(sorted(DETAIL_KEYS))} or a spec table field name")
        v: Any = value.strip().strip('"').strip("'")
        if field in NUMERIC:
            try:
                v = float(v.lower().replace("mm", "").strip())
            except ValueError as exc:
                raise SystemExit(f"--details {key}: {value!r} is not a number") from exc
        elif field in BOOLEAN:
            v = v.lower() in ("1", "true", "yes", "y")
        elif field in ENUM_SPELLINGS:
            v = ENUM_SPELLINGS[field].get(" ".join(v.lower().split()), v)
        out[field] = v
    return out


def load_yaml(path: Path) -> dict | None:
    try:
        import yaml
    except ImportError:
        return None
    return yaml.safe_load(path.read_text(encoding="utf-8"))


NODE_DEFAULTS: dict[str, Any] = {"label": "", "question": "", "fields": [], "pouch_type": None, "message": "", "workflow": None, "notes": ""}
FIELD_DEFAULTS: dict[str, Any] = {"required": True, "min_confidence": None}
EDGE_DEFAULTS: dict[str, Any] = {"label": "", "when": [], "otherwise": False, "order": 0}


def same_graph(a: dict, b: dict) -> bool:
    """Same nodes and edges. The server stores every field with its default filled in and lays out
    the positions, the YAML file leaves defaults out: compare with defaults filled and positions dropped."""
    def canon(g: dict) -> dict:
        nodes = []
        for n in g.get("nodes", []):
            node = {**NODE_DEFAULTS, **{k: v for k, v in n.items() if k != "position"}}
            node["fields"] = [{**FIELD_DEFAULTS, **f} for f in node.get("fields") or []]
            nodes.append(json.dumps(node, sort_keys=True))
        edges = []
        for e in g.get("edges", []):
            edge = {**EDGE_DEFAULTS, **e}
            edge["when"] = [{"all": [{"value": None, **c} for c in grp.get("all", [])]} for grp in edge.get("when") or []]
            edges.append(json.dumps(edge, sort_keys=True))
        return {"name": g.get("name"), "description": g.get("description", ""), "nodes": sorted(nodes), "edges": sorted(edges)}

    return canon(a) == canon(b)


def server_up(base: str) -> bool:
    try:
        with urllib.request.urlopen(base.rstrip("/") + "/api/health", timeout=3) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001
        return False


def start_server(base: str, log=print) -> None:
    script = ROOT / "backend" / "run_local.ps1"
    log(f"nothing answers on {base}; starting {script.name} (first start builds the UI and migrates the database)")
    creation = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
    proc = subprocess.Popen(["powershell", "-ExecutionPolicy", "Bypass", "-File", str(script)], cwd=str(script.parent), creationflags=creation)
    for _ in range(120):
        if server_up(base):
            return
        if proc.poll() is not None:
            raise SystemExit(f"{script.name} exited with code {proc.returncode} before the app answered; run it by hand to see why")
        time.sleep(2)
    raise SystemExit("the app did not come up in 4 minutes; start backend/run_local.ps1 by hand and rerun")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Phase 1: a dimensionally exact 3D pouch from any approval PDF")
    p.add_argument("pdfs", nargs="+", type=Path)
    p.add_argument("--server", default=os.environ.get("PHASE1_SERVER", LOCAL_SERVER))
    p.add_argument("--email", default=os.environ.get("ADMIN_EMAIL", "admin@example.com"))
    p.add_argument("--password", default=os.environ.get("ADMIN_PASSWORD", "change-me-please-1"))
    p.add_argument("--wait", type=float, default=120, help="seconds to wait for an operator on the job page before the runner answers a pause itself")
    p.add_argument("--details", nargs="*", action="extend", default=[], help="pouch details as key=value: height width open_width gusset gusset_type sealing zipper notch client item finish")
    p.add_argument("--pouch-type", default=None, help="index key to use when the match rules cannot decide (default: three_side_seal / the first candidate)")
    p.add_argument("--out", type=Path, default=HERE / "output")
    p.add_argument("--open", action="store_true", help="open the job page (3D viewer) in the browser when done")
    p.add_argument("--no-start", action="store_true", help="do not start the app when nothing answers on --server")
    args = p.parse_args(argv)

    if not server_up(args.server):
        if args.no_start or args.server.rstrip("/") != LOCAL_SERVER:
            raise SystemExit(f"nothing answers on {args.server}")
        start_server(args.server)
    api = Api(args.server)
    runner = Phase1(api, args.out, wait_s=args.wait, details=parse_details(args.details), pouch_type=args.pouch_type)
    try:
        runner.login(args.email, args.password)
        runner.ensure_workflow()
    except ApiError as exc:
        raise SystemExit(f"cannot start: {exc}") from exc
    failures = 0
    for pdf in args.pdfs:
        if not pdf.exists():
            print(f"!! {pdf} does not exist")
            failures += 1
            continue
        try:
            report = runner.run_pdf(pdf)
        except (ApiError, Stuck, OSError) as exc:
            print(f"\n== {pdf.name}: could not be processed: {exc}")
            failures += 1
            continue
        print(summary(report))
        if report["status"] != "DONE":
            failures += 1
        elif args.open:
            webbrowser.open(report["job_url"])
    return 1 if failures else 0


def summary(r: dict) -> str:
    mm = r.get("pouch_mm") or {}
    measured = (r.get("model_measured_mm") or {}).get("flat") or {}
    lines = [f"\n== {r['pdf']}: {r['status']}" + (f" ({r['error']})" if r.get("error") else "") + (f" - {r['review']}" if r.get("review") else "")]
    if mm:
        lines.append(f"   pouch type   : {r.get('pouch_type')}")
        lines.append(f"   pouch (mm)   : {mm.get('width_mm')} x {mm.get('height_mm')}" + (f", gusset {mm.get('gusset_full_mm')}" if mm.get("gusset_full_mm") else "") + f"  [{mm.get('template')}]")
    if measured:
        lines.append(f"   3D model (mm): {measured.get('x'):.2f} x {measured.get('y'):.2f} flat")
    det = r.get("details") or {}
    if det:
        lines.append(f"   read from    : {r.get('text_source')}")
    for k in ("client_name", "item_no", "sealing_type", "gusset_type", "pouch_height_mm", "pouch_closed_width_mm", "pouch_open_width_mm", "gusset_full_width_mm", "zipper"):
        if k in det:
            v = det[k]
            tag = "  <- assumed by the runner" if k in (r.get("assumed_by_runner") or {}) else "  <- weak read, confirmed by the runner" if k in (r.get("confirmed_by_runner") or {}) else ""
            lines.append(f"   {k:22s}: {v['value']}  ({(v['confidence'] or 0):.2f}){tag}")
    if r.get("runner_answers"):
        lines.append("   runner answered: " + " | ".join(r["runner_answers"]))
    lines.append(f"   files        : {r.get('folder')} ({len(r.get('files') or [])} files)")
    lines.append(f"   3D viewer    : {r['job_url']}")
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main())
