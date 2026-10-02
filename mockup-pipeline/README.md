# Pouch mockup pipeline

Turns artwork approval PDFs (ArtPro+ exports with layers; Adobe Illustrator and PDFium re-saves
without layers, including sheets that carry front + gusset + back together and roll-form repeats;
plain artwork with a details form) into 3D pouch mockups in exact print colours, with Pacdora-style
adjustments on the job page: UPLOAD -> EXTRACT -> INDEX -> WORKFLOW -> 3D MOCKUP -> ADJUST -> RESULTS.

This is a separate service from the Next.js app in the repository root.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | `trim_artwork` + `extract_specs` (offline OCR) on the sample PDF | done, sample passes with no review items |
| 2 | Index data model, seed YAML, admin UI | done |
| 3 | Workflow engine, job pages, NEEDS_REVIEW flow | done |
| 4 | Geometry + 3D for all 9 pouch types, keyline preview | done |
| 5 | Server-side renders (PNG/GLB/MP4), exports, `render.yaml` | done; deploying needs your Render account (see below) |
| 6 | Illustrator / roll-form / plain PDFs, exact colours, Adjust panel | done |
| 7 | Visual workflow editor (graph, drafts, test mode, live path) and the indexing rulebook (field dictionary, catalog, size rules, panel rules, material preview) | done |

## Phase 1 folder: a pouch from any PDF, one command

`mockup-pipeline/phase1/` is the focused deliverable for "any PDF in, dimensionally exact 3D pouch
out": `backend\.venv\Scripts\python phase1\run_phase1.py <pdf> --open`. It publishes its own
workflow (`phase1/workflow.yaml`) into the index, reads the details from the PDF's table (or takes
yours, or the operator's within a waiting time, or the PDF's own artwork size), builds the pouch
with the index's pouch types and keylines, and saves renders, GLB and `details.json` under
`phase1/output/<ITEM>/`. See `phase1/README.md`.

## Quick start (Windows, everything local)

```powershell
cd mockup-pipeline\backend
powershell -ExecutionPolicy Bypass -File run_local.ps1
```

Open http://127.0.0.1:8765, sign in as `admin@example.com` / `change-me-please-1` (local only;
set `ADMIN_EMAIL` / `ADMIN_PASSWORD` before the first start to choose your own), then
**Upload** → drop the front PDF (and its back / gusset PDFs if you have them) → the job page
shows each step live. A PDF whose sheet carries front, gusset and back together (e.g.
FGPO7535) needs nothing else: the panels are cut from it. If linked panels are missing, the
review asks for them or offers substitutes. When the job is done: 3D viewer (orbit, views, filled / flat, dimensions),
renders, GLB, keyline previews, specs with confidence, and **Download all (ZIP)**.

The run script uses SQLite and runs jobs in a background thread (no Redis). Port 8765 because
another local service already uses 8000 on this PC.

## Run Phase 1 locally (Windows)

Needs poppler (`pdftoppm`) and Tesseract 5 with English data. No API key: extraction is offline.

```powershell
cd mockup-pipeline\backend
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
$env:POPPLER_BIN = "C:\path\to\poppler\Library\bin"
$env:TESSERACT_CMD = "C:\Program Files\Tesseract-OCR\tesseract.exe"
$env:PYTHONPATH = "."
.venv\Scripts\python -m app.cli phase1 tests\fixtures\FGPO7215_Dog_Food_Front_App.pdf
.venv\Scripts\python -m pytest -q
```

Outputs in `.work/phase1/<item>/`: `<item>_<panel>_bleed.png`, `<item>_<panel>_finished.png`,
`<item>_<panel>_technical_marks.png` (only when marks were found), `spec_table.png`,
`dimensions.png`, `phase1_report.json`. `--eyemarks` renders the eyemark layer into the texture.

The Docker image (Phase 5) installs `poppler-utils`, `tesseract-ocr` and `tesseract-ocr-eng`.

## Run the API and admin UI locally

```powershell
cd mockup-pipeline\backend
$env:PYTHONPATH = "."
$env:DATABASE_URL = "sqlite:///./.work/dev.db"      # or postgresql://user:pass@host/db
$env:ADMIN_EMAIL = "you@company.com"; $env:ADMIN_PASSWORD = "at-least-10-chars"
.venv\Scripts\alembic upgrade head                   # migrations (also run on every deploy)
.venv\Scripts\python -m app.cli bootstrap            # first admin + seed index (only if empty)
.venv\Scripts\python -m uvicorn app.api.main:app --port 8765

cd ..\frontend
npm install
npm run dev        # http://localhost:5173 (proxies /api to :8765)
npm run build      # dist/ is then served by the API at http://localhost:8765
```

## Workflow (spec 4): a flowchart the admin edits

What happens to a job is a **graph**, edited on a canvas (**Workflows** in the sidebar, React
Flow). Nodes come from a fixed library; every executing node stands for engine steps:

| Node | Does | Engine steps |
|---|---|---|
| START | the uploaded PDF | |
| PREPARE | checks the PDF, separates artwork from drawing, reads the table and dimension lines | `ingest`, `trim_artwork`, `extract_specs` |
| DECISION | follows the first outgoing edge whose conditions hold, else the ELSE edge | |
| FETCH | names the fields this branch needs; a missing required one or one below its confidence pauses on the specs form | |
| VALIDATE | size rules and cross-checks | `validate` |
| SET POUCH TYPE | assigns a type from the catalog, or "automatic" (match rules) | `match_pouch_type` |
| RESOLVE KEYLINE / LINK PANELS / BUILD 3D / ARTWORK / RENDER | as their names say | `resolve_keyline` / `link_panels` / `build_geometry` / `texture` / `render` + `export` |
| REVIEW | pauses for a person; with several labelled edges the reviewer picks the branch | |
| SUB-WORKFLOW | runs another published workflow, then continues | |
| END | results | |

The engine steps keep their dependency order (`ingest -> trim_artwork -> extract_specs -> validate
-> match_pouch_type -> resolve_keyline -> link_panels -> build_geometry -> texture -> render ->
export`, one module per step in `app/workflow/steps/`, typed outputs in `job_steps`); a node runs
its steps and, first, any earlier step that has not run yet, so the canvas order can differ from
the engine's and the outputs stay consistent. Decisions read `spec.*` (the extracted fields with
the operator's corrections), `measured.*`, `job.mode` / `job.roll_form` / `job.repeats` /
`job.layout` / `job.client` ..., `panels`, `linked_codes.*` and, once resolved, `keyline.*`,
with the same condition language as the match rules.

- **Draft vs published.** Edits are saved as a draft (`workflow_drafts`); **Publish** validates and
  writes a new version of the index entry `workflow/<key>` (history, diff, restore like every
  index kind). Jobs run the published `default` workflow and pin the version they ran; test runs
  and sub-workflows use other keys.
- **Validation** refuses to publish when a graph has no or several STARTs, a DECISION without an
  ELSE edge or with a condition-less edge, a node with no way to END or REVIEW, a cycle, an
  unreachable node, a SET POUCH TYPE naming a type that is not in the catalog, a FETCH naming a
  field that is not in the dictionary, or a SUB-WORKFLOW naming an unpublished workflow. The
  problems are listed; the index refuses the same graph on import.
- **Test mode** runs a PDF through the graph as it is on the canvas: a test job (kept out of the
  jobs list) walks it and the path lights up; a REVIEW node pauses it like any job.
- **Live view.** The job page's **Workflow** tab shows the job's graph with the path it took
  (green passed, amber paused for review, red failed, blue running, grey not visited); click a
  node for its steps and timings, outputs and images; **Rerun from this node** redoes everything
  from that node's first step (a REVIEW node asks again).
- **Seeded default** (`app/index/seed/index.yaml`, `workflow/default`): PREPARE -> "Pouch or
  roll?" -> (roll: SET roll stock) / (FETCH sealing type, gusset, width, height -> "Which sealing
  type?" -> SET the matching type, else SET automatic) -> VALIDATE -> RESOLVE KEYLINE -> LINK PANELS
  -> BUILD 3D -> ARTWORK -> RENDER -> END.

Jobs are `QUEUED`, `RUNNING`, `NEEDS_REVIEW`, `FAILED` or `DONE`. A step or node that cannot trust
its input pauses the job with a review form; the operator's fix is stored on the job and the job
walks the graph again, keeping every finished step:

| Review | Raised by | Operator action |
|---|---|---|
| spec values | validate (low confidence, failed checks), FETCH nodes | confirm / correct each field (cell crop shown), accept structural checks |
| pouch type | match_pouch_type (no or several matches) | type picker |
| keyline | resolve_keyline (value out of range, bad formula) | per-job values |
| missing panels | link_panels | upload the PDF (also from the Upload page: waiting jobs resume) or a substitute |
| technical marks | texture (keyline colour on the artwork) | check the magenta preview, accept the masked texture |
| workflow review | REVIEW nodes | continue, or pick the branch; a note goes to the log |

Any step can be rerun from the Steps tab, any node from the Workflow tab (steps are idempotent).
Admins can re-render on the latest index versions; every job stores the index versions it used
(`index_snapshot`) and its workflow version, so an old job re-renders identically. The Log tab and
`GET /api/jobs/<id>/audit` hold the audit: input SHA-256s, extracted and corrected specs, pouch
type and version, keyline version, workflow key / version / path, outputs, who approved. Batch
mode: upload many PDFs or a ZIP; every PDF whose name contains "front" becomes a job, the others
are registered by item code and linked through the Remarks codes. With more than one published
workflow the Upload page lets you pick one.

## Adjustments on the job page (Pacdora-style controls)

Next to the 3D viewer, **Adjust** previews changes instantly and **Apply and re-render** reruns the
job from the first step they change, so the PNG renders, GLB and video match the viewer:

- **Artwork per panel**: which artwork a panel shows (automatic, a numbered panel of the sheet,
  the front's artwork, a plain colour, **or a picture / PDF of your own**), swap front and back,
  turn 180 (90 for square panels), mirror / flip, move (mm) and scale. Placement travels as a
  texture transform: the viewer, the headless renders and the GLB (`KHR_texture_transform`) apply
  the same numbers.
  - *Use my own picture / PDF…* uploads a PNG, JPEG, WebP or PDF page for that panel (the front
    too) and fits it: fill the panel (crop), fit inside (over a colour), or stretch. A PDF whose
    TrimBox is a dieline panel of the right size (e.g. the real back-panel approval PDF) is cut at
    its dieline instead, exactly as a linked panel; anything else is fitted like a picture and
    the log says so. Uploads go to `POST /api/jobs/{id}/artwork` (registered only; **Apply**
    reruns the job).
  - *Colour correction*: brightness, contrast, saturation (−100..100; the same factors as the CSS
    preview).
  - *Logos and text*: any number of overlays per panel. **+ Text** (size in mm, sans / serif /
    mono, bold, colour, alignment, optional box) and **+ Logo / picture…** (width in mm, height
    optional). Drag them on the flat panel shown under the buttons, or type positions in mm from
    the panel's top-left corner; rotate freely, set opacity, order them. The texture step bakes
    them into the finished image (`app/workflow/panel_art.py`), so the renders, the GLB and the
    keyline preview all carry them; the page previews on the texture *before* the bake
    (`raw_url`), so nothing is drawn twice.
- **Size and shape**: width, height and gusset (the sheet is re-read, since these cut the panels);
  seals, zipper and notch position, corner radius, fill level and bulge (instant).
- **Features**: zipper on / off, tear notch type, butterfly notch, hang hole (type, size,
  position) and a **transparent window** with its region (from left / top, width, height, corner
  radius). These are keyline overrides; an explicit job or item value switches a field on even
  when the spec table would disable it (a window on a pouch whose table says "no window").
- **Material and finish**: matt / gloss, metallic film where unprinted, plain-panel colour.
- **Scene and views**: exact print colours or a studio lighting look, background (white studio,
  transparent, one colour, gradient with two colours), contact shadow, which views to render.
- **Snapshots**: under the viewer, **Snapshot PNG** / **Transparent PNG** save the current view
  (camera, filled or flat, unapplied edits included) at twice the screen size.

Everything is stored on the job (`inputs.adjust`, `keyline_overrides`, `spec_corrections`), shown
in the log with the operator's name, and undone with **Reset to automatic**. An admin can tick
**save as default for &lt;item&gt;**: the values go to the index as `item_override.adjustments`
(versioned, restorable) and every later upload of that item code starts from them
(`app/workflow/adjust.py`). Text overlays use Arial / Times / Courier when the server has them,
else DejaVu / Liberation / Noto, else Pillow's bundled font; the browser preview uses the matching
CSS families.

## Colours

The default for every output preset is `lighting: exact`: the artwork materials are unlit and the
renderer applies no tone mapping, so every pixel of the pouch is the artwork's own colour (the web
textures are lossless WebP; a plain `#3c78b4` panel renders as (60, 120, 180), checked by a test).
The shape shows through the silhouette, the folds and the contact shadow. The studio looks
(`studio_soft`, `studio_hard`, `daylight`, `product_dramatic`) are one click away in **Scene and
views**; they light and shade the film and shift colours slightly.

## 3D mockup (spec 5)

`frontend/src/three/` builds the pouch from the job's geometry spec (`app/geometry/spec.py`,
1 unit = 1 mm) for every template: three side seal, centre-seal pillow (fold edges, back fin),
centre seal with side gussets, stand-up with bottom gusset (oval gusset base), flat-bottom box
(8 side seal), quad seal, spout pouch (spout, collar, ridged cap; top centre or corner), shaped
die-cut (outline SVG, inflation follows the outline) and roll stock (roll + web + one sachet).

- **Dimensions.** Flat = the pouch as made: exactly the keyline size. Filled: every film row
  keeps its printed length (the body pulls in as it bulges instead of stretching the print),
  seals stay flat, the height and the top-seal width stay exact. The render step measures the
  built model (flat and filled) and records it on the job; the results page shows it next to the
  keyline size. `tests/test_workflow.py::test_real_render_dimensions` renders the sample and
  asserts 240.00 x 312.00 mm.
- **Artwork** is UV-mapped as printed, seals keep their artwork; notches, rounded corners and hang
  holes are real cut-outs (alpha); heat seals get a knurl, wrinkles run out of the seals and the
  zipper track is raised (procedural normal maps).
- **Look.** PBR materials from the index (matt / gloss / metallised film / spot varnish / clear
  window), studio environment, key / fill / rim lights that turn with the camera, soft contact
  shadow. Tone mapping is Khronos PBR Neutral for the studio presets: it keeps print colours true
  (measured on FGPO7215: gold (252,193,67) renders (246,190,75); ACES washed it to (246,229,159)).
  The "product dramatic" lighting uses ACES.
- **Server renders.** The worker opens the same scene (`/render/<job>`) in headless Chromium
  (Playwright, software WebGL) and saves each preset view as PNG, the GLB and the turntable MP4,
  so renders and the viewer always match.

## Deploy on Render (spec 0)

1. Push the repository to GitHub (the blueprint is `mockup-pipeline/render.yaml`; it does not
   touch the existing Next.js app's deployment).
2. Create an S3-compatible bucket (Cloudflare R2 or AWS S3) and an access key for it.
3. Render → New → Blueprint → the repository → Blueprint file path `mockup-pipeline/render.yaml`.
   Enter `ADMIN_EMAIL`, `ADMIN_PASSWORD` (10+ characters) and the `S3_*` values when asked.
   Render creates Postgres, Key Value (queue), the web service and the worker; migrations and the
   index seed run in the pre-deploy step; the health check is `/api/health`.
4. Sign in with ADMIN_EMAIL, then remove ADMIN_PASSWORD from the environment.

On Render the app refuses to start with development defaults (no bucket, SQLite, default secret,
non-secure cookies). Logs are JSON lines. Plans: web and worker `standard` (2 GB: OCR at 300 dpi
and software-WebGL rendering need the memory), Postgres `basic-1gb`, Key Value `starter`.

## The index (spec section 3): the rulebook

Everything that describes pouches lives in the database, never in code. **Indexing** in the
sidebar lists every kind:

| Kind | What it holds | Editor |
|---|---|---|
| Field dictionary (`field`) | every value read from a PDF: printed label + variants, kind, options **and their printed synonyms** ("Standy" is stored as "Stand-up"), unit, range, required, minimum confidence, block start / stop label, order. The OCR template is composed from it; FETCH nodes and validation use the flags. | form + **Test with a PDF** (reads a sheet with the dictionary plus your unsaved entry: value, confidence and the cell crop per field) |
| Pouch catalog (`pouch_catalog`) | the hierarchy Form -> Style -> Sealing type (with printed spellings) | form; the pouch type list is grouped by it |
| Pouch types (`pouch_type`) | geometry template, match rules, required panels, keyline template, place in the catalog, default material and output preset, a catalog picture | form |
| Keyline templates (`keyline_template`) | per-field unit, default, range, formula and sources | form |
| Size rules (`standard_size`) | standard finished sizes (per type or any); validation warns on sizes that match none and names the nearest | form |
| PDF profile & panels (`pdf_profile`) | how sheets are read (layout mode, front choice, gaps), **panels & artwork rules** per panel (Remarks names, fixed bleed, extra turn, mirror); layer names, ink patterns and OCR tuning on the YAML tab | form + YAML |
| Materials (`material`) | finish and film -> PBR settings per surface, with a **preview sphere** | form |
| Output presets, Clients, Item overrides, Validation rules | as before; validation rules now carry the size tolerances (dimension +/- 2, seal +/- 3, zipper +/- 3 mm), the open-vs-closed width check and the standard-size flag | form / YAML |
| Workflows (`workflow`) | the published graphs | the canvas (Workflows page) |

The dictionary keys are the spec table's columns (a brand-new column needs a schema change first;
the validator says so). A dictionary entry that is not a printed label (inks, layers, finish) is
there for its flags only.

- **Versioned.** Every save, archive, restore or import creates a new version with author, time
  and reason (a reason is required). Old versions stay readable; the History tab shows diffs and
  restores any version (as a new version). `index_snapshot` gives `{kind: {key: version}}`, which
  jobs store so they re-render identically later.
- **Validated.** Each kind has a schema; formulas are parsed on save (only arithmetic,
  comparisons, `x if c else y`, `min max round abs sum len ceil floor`, indexing); formula cycles,
  missing standard keyline fields and dangling references (a pouch type naming a missing keyline
  template, a client naming a missing preset, ...) are rejected with every problem listed.
- **YAML.** *YAML import / export* downloads the whole index; importing validates the whole file,
  shows a dry-run diff, and applies only after you give a reason.
- **Seed.** `app/index/seed/index.yaml` is loaded once into an empty database by
  `app.cli bootstrap`. After that the database is the source of truth. When a release changes the
  seed (e.g. new label aliases in the PDF profile), `python -m app.cli seed-diff` shows the
  difference and `python -m app.cli seed-apply --reason "..."` writes it as new versions (history
  kept, restorable; an admin edit of the same entry is superseded, so check the diff first). Jobs
  keep the versions they were pinned to until rerun with *latest index*.

**Keyline precedence** (each resolved value shows its source in the rule tester and on jobs):
item override > client override > the pouch type's rule (`formula`, or `default` with `pin`) >
measured from the PDF dieline (`from_measured`) > spec table (`from_spec`) > plain `default`.
A plain default is the last fallback so that measured values win whenever the PDF has them.

### How an admin adds a new pouch type

1. *Keyline templates* → open the closest template → **Duplicate** → new key (e.g.
   `standup_small_corner`). Change what differs, e.g. `corner_radius_mm` formula
   `3 if spec.round_corner else 0`. Write a reason → **Create**.
2. *Pouch types* → open the closest type → **Duplicate** → new key. Keep its geometry template
   (the 3D shape), pick the new keyline template, set required panels and a **priority** lower than
   the type it should win against (types are checked by priority; the first priority level with a
   match decides; two matches at that level send the job to review with a type picker).
3. Edit the **match rules**: groups are OR, conditions inside a group are AND, e.g.
   `spec.client_name eq Crystal Enterprises` AND `spec.sealing_type contains stand`.
4. **Rule tester** → Run: the evaluation table shows which condition held for each type.

### How an admin changes a keyline value

- For every job of a pouch type: *Keyline templates* → the type's template → edit default, range,
  formula or source expressions → reason → **Save new version**. Tick **Pin** to make the default
  beat values measured from the PDF.
- For one client: *Clients* → the client → YAML: `keyline_overrides: {"*": {corner_radius_mm: 4}}`
  (`"*"` = all types, or a pouch type key).
- For one item: *Item overrides* → New → key `fgpo7215` → `keyline_overrides: {top_seal_mm: 12}`.

Jobs keep the keyline version they used; an admin re-renders a job on the latest version from the
job page (Phase 3).

### How an admin adds an output preset

*Output presets* → **New** (or Duplicate an existing one) → pick views, resolution, background,
lighting, shadow, formats and the file naming pattern (the preview shows an example name) →
reason → **Create**. Tick *Default preset* to make it the default (exactly one may be). A client's
default preset is set on the client (*Clients* → `default_output_preset`).

**Transparent windows are off by default.** The spec table only says whether the pouch has a
window (`Transparent Window: Yes`); nothing on the sheet says where it is or how big, and a guessed
rectangle punched into the artwork is worse than none. To show a window on an item, add an item
override (*Item overrides* → the item code) with `window_enabled: true` and the region
`window_x_mm`, `window_y_mm`, `window_width_mm`, `window_height_mm` (from the finished top-left
corner) and `window_corner_radius_mm`, or set the same values on the job page under *Keyline*.

## Pausing and cancelling jobs

Every job has **Pause** / **Resume** / **Cancel** (job page header and the jobs list). A queued job
pauses or cancels at once; a running one stops after the step it is on (steps are not interrupted
half-way: OCR and rendering take from seconds to a few minutes). Everything done so far is kept:
Resume continues with the next step, and a cancelled job starts again with a rerun from any step
or node. Statuses: `QUEUED RUNNING NEEDS_REVIEW PAUSED FAILED DONE CANCELLED`. A review answer
sent to a job that is no longer waiting (paused, cancelled, or already answered by someone else) is
refused instead of restarting it.

## Reading the PDF: text layer first, OCR optional

The spec table and the dimension labels are read from the PDF's own text whenever the file has a
text layer (Illustrator exports keep it): PyMuPDF gives the words with their positions and the table
as cells (its ruling lines + the text in each cell, `app/ocr/pdf_table.py`), so every value is the
file's own with confidence 1.0. Words and cells fill and cross-check each other (a numeric cell that
disagrees with the word-position reading lowers that field's confidence so it reaches review). OCR
(Tesseract) is for outlined text and scans only, and it is a profile setting (*PDF profile &
panels* → "Reading the spec table"):

| `pdf_profile.ocr` | Behaviour |
|---|---|
| `auto` (default) | text layer first; OCR only where the text layer gives nothing (no words, a blank or invalid cell) |
| `off` | never OCR; a file without a text layer pauses for the pouch details (Tesseract need not be installed) |
| `always` | OCR even when the text layer is usable (diagnostics) |

Each job's log says how its table was read (`from the PDF's text` / `with Tesseract x.y`), and every
cell's source is on the Specs tab (`pdf_text`, `pdf_table`, `ocr`, `ocr_cell`, `ink_row`).

## How extraction works (spec 2.1 / 2.2)

**Three kinds of PDF** (`pdf_profile.layout_mode`, default `auto`):

| | ArtPro+ (layers) | No layers (Illustrator, PDFium re-saves) | Plain artwork |
|---|---|---|---|
| Found by | the file has layers, among them the dimension layer (`Dimensions and text`) | no layers (or a designer's own layers without the dimension layer), but a technical ink (`Dimensions and text` or a name matching `technical_ink_patterns`) paints a dieline | no layers and no dieline |
| Artwork area | TrimBox | the dieline's outer rectangle (a closed grid of technical-ink lines), measured from the vectors at the stroke centre; several identical grids = print repeats, the first is used | the whole page |
| Artwork render | texture layers on | technical ink, varnish and white plates removed from the page's content streams (not re-coloured: their alternate colours are opaque and would knock out white lines) | the page |
| Dimension drawing | `Dimensions and text` layer | the technical ink alone, the drawing connected to the dieline | none |
| Spec table | left of the artwork | the largest page area beside the dimension drawing | none: the job pauses with a **details form** (type, width, height, gusset); the page's extra size around the pouch is the bleed; the file name need not carry an item code |
| Table text | OCR | the PDF's live text when present (exact, confidence 1.0), OCR otherwise (outlined text) | - |

A multi-page PDF (printers put a "STOP! read carefully" cover page in front of the sheet) is
reduced to its artwork page, the page with the most drawing, and the log says which page was used.
A layered file is read by its layers whatever the artwork layers are called: an export whose
artwork sits on `Layer 1` / `Layer 2` next to the ArtPro+ technical layers (Illustrator work saved
through ArtPro+, FGPO7002 / 7004 / 5149 / 6443) takes every layer that is not a spec, dimension or
eyemark layer as artwork, and the differences (renamed artwork layer, another producer, a missing
`Footer1`) are logged as warnings, not stops; only `layout_mode: layers` makes them strict. A
layered file without the dimension layer is read like a file without layers. Plate names are classed by pattern (`White-1`, `Opaque White`,
`Spot Gloss UV`, `Dieline` ...), a DeviceN mix of white + technical ink counts as technical ink,
and a TrimBox that lies outside the page (seen on a PDFium re-save) is ignored. Ink dots that are
not vector circles are found as round blobs in the table render, the label under each read with
the dot's own colour as contrast (light-green "P352 C", pale-grey "White-1"); a lone digit in a
numeric cell gets a tight, digits-only re-read.

**Roll form** (`Pouch/Roll Form: Roll Form`, e.g. FGPO7138): the dieline is one print repeat
(repeat along the roll = circumference / around-ups, web = in-side B2B width), checked against the
table as warnings. The repeat wraps the roll and lies on the table in the 3D scene; the formed
sachet's front and back are cut from one pouch blank of the repeat (a cell of the dieline `height
x open width`, the pillow's fin seal = (open - 2 x closed) / 2). `NA` cells (sealing type, gusset,
notch) are valid blanks.

**Sheets with several panels.** When the dieline is not one pouch-sized panel, it is split with
the spec table's sizes: a chain of dieline intervals of the pouch height (front / back) and the
gusset width (gusset / sides), with unprinted strips or seal bands up to 30 mm between them
(`sheet_panel_gap_max_mm`; an F+B web such as FGPO7492 has a 13 mm seal band between its front
and back and no gusset panel, which the job then asks for; FGPO7165's fold band is 28 mm). A stand-up web (FGPO7535: front
0-210, gusset 213-293, back 296-506, the back upside down) becomes three panels; faces after the
first one along the height are turned 180 degrees. Which face is the front: the one with less
small print (`sheet_front: auto`; the back carries nutrition, address, barcode - FGPO7535 reads 5
vs 165 words), else sheet order. Each panel is cut from the sheet render (no bleed: the cut is the
dieline), the front is measured on its own (its bands 10/7/13/170/10 confirmed by the printed
labels) and link_panels uses the sheet's panels instead of looking for linked PDFs. If the sizes
do not fit the dieline the job asks to check height / width / gusset and re-splits after the
correction. A web drawn several times side by side (FGPO7410: two ups of a 90.49 x 130 front +
back web folded at its middle line) is split from its first up and the count is logged; the last
panel of a chain may end on the sheet's bleed edge without a cut line of its own (FGPO7410's back
has only its seal line and the bleed edge) when the margin left after it matches the margin
drawn at the start, and such a guess always ranks below a chain that ends on a drawn line.

**Pillow blanks.** A centre-seal pouch is drawn as its flat blank (`Pouch Open Width` across,
height tall), often several side by side (FGPO7396: two 170 x 108 blanks on a 344 mm sheet, 10 |
37.5 | 75 | 37.5 | 10). When no face / gusset chain fits, a chain of open-width cells is tried;
the first blank supplies both faces: the front is its middle `closed width`, the back the two outer
strips joined at the fin seal (fin = (open - 2 x closed) / 2), exactly as for a roll-form repeat.

**Two copies on one sheet.** Illustrator sheets often carry the artwork with its dieline and, beside
it, the technical drawing alone. Lines shared between the two copies (one long line across both)
leave no closed grid with one copy's extent; a relaxed search then takes pairs of equal-length
lines whose ends are covered by crossing lines, and the copy that carries the artwork (first in
reading order) is used. The spec table's strip beside the drawing is chosen by its table rules
and live text, not by area (a small artwork on a wide page has a larger empty strip below it).

**Impositions and webs without a closed grid.** A print layout (FGPO7165: two copies of four ups
of a 150 x 230 front + back web, the cut edges drawn as pieces broken at every band line) or a web
whose outer lines overshoot the corners (FGPO7442) has no closed grid with the web's extent, only
cells (a 28 mm fold band, a 48 mm cell). When the fullest closed grid is much smaller than the
network of crossing lines around it, the dieline is taken from that network instead: every cut and
seal line crosses others, overshoots add no crossing, and a long line crossed only at its ends (a
dimension line met by its extension lines) counts for nothing. Copies of the drawing are told apart
by their period: shifted by one period the crossing points land on crossing points again (the body
of a pouch and the gap between two copies are both empty, so only the repetition tells them apart).
Copies are cut one period apart at the next crossing position that begins a run of its own, so a
dimension column between two groups stays with the copy before it, and only groups that lie apart
count as copies: an empty strip of at least 30 mm between them with fewer than three lines running
through it. The ups of an imposition touch each other and stay one copy (the sheet layout takes
the first up), a front and its back meet at a fold band, and a panel's body has its own edge and
seal lines running through. The first copy in reading order is the dieline (the artwork copy is
drawn first, the technical preview beside it) and the count is logged. The keyline itself is
measured on the fullest copy of that size and mapped onto the artwork copy, whether the copy was
found as a network or as a closed grid: FGPO7165's and FGPO7410's artwork copies carry only part of
their lines, the technical preview beside them has them all. Only lines inside the copy's box
count (the ups beside it share its heights), and a cut edge drawn in pieces counts as one line as
long as its pieces together (FGPO7165's right edge covers 51 % of its up beside the shared cut line).

Remarks such as "Color match as per old code : FGPO3728" name a reference job
(`reference_code_words`), not a panel. A dot right of "Value Additions" (e.g. "Fully MATT Finish
Pouch") is a value addition, not an ink. With no finish in Remarks, Layer 1 (the printed outer
film, e.g. "25 mic matt BOPP") gives it. With no zipper track drawn, the zipper sits in the middle
of the dieline's zipper band, the widest band between the top seal and the body (FGPO7215 bands
10/12/13 put it at 28.5 mm, its track is drawn at 28; FGPO7404 bands 10/9/3/13 likewise 28.5), and
the job carries a warning. Labels match whole words only (the "Zipper" inside the value
"Standy+Zipper" is not the label "Zipper?"); option values accept a word added ("Bottom Gusset"),
layers may omit "mic" ("25 Matt BOPP"). A review-form correction left blank on a list field means an
empty list; a value that cannot fit its field comes back as a review item, never a failed job.

**Artwork.** pypdf sets the default OC config to only the texture layers (`Artwork`, plus
`Dynamic Marks` when the client's eyemark option is on) and CropBox = MediaBox = TrimBox;
pdftoppm renders at `texture_dpi` through the CMYK profile embedded in the PDF's OutputIntent
(Coated FOGRA39 on the sample). The bleed is cut per side from the measured keyline and the
result must equal the pouch size within 0.5 mm. When the operator set the size (a review
correction, the details form or a job-page adjustment) and the artwork between the dieline lines
comes out another size, it is fitted to the panel and the job carries an `artwork_fitted` warning
instead of stopping. Seals, zipper, notches and corners are not cut; the 3D geometry shapes them.

**Safety scan.** The finished texture is checked for the technical keyline colour two ways:
pixels within CIE76 6 of the keyline blue (derived from the technical ink through the
OutputIntent), and anything painted with the technical ink itself on the texture layers.
Found marks are masked and the job gets NEEDS_REVIEW with a magenta-highlighted preview.

**Spec table.** All layers except the artwork, left of the artwork area, 300 dpi, binarised.
The table is cut into bands at its own full-width horizontal rules (read from the PDF's vectors)
and each band is OCR'd with `--psm 4`. Cell borders are erased first. Labels from the index
dictionary (with aliases such as "No. of colours" for "Color:") are matched once each: the
table's blocks (header, sizes, Remarks, notes) are found in printed order, and each label only
inside its block, in any order, so boilerplate lower on the sheet ("Eyemarks", "Sealing Width
+/- 3 mm", "Gusset Code" in Remarks) is never taken for a field. Each value is cleaned
(OCR fixes, noise words such as the printer's logo) and checked against its format rule.
Weak words and cells get an offline re-read (word alone, enlarged; then cell alone at several
scales). Confidence = lowest Tesseract word confidence of the value, capped at 0.3 if the format
rule fails. A cell with ink that OCR cannot read is never reported blank.

**Cross-checks that raise confidence** (two independent sources agreeing):
Item Name / Item No. against the file name; ink names against the colour of their dot;
keyline measurements against the printed dimension labels.

**Inks.** Dots are the vector circles on `Dynamic Marks`; the name under each is read from an
ink-amount image (255 - min(R,G,B)) so yellow and light-grey "Sp White" read like black text.

**Keyline.** Line positions come from the dieline's vector paths (0.1 um precision); the finished
edges are the pair of lines whose distance equals the spec's pouch size. Each segment is
confirmed when an OCR'd label with the same number exists and then takes the label's value
(2.2377 measured -> 2.2375 printed). Unconfirmed segments get 0.8 and go to review; when there
are no labels to compare with at all (outlined labels with OCR off, a drawing without numbers)
the vector geometry stands on its own at 0.9.

**Text reader** (`TEXT_READER=ocr|groq|claude|grok`, default `ocr`): who reads a spec table that
has no live text. `ocr` is Tesseract, offline. An AI provider reads the whole table image (shrunk to
2048 px) in one call and returns the printed value per field; every value goes through the same
cleanup and format rules as OCR and scores a fixed 0.93 (models' own confidences are not
calibrated). No key, a network error, a rate limit longer than 20 s or a reply that is not JSON:
the table is read with Tesseract instead. Live PDF text is always read first, and the profile's
`ocr: off` stops any image reading. Measured on the outlined fixtures FGPO7215, FGPO7138 and
FGPO7442 with Groq `qwen/qwen3.8-27b`: every checked field identical to Tesseract's reading, in
2.5 to 3.9 s instead of 22 to 24 s. Groq's free tier allows about 1000 output tokens a minute
(roughly one table a minute). Ink names and dimension labels are still read by Tesseract.

**Vision fallback** (`VISION_FALLBACK=none|claude|grok|groq`, default `none`): only the single weak
cell image is sent, and the answer still has to pass the format rule. Keys: `ANTHROPIC_API_KEY`,
`XAI_API_KEY` (xAI Grok), `GROQ_API_KEY` (Groq Cloud; model `GROQ_MODEL`, default
`qwen/qwen3.8-27b`, which must accept images). Locally these go in `backend/.env` (git-ignored). A
failed call (network, quota) leaves the cell weak for review instead of failing the job; with
`groq` and no key the fallback is skipped.

## What the ArtPro+ PDFs actually contain (verified on FGPO7215)

- Layers: `Artwork` = design; `Dimensions and text` = dieline and dimension labels;
  `Dynamic Marks` = spec table grid and most values; `Footer1` = item name, approval date,
  in-side B2B width, colour count and the Remarks text.
- The spec table extends to ~380 mm on a 696 mm wide page, past the page's left half, so the
  spec region is "left of the artwork's dimension area", not "left half".
- Bleed is not uniform: 2.2375 mm left/right, 4 mm top/bottom.
- Non-visible separations (`Sp White`, `Gloss UV`, `Matt UV`, `Dimensions and text`) have preview
  tints as alternates (Sp White = C20 M14 Y13 grey); their tint transforms are rewritten to
  contribute no ink before the colour texture is rendered.
- Linked item codes in Remarks are bold red and Tesseract scores them 0.4-0.6 even when read
  correctly. They are confirmed in `link_panels` by finding the PDF in the file registry (a
  misread code is not found there and goes to NEEDS_REVIEW); until then they carry a warning.
