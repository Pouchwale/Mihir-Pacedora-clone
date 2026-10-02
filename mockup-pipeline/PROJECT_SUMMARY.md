# Pouch Mockup Pipeline — project summary (24-25 Sept 2026)

One-page history of what was asked, what was built, what was decided and where things stand.
Code lives in `mockup-pipeline/` (separate from the Next.js app at the repository root).

## 1. The brief

Build a production web system, deployed on Render, that turns artwork approval PDFs into
photoreal, dimensionally exact 3D pouch mockups:

    UPLOAD -> EXTRACT -> INDEX -> WORKFLOW -> 3D MOCKUP -> ADJUST -> RESULTS

Rules given at the start:
- No hard-coded dimensions or pouch types: everything comes from the PDF or from an admin-editable,
  versioned index (Postgres, YAML import/export).
- Stack: FastAPI, Pydantic v2, SQLAlchemy, Alembic, pypdf, poppler, PyMuPDF, Tesseract (offline OCR),
  React + Vite + TypeScript, three.js, Docker, Render (web + worker + Postgres + Key Value/RQ + S3/R2).
- All 9 pouch types: three side seal, centre seal pillow, centre seal side gusset, stand-up bottom
  gusset, flat bottom box, quad seal, spout, shaped die-cut, roll stock.
- Sample to match: FGPO7215 (Crystal Enterprises, 240 x 312 mm stand-up, 120 mm gusset, 10 mm seals,
  zipper, V notch, round corners, matt; layers 18 mic Matt BOPP / 12 mic Met PET / 75 mic Clear LDPE;
  inks C, M, Y, K, Sp White; back FGPO7216, gusset FGPO7233; TrimBox 244.475 x 320).
- Later revision: spec extraction must be offline (Tesseract) with an optional per-cell vision
  fallback (none / Claude / Grok, off by default); validation rules unchanged.
- Final instruction: "complete all phases perfectly, I will upload a PDF and check the 3D mockup".

## 2. What was built, phase by phase

| Phase | Scope | State |
|---|---|---|
| 1 | `trim_artwork` (bleed image, finished image +/- 0.5 mm, keyline-colour safety scan) and `extract_specs` (offline OCR of the spec table, ink dots, dieline measured from vector lines and confirmed by printed labels) | done, FGPO7215 extracts with zero review items |
| 2 | Index: pouch types, keyline templates (formulas, conditions, precedence), output presets, materials, PDF profile, validation rules, clients, item overrides; versioned with history/restore, YAML import/export, rule tester, admin UI | done |
| 3 | Workflow engine (11 steps, rerun from any step, NEEDS_REVIEW pause/resume with forms for specs, pouch type, keyline, panels, texture marks), jobs/uploads API, job pages, audit log, RQ queue or thread mode | done |
| 4 | Parametric three.js geometry for all 9 types (arc-length film rows: no stretched print, exact height), textures, alpha cut masks, dimension overlay, keyline SVG previews | done |
| 5 | Headless Playwright renders (PNG views, GLB, MP4 turntable) from the same scene as the viewer, exports, ZIP, `render.yaml`, Dockerfile | done; deploying needs the user's Render/GitHub/R2 accounts |
| 6 | Illustrator / PDFium PDFs without layers, combined sheets, roll form, plain-artwork fallback, exact colours, Pacdora-style Adjust panel | done |
| 7 (25 Sept) | Visual workflow editor + graph runner + live job canvas; indexing rulebook (field dictionary, pouch catalog, size rules, panel rules, material preview) | done (section 8c) |

Local run: `cd mockup-pipeline\backend; powershell -ExecutionPolicy Bypass -File run_local.ps1`,
then http://127.0.0.1:8765 (admin@example.com / change-me-please-1, local only). Port 8765 because
8000 is used by another program on this PC.

## 3. PDF formats handled (all automatic)

| Format | Example | How it is recognised | Result |
|---|---|---|---|
| ArtPro+ with layers | FGPO7215 Dog Food | layers Artwork / Dimensions and text / Dynamic Marks / Footer1, TrimBox = artwork + bleed | front only; back/gusset linked by "Back Code : FGPO7216" in Remarks; job asks for them or offers substitutes |
| Illustrator, no layers, one sheet with several panels | FGPO7535 Strawberry | no layers; dieline painted in the technical ink; live PDF text | sheet split by the table's sizes into front (0-210), gusset (213-293), back (296-506, printed upside down, turned upright); front chosen by less small print (5 vs 165 words); DONE in ~36 s, 120.65 x 210 mm |
| Illustrator, no layers, front only | FGPO6862 Korean Chilli | as above | asks for back FGPO6863 / gusset FGPO6864 |
| PDFium re-save, roll form | FGPO7138 Vadilal Pista Kulfi | no layers, outlined text, TrimBox outside the page (ignored), two print repeats, "White-1" plate, DeviceN mixes | roll stock: repeat 247.65 x 304 mm wraps the roll and lies on the web; the sachet's front/back are cut from one pouch blank (150 x 247.65 cell, fin 18 mm); DONE in ~3 min |
| Plain artwork, no dieline, no table | (any) | nothing technical found | pauses with a short details form (type, width, height, gusset); page = front, extra page size = bleed |
| Cover page + sheet with front and gusset, no back (25 Sept) | FGPO7404 Snacki Walnut | 2 pages: "STOP! read carefully" cover, then the sheet; labels "Standy+Zipper", "Bottom Gusset", layers without "mic" | artwork page picked automatically; front 217 x 295 and gusset 217 x 110 cut from the sheet; asks only for the back (or "same as front") |

Extraction facts verified today: FGPO7535 table read from live text (all values exact, incl. inks
C/M/Y/K/P 6053 C/White, layers 25 mic matt BOPP / 6.5 Foil / 12 pet / 60 LDPE, "Color match as per
old code FGPO3728" recognised as a reference, not a panel); FGPO7138 table read by OCR (247.65 mm,
57 / 150 mm, circumference 247.65, ups 1 / 2, B2B 322 / 304, inks C/M/Y/K/P352 C/P293 C/White,
gloss from Remarks); keyline of the FGPO7138 repeat 247.65 x 304.00 measured at the stroke centre.

## 4. The 3D mockup

- 1 three.js unit = 1 mm. Flat state = the pouch as manufactured, exactly the keyline size; filled
  state keeps the full width at the top seal and the full height, the body pulls in and gains depth
  (FGPO7215: 240 x 312 x 72 mm; FGPO7535: 120.65 x 210 x 48 mm; FGPO7138 sachet 57 x 247.65 x 41 mm).
- Every headless render records the built model's size; tests assert 240.00 x 312.00 and
  120.65 x 210.00 mm.
- Gusset artwork joins the front at its top edge; the stand-up base is built from the same profile as
  the faces; box types use a rounded-box section with tuck; spout mesh; shaped outline from an SVG
  field; roll stock = roll + unwound web + formed sachet at true size.
- Colours (user's choice today): `lighting: exact` on every preset — artwork drawn unlit, no tone
  mapping, lossless WebP textures, so each pixel is the print colour (a plain #3c78b4 panel renders
  as (60, 120, 180); tested). Studio looks (soft, hard, daylight, dramatic) selectable per job.

## 5. Adjust panel (Pacdora-style), added today

Beside the viewer on the job page; edits preview instantly, "Apply and re-render" reruns the job
from the first step the change affects, so PNG/GLB/MP4 match the viewer.
- Artwork per panel: source (automatic / a numbered sheet panel / same as front / plain colour /
  **your own picture or PDF**, fitted: fill, fit inside, stretch), swap front and back, turn 180
  (90 for square panels), mirror, flip, move (mm), scale. Placement travels as a texture transform
  (viewer, headless renders and GLB via KHR_texture_transform). Colour correction (brightness,
  contrast, saturation) and **logos and text** (any number per panel, dragged on the flat panel or
  positioned in mm, rotated, faded, ordered) are baked into the finished texture (section 8l).
- Size and shape: width, height, gusset (re-reads the sheet), seals, zipper/notch position, corner
  radius, fill level, bulge.
- Features: zipper on/off, tear notch type, butterfly notch, hang hole (type, size, position),
  transparent window with its region.
- Material and finish: matt/gloss, metallic film, plain-panel colour.
- Scene and views: exact colours or studio lighting, background (white / transparent / one colour /
  gradient), contact shadow, views to render. Snapshot PNG / transparent PNG of the current view.
- Stored per job (`inputs.adjust`, keyline overrides, spec corrections), logged with the operator's
  name; "Reset to automatic". Admins can save as the item's default (`item_override.adjustments`,
  versioned); later uploads of that item start from it. Endpoint: `POST /api/jobs/{id}/adjust`.

## 6. Decisions worth knowing

- Keyline precedence: item override > client override > pouch-type formula / pinned default >
  measured from the dieline > spec table > plain default.
- Missing linked panels -> NEEDS_REVIEW with upload or substitutes (back = front artwork, others =
  plain film in the front's dominant border colour).
- No zipper track drawn -> zipper placed mid zipper band (3rd band); a warning, not a stop.
- Files without layers: the dieline is removed from the page's content streams (a "no ink" tint
  would knock out white lines); the keyline-colour safety scan applies only to layered files
  (FGPO7138's technical ink is the artwork's own PANTONE 293 C).
- "NA" cells are valid blanks; a missing optional row in a template variant is a blank, not an error;
  the printer's logo noise words apply only to the Remarks row (client "… Ltd." keeps its Ltd).
- Roll form: repeat = circumference / around-ups, web = in-side B2B; checked as warnings.
- Seed changes ship as versions: `python -m app.cli seed-diff` / `seed-apply --reason "..."`.

## 7. Verification

- 177 backend tests pass (unit, OCR/table parsing, sheet layout, geometry, index, API, workflow
  end-to-end on all four PDFs with a stubbed renderer, and real headless renders checking model size
  and exact colours). Fixtures: FGPO7215, FGPO6862, FGPO7535, FGPO7138 (client artwork; nothing is
  committed to git yet).
- Live app checked today: FGPO7138 DONE (roll), FGPO7535 DONE, FGPO6862 waiting for panels;
  Adjust panel driven in headless Chromium: preview badge, apply -> DONE, reset -> DONE.
- Local jobs in the dev database: #1 FGPO7215 (waiting for a real gusset PDF; the file supplied
  earlier was a Crystal Reports cost report), #2/#3/#5 FGPO7535, #4 FGPO7138, #6 FGPO6862.

## 8. Problems found and fixed along the way (highlights)

Negative MediaBox origin in ArtPro+ files (use the transformation matrix); spec table spread over two
layers; OCR band cutting at table rules, ordered label matching, vertical labels, low-confidence codes
confirmed via the file registry; port 8000 in use; ACES washed the gold band; base sagging below the
floor; texture cache for viewer speed; PowerShell mojibake (never edit files with Set-Content); ffmpeg
faststart needs a temp file; pdftoppm's rounded page size leaving a white hairline (exact-size render);
Playwright sync API inside the event loop (worker thread); tests writing to the dev database (tests now
use a throwaway default DB; the admin password was restored).

## 8b. 25 Sept: the FGPO7404 upload

A review resume failed with `spec_table.layers.value: Input should be a valid list` (job 8): the
review form sent a blank list field as null. Fixed on both sides (blank list = empty list; a value
that cannot fit becomes a review item, never a FAILED job). The same file exposed four extraction
gaps, all fixed with tests: multi-page PDFs (cover page) now pick the artwork page; labels match whole
words only ("Standy+Zipper" is not the "Zipper?" label); "Bottom Gusset" matches "Bottom"; layers
without "mic" parse; the zipper band is the widest band under the top seal. Jobs 7 and 8 now wait
only for the back panel.

## 8c. 25 Sept: visual workflow editor and the indexing rulebook

You pasted a revised spec (ADMIN with an INDEXING rulebook, WORKFLOW as a visual editable
flowchart) and asked for "the needed parts only". Built and tested:

- **Workflows page** (React Flow canvas): node library START / PREPARE / DECISION / FETCH /
  VALIDATE / SET POUCH TYPE / RESOLVE KEYLINE / LINK PANELS / BUILD 3D / ARTWORK / RENDER /
  REVIEW / SUB-WORKFLOW / END; settings panel per node and per edge (conditions in the same
  language as the match rules, ELSE edges, order); draft vs published (publish = a new version of
  the index entry `workflow/default`, with history and restore); validation (one START, ELSE on
  every decision, every path ends, no cycles, no unreachable node, types / fields / sub-workflows
  must exist); auto-layout; **test mode** runs a PDF through the draft and lights up the path.
- **Graph runner** (`app/workflow/runner.py`): jobs walk the published graph; every run re-walks
  from START keeping finished steps, records the path (`job.workflow_path`), and pins the workflow
  version. FETCH pauses on the specs form, REVIEW pauses for a person (branch choice when several
  edges), SET POUCH TYPE beats the match rules (an operator's pick still wins). Rerun from any
  node. The job page has a **Workflow** tab: live canvas (green / amber / red / blue / grey), node
  inspector with steps, timings, outputs and images.
- **Seeded default workflow** = the spec's tree: PREPARE -> "Pouch or roll?" -> roll stock, or
  FETCH core fields -> "Which sealing type?" -> the matching type (else automatic) -> VALIDATE ->
  keyline -> panels -> 3D -> artwork -> render -> END. Jobs on the old fixtures take the same
  decisions as before (tests updated: FGPO7215 path recorded end to end).
- **Indexing**: Field dictionary (37 entries; labels, variants, options + synonyms, required,
  confidence, order; composes the OCR template; "Test with a PDF" shows every field's read and
  cell crop), Pouch catalog (Form -> Style -> Sealing type; the pouch type list is grouped by it,
  types carry default material / preset / picture), Size rules (standard sizes + tolerances in
  Validation rules: dimension +/- 2, seal +/- 3, open vs closed width), Panels & artwork rules on
  the PDF profile (Remarks names, fixed bleed, turn, mirror), Materials with a live preview sphere.
  One visible change from synonyms: "Standy+Zipper" is now stored as "Stand-up+Zipper".
- Intentionally left out of the pasted spec: Tailwind and Monaco (the app keeps its own CSS and a
  plain YAML editor). Migration 0003 (`kind`, `workflow_*`, `current_node` on jobs; `workflow_drafts`).

## 8d. 25 Sept, later: four new client PDFs uploaded while the workflow work landed

You uploaded FGPO7492 (Mango Slice F+B), FGPO7396 (Country Delight cookies), FGPO7442 (Euro-Flow)
and re-ran older files. What they exposed, and what was fixed (all with tests, 6 files re-checked):

- Tesseract crashed on a 33 000 px cell re-read ("Image too large") -> the re-read skips scales
  past Tesseract's 32 767 px limit.
- FGPO7492: the artwork copy and the technical preview share one long line, so no closed grid had
  one copy's extent -> a relaxed dieline search (pairs of equal lines with covered ends) finds both
  copies; the first (the artwork) is used. Its front and back sit 13 mm apart with no gusset panel
  -> the allowed gap between panels is now 20 mm (was 8); the job then asks for the gusset PDF or a
  substitute. Its closed width reads 151 for 131 (OCR); the sizes review catches it.
- FGPO7396: the spec table strip was chosen by area and cut the table in half -> strips are scored
  by table rules and live text. The sheet is two centre-seal blanks (170 x 108) -> new "blank"
  layout: front = middle 75 mm, back = the outer strips joined at the fin.
- A details / specs form left partly blank erased the read values -> a blank scalar is no
  correction.
- Jobs 13, 14, 17 failed with `'PouchType' object has no attribute 'default_output_preset'`: the old
  server process loaded a new step module against the old schema while the code was being
  replaced; harmless after the restart, the jobs were rerun.
- Still open: FGPO7442's dieline (the web's outer lines run past the corners by different lengths;
  a cell is picked instead of the web) -> the job stops at the sizes review with a clear message.

## 8e. 25 Sept, later still: the `phase1/` folder

You asked for a "phase 1" folder: any PDF in (not only ArtPro+), the details (height, width and the
rest) fetched from it, a dimensionally exact 3D pouch out, the existing indexing and workflow used,
the dieline out of scope. `mockup-pipeline/phase1/` holds:

- `run_phase1.py`: one command per PDF (or several). Starts the app if needed, publishes the phase-1
  workflow, uploads the PDF, follows the job, answers every pause (your `--details`, else what the
  operator types on the job page within `--wait` seconds, else the PDF's own artwork size and a flat
  three-side-seal pouch; missing panels get substitutes), saves renders / GLB / textures /
  `details.json` (values with confidence, what was assumed, pouch mm, measured model mm, workflow
  path, job URL) under `phase1/output/<ITEM>/`, and `--open` shows the 3D viewer.
- `workflow.yaml`: PREPARE -> FETCH details -> SET type by rules -> VALIDATE -> keyline -> panels ->
  3D -> artwork -> render (also seeded as `workflow/phase1`).
- `README.md`, and `backend/tests/test_phase1.py` (full table PDF, pillow blanks PDF, plain artwork
  PDF with PDF-derived defaults, command-line details).

## 8f. 25 Sept, night: pause / cancel, PDF text first, OCR optional, runner hardened

- **Jobs can be paused, resumed and cancelled** (job page header and the jobs list; API
  `POST /api/jobs/{id}/pause|resume|cancel`). Queued jobs stop at once, running ones after their
  current step (the worker checks between steps); what ran is kept; Resume continues, a rerun
  restarts a cancelled job. New statuses PAUSED / CANCELLED; migration 0004 (`jobs.control`). A
  review answer to a job that is no longer waiting is refused (409) instead of restarting it.
- **The PDF's own text is the reader; OCR is optional.** PyMuPDF's table finder turns a live-text
  spec table into label / value cells (`app/ocr/pdf_table.py`), which fill and cross-check the
  word-position reading; the dimension labels are taken from the text layer too. The PDF profile
  gained `ocr: auto | off | always` (UI on the profile page); with `off` Tesseract is never called
  (nor needs to be installed) and a file without a text layer pauses for the details. FGPO7535 reads
  completely with OCR off; FGPO7138 (outlined text) reads nothing with OCR off, as designed.
- **Phase 1 runner** fixed per the review: no infinite re-answering (a repeated question stops the
  PDF), enum spellings normalised (`standy`, `gusset_type=no`, `finish=Matt`), unknown `--details`
  keys and `--pouch-type` refused with the accepted lists, one failing PDF no longer aborts the
  batch, transport errors retried, `--details` applied even when the table is complete, all required
  fields answered at the first pause, gusset derived when only its type is known, weak reads listed
  as "confirmed", a print-sheet page never taken as a pouch size, workflow comparison that actually
  matches the published graph, output folders unique per job when the file has no item code.
- Tests: `test_job_control.py`, `test_pdf_reader.py`, `test_phase1.py` (12 tests incl. the operator
  wait window and the measured-model assertion).

## 8g. 25 Sept, late: the layered non-ArtPro uploads, FGPO7410's two ups, sizes set by hand

- **Layered files whose artwork is not on a layer called `Artwork`** (FGPO7002 / 7004, Adobe PDF
  library producer, layers `Layer 1`, `Layer 2`; FGPO5149 / 6443, no `Footer1`) were refused as
  `unexpected_producer` / `layer_missing`. Now a file with the dimension layer is read by its
  layers whatever the artwork layers are called: the layers that are not spec / dimension /
  eyemark layers are the artwork, and the differences are warnings in the job log
  (`app/pdf/sheet.py: artwork_layers_of, check_layers_pdf`). `layout_mode: layers` keeps the
  strict rules. A layered file without the dimension layer is read like a file without layers.
- **FGPO7410** (3 side seal 90.4875 x 130) is not a 2 x 2 grid but two ups across of a front +
  back web folded at its middle line, and the back's cut line at the bottom is not drawn (only its
  seal line and the bleed edge). `sheet_layout.detect` now allows n ups across (the first is used,
  `SheetLayout.ups`) and a last panel that ends on the bleed edge when the margin matches the one
  drawn at the start; such a guess ranks below any chain ending on a drawn line, which keeps
  FGPO7535 / FGPO7492 as they were.
- **A size the operator set wins over the drawing.** FGPO7215 with `--details height=300`: the
  dieline's finished artwork is 312 mm, so the texture step stopped with `finished_size`. Artwork
  cut at the dieline is now fitted to the operator's panel size with an `artwork_fitted` warning
  (only on an axis the operator set; an unexplained mismatch still stops the job).
- **Plain artwork page fixes**: the page-derived bleed was skipped when the page was a few
  micrometres smaller than the pouch (points are written to 3 decimals), so the template's 4 mm
  bleed was cut off a 160 x 240 page; the file-name item-code check is a warning on a plain page;
  the phase 1 runner reports only what each answer assumed (not the whole history again). With OCR
  off and outlined labels the dieline geometry stands at 0.9 instead of being held for review.
- Tests: `test_sheet_layout.py::test_two_ups_of_a_front_and_back_web`,
  `test_trim_artwork.py::test_renamed_artwork_layer_is_taken_from_the_other_layers`,
  `test_layered_file_without_the_dimension_layer_is_read_as_a_flat_file`; `test_phase1.py` green.

## 8h. 25 Sept, night: FGPO7165 (the 85 MB print layout) and FGPO7442

- **FGPO7165** (uploaded while the work above landed; 150 x 230 stand-up + zipper, gusset 90, an
  85 MB two-page sheet of 1682 x 536 mm): the dieline finder took a 149.75 x 28 mm fold-band cell
  as the dieline (the sheet is two copies of four ups of a front + back web, its cut edges drawn as
  pieces broken at every band line, so no closed grid spans a web), and every review re-run cost
  five minutes. Now `app/pdf/vector.py: line_networks` builds the network of crossing lines,
  drops what dimension lines cross, finds the repetition periods of the crossing points and cuts
  the copies apart where an empty strip of 30 mm or more separates them (ups that touch stay one
  copy for the sheet layout to split; a front and its back meet at a fold band; a panel's body has
  its own lines running through it). `analyse` takes the first copy (the artwork) when the closed
  grid found is a mere cell of it, and in every case measures the keyline on the fullest copy of
  that size, mapped onto the artwork copy (`Sheet.drawing_offset`): FGPO7165's and FGPO7410's
  artwork copies carry only part of their lines, the technical preview beside them has them all.
  Result: FGPO7165 = one copy of four ups (630 x 476 mm), the first up 150 x 230 twice with the 8 mm
  fold; FGPO7410 = two ups across, front and back; FGPO7442 = two copies apart, two 203 mm faces.
  `dieline()` counts a broken edge's pieces together (`_covered`), counts only lines inside the box
  it is asked about (the ups beside it share its heights, which used to leak a guide line into the
  front's body), and a bleed line 1.2 mm from the cut edge is no longer merged into it as a stroke
  outline.
- The upside-down heuristic now needs two extra bands below the body (one is a gusset seal).
- `sheet_panel_gap_max_mm` default 20 -> 30 (FGPO7165's fold band is 28 mm); a panel may start up
  to 25 mm inside the sheet box (dimension lines inflate a network box a little).
- The spec-table strip is chosen beside the artwork copy as well as the measured copy (the 700 mm
  artwork copy is no longer rendered into the table image), and the strips are scored by the
  table-sized rules they hold (40 mm or longer, not sheet-wide) rather than rules spanning 90 % of
  the strip: on FGPO7410 a single sheet-wide line in a 4 mm sliver above the drawing used to beat
  the table, and nothing was read. Strips thinner than 40 mm are never candidates. An ink dot
  whose label falls outside the table render is skipped (a round artwork element crashed
  `read_inks` on FGPO7165). The keyline is measured against the operator's corrected sizes, as the
  sheet layout already was.
- A rerun from ingest / trim / extract drops the operator's confirmations of the *old* keyline
  measurement (`measured_keyline.*` corrections): job 22 (FGPO7410) carried 69 mm bleeds confirmed
  when the whole 2-up sheet was taken for one panel, which then failed every trim check after the
  sheet was split correctly (two ups across, front and back found).
- Layered exports are split into panels too: FGPO5149 is a 181 x 498 mm front + back web on one
  TrimBox (was measured as one 245 mm panel with a 249 mm "bleed").
- Jobs keep the index versions they were created with: FGPO7442's job 12 still ran with pdf_profile
  v5 (panel gap 8 mm) and failed its layout until it was rerun on the latest index (the admin's
  "Rerun on the latest index" / `latest_index`). Older jobs of this test day need that once.
- Verified end to end on the live app with the phase 1 runner: FGPO7165 (job 36, DONE, gusset
  substituted) and FGPO7410 (job 38, DONE, model measured 90.49 x 130.00 mm); FGPO7442's job 12 on
  the latest index stops only for a weak circumference read.
- 26 Sept, FGPO7002 / FGPO7004 explained: FGPO7002's table text says height 265 mm (live PDF
  text, exact) while its dieline measures 264 mm (4 to 268 mm on a 272 mm TrimBox, width 10 + 170
  + 10 = 190 exactly). The file contradicts itself, so the job asks; nothing is misread. FGPO7004
  is not a pouch: it is the gusset sheet (two 190 x 110 gusset pieces side by side, table item
  FGPO7003), meant to be linked to its front, not run on its own.
- (earlier note) Still open after the reruns: FGPO7002 / FGPO7004 (layered, Adobe producer) read no height
  segments from their `Dimensions and text` layer (the dieline may sit on `Layer 2`); FGPO7004's
  table names FGPO7003 and an open width smaller than the closed width (OCR); the default
  workflow's Pouch details node holds FGPO5149 / FGPO6443 for a weak open width / gusset read, as
  designed. Extraction of the 85 MB FGPO7165 still takes about four minutes (two 300 dpi renders
  of a 1682 x 536 mm page).
- Tests: `tests/test_line_networks.py` (a synthetic 2 x 3 imposition with a frame, dimension lines
  and sheet-wide lines; a single web that must not split; FGPO7442 itself, now a 2 MB fixture:
  two copies, the first taken, two 203 mm faces with the 8 mm fold).

## 8i. 26 Sept: an AI model as the table reader (Groq)

- New setting `TEXT_READER` (`ocr` default, or `groq` / `claude` / `grok`) in `backend/.env`: an
  outlined spec table is read by the AI model in one call (`app/ocr/ai_table.py`), with Tesseract
  as the fallback when the call fails. Values pass the same format rules and score 0.93.
  `VISION_FALLBACK` gained `groq` (per weak cell, when Tesseract reads the table).
- Groq no longer offers the Llama 4 vision models; `qwen/qwen3.8-27b` reads images and is the
  default `GROQ_MODEL`.
- Measured: FGPO7215, FGPO7138, FGPO7442 tables read identically to Tesseract in 2.5 to 3.9 s
  instead of 22 to 24 s. The live FGPO7442 job's extraction step fell from 78 s to 52 s and the job
  finished DONE (Tesseract's weak circumference read had stopped it). The rest of the step is
  rendering, ink names and dimension labels, which the reader does not change.
- Tests: `tests/test_ai_table.py`; the test suite always runs with `TEXT_READER=ocr` and
  `VISION_FALLBACK=none`, so it never calls a paid API.
- Found while testing, from the 25 Sept dieline work: FGPO7404's keyline was measured on the pair
  of lines 216.63 mm apart instead of the exact 217.00 (both inside the 0.5 mm tolerance, the wrong
  one more centred), so its width segments went to review. Pairs are now ranked by how close they
  are to the size first, then by centring (`sheet_layout`, `keyline._finished_pair`), and the shift
  between two copies of a drawing is taken from their crossing points (`vector.copy_offset`), not
  from their boxes' corners.
- "Finished artwork is 180.97 x 120.59 mm, expected 180.97 x 245.0 mm" (FGPO5149, job 39): on a
  layered file the whole-sheet render is `<item>_front_bleed.png`, and the front panel cut from it
  was saved under the same name, so the back and every later cut read the 245 mm cut-out as the
  498 mm sheet. Panel cuts are now `<item>_<role>_cut.png`, and a cut refuses an image whose
  proportions do not match its sheet box (clear error, "rerun from trim_artwork") instead of
  producing a wrong size. Job 39 rerun: DONE, front and back 180.97 x 245 mm, model measured
  180.97 x 245.00 mm. Test: `test_cutting_panels_from_a_layered_sheet_leaves_the_sheet_render_alone`.

## 8j. 26 Sept: FGPO3970 / FGPO3974 (Vak Food namkeen), extract_specs fixed

- These sheets are ArtPro+ exports flattened by Adobe (no layers) carrying the front + back web
  (161.93 x 460 mm, faces joined at their tops, the brand face printed upside down), a separate
  white-ink gusset drawing under the table and a white-plate preview. The crossing-line network
  took web + gusset drawing + dimensions as one 446.59 x 480.38 mm "dieline", which also cut the
  spec table in half (17 weak fields). Fix: a TrimBox that is a real box on the page and has a
  dieline line on all four edges is the dieline (`sheet._declared_dieline`); of all the fixtures,
  only these files qualify, so nothing else changes.
- The zipper is a dashed line (dash pairs), now found as a zipper track (`vector._dashed_rows`); a
  drawn zipper in the lower half of a face means the face is drawn upside down
  (`_drawn_upside_down`). The front is chosen by counting readable words on each face both ways
  up (upside-down text made the brand face look like the back). A bleed of a few micrometres
  below zero (a TrimBox exactly on the dieline) is 0, not a keyline error.
- Job 43 (FGPO3970): DONE after the gusset was set to plain white (the sheet's "White Gusset"),
  faces 161.92 x 230 mm, model measured 161.93 x 230.00 mm, both faces upright. Job 44 (FGPO3974)
  reaches the same point and waits for its gusset choice. Test:
  `test_line_networks.py::test_trimbox_confirmed_by_the_dieline_wins` (fixture FGPO3970, 8.4 MB).
- Not changed: two unrelated drawings on a sheet without a usable TrimBox are still merged by the
  network step (a component split broke the FGPO7442 / imposition cases and was reverted).

## 8k. 26 Sept: no default window

- Every pouch whose table said `Transparent Window: Yes` got a window: the keyline template
  switched `window_enabled` on from that cell and then used the template's placeholder region
  (20, 60, 80 x 100 mm). The sheet never gives the window's position, so the placeholder was
  punched into real artwork. Now `window_enabled` defaults to off and no longer follows the table;
  a window is shown only when an item override (or the job page) sets it on with its region. Seed
  applied to the dev index as new keyline-template versions; jobs made before that need "Rerun on
  the latest index" once.

## 8l. 26 Sept: editing after the mockup (pictures, logos, text, features)

Asked for: "after creating the 3D mockup give options to change the pouch like Pacdora — changing
images after the keyline and many more features". Built on the existing Adjust panel:

- **A panel's artwork from an upload** (`POST /api/jobs/{id}/artwork`, PNG / JPEG / WebP / PDF,
  registered only; Apply reruns from `link_panels`). A picture becomes an `image` panel that the
  texture step fits to the exact panel size at the keyline's texture dpi (`panel_art.fit_image`:
  cover / contain over a colour / stretch). A PDF goes through the dieline path first
  (`_render_linked`); when it is not a dieline panel of that size, its page is fitted like a
  picture and the log says why. The front can be replaced too (its bleed then comes from the
  replacement, not the keyline). `GET /api/uploads/{id}/preview` serves a ≤ 2048 px preview for
  the page.
- **Overlays and colour correction** (`PanelAdjust.overlays`, `brightness/contrast/saturation`):
  drawn into the finished image by `app/workflow/panel_art.py` (Pillow; fonts Arial / Times /
  Courier → DejaVu / Liberation / Noto → Pillow's bundled font). Positions are mm from the panel's
  top-left; text size is the font size in mm. Works on every source (sheet-cut, linked PDF,
  picture, "same as front", plain film — a plain panel with a logo becomes a real image at dpi,
  roll sachet faces too). Only these changes rerun from `texture`.
- **Live preview without double drawing**: the texture step keeps the pre-bake web texture
  (`raw_web_key` → scene `raw_url`); the viewer bakes the draft on a canvas (`three/bake.ts`) from
  that, with CSS-equivalent colour filters, and applies the texture matrix on top. The panel's
  flat 2D editor in the Adjust panel (`PanelArtEditor`) lets the operator drag logos / text.
- **Features group**: zipper on/off (a `null` override disables it), tear notch type, butterfly,
  hang hole, window + region. `resolve_keyline` now lets an item / job override switch on a field
  whose `enabled_when` is false (a window on a pouch whose table says no window).
- **Scene**: one-colour and two-colour gradient backgrounds with pickers; viewer snapshot buttons
  (`Stage.capture`, 2x, optional transparent background).
- Tests: `test_panel_art.py` (fit modes, colour factors, overlay placement / clipping / rotation /
  opacity, text, fonts, previews), `test_adjust.py` (validation, merge, earliest step),
  `test_workflow.py::test_job_page_artwork_editing` (upload → picture back, logo + text on the
  front, PDF fallback, front replacement, reset, scene `files`).

## 9. Open items

- Deploy to Render: needs your GitHub push, Render workspace and an R2/S3 bucket
  (`mockup-pipeline/render.yaml`, steps in the README). No paid service has been created.
- Nothing is committed to git.
- Roll-form sachet orientation is a convention (text reads top to bottom); "Turn 180" fixes it per job.
- FGPO7442 (Euro-Flow) dieline recognition (section 8d): the outer web is not found, a cell is.
- Tailwind and Monaco from the revised spec were left out on purpose (own CSS, plain YAML editor).
