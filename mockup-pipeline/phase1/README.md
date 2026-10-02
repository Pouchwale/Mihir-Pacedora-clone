# Phase 1: a dimensionally exact 3D pouch from any PDF

Give it any approval PDF (ArtPro+ with layers, an Illustrator sheet, a PDFium re-save, or plain
artwork). It reads the pouch details from the PDF, builds the pouch to those dimensions with the
existing index (pouch types, keyline templates, materials) and workflow engine, and gives you the
renders, the GLB and the interactive 3D viewer. The dieline is not needed here: when the PDF has
one it is used, when it has none the details still come from the table or from you.

## Run

```powershell
cd mockup-pipeline
backend\.venv\Scripts\python phase1\run_phase1.py "C:\path\to\FGPO7215_Dog_Food_Front_App.pdf" --open
```

Several PDFs at once:

```powershell
backend\.venv\Scripts\python phase1\run_phase1.py a.pdf b.pdf c.pdf
```

If nothing answers on http://127.0.0.1:8765 the runner starts `backend/run_local.ps1` for you
(first start: builds the UI, migrates the database, seeds the index). Sign-in defaults to the local
admin (`admin@example.com` / `change-me-please-1`); pass `--email` / `--password` or set
`ADMIN_EMAIL` / `ADMIN_PASSWORD` for another account.

## What happens

1. The PDF becomes a job on the **phase1** workflow (`phase1/workflow.yaml`, published into the
   index by the runner if missing or changed; also in the seed): PREPARE -> FETCH pouch details ->
   SET pouch type (match rules) -> VALIDATE -> RESOLVE KEYLINE -> LINK PANELS -> BUILD 3D -> ARTWORK
   -> RENDER -> END. You can watch it on the job page's **Workflow** tab.
2. PREPARE reads the spec table wherever it is on the page (the PDF's live text when it has any,
   OCR otherwise) with the field dictionary: height, closed / open width, gusset, sealing type,
   zipper, notch, layers, inks, finish, client, item code.
3. FETCH checks the values a pouch needs (height, closed width, sealing type). When they are read
   and confident the job carries on by itself. When they are not, the job pauses on the details
   form and the runner answers it:
   - with `--details height=225 width=151 sealing="Stand-up" gusset=80 gusset_type=Bottom zipper=yes`
     (spellings are forgiving: `standy`, `3ss`, `gusset_type=no`, `finish=Matt` are normalised;
     unknown keys are refused with the list of accepted ones; `--details` given for a PDF whose table
     is complete are applied over the table's values),
   - else with whatever the operator types on the job page within `--wait` seconds (default 120),
   - else with defaults derived from the PDF: a plain page's size as the pouch size (a layered or
     dieline PDF's TrimBox minus its measured bleed); a stand-up pouch when a bottom gusset is known
     (gusset 30 % of the width when its width is missing), a side-gusset pouch for a side gusset, a
     flat three-side-seal pouch otherwise; client and item from the file name. A page over 600 mm is
     a print sheet, not a pouch: no size is assumed from it.
   Every value the runner assumed, and every weak read it merely confirmed, is listed in the
   summary and in `details.json` (`assumed_by_runner`, `confirmed_by_runner`), so a pouch always
   comes out and you always know what it was built from. All required fields are answered at the
   first pause, so an unattended PDF waits once.
4. The pouch type comes from the index's match rules (`--pouch-type` decides a tie; an unknown key
   stops with the list of known types; with no match and no `--pouch-type` the flat pouch is used).
   Missing panels are substituted (back = the front's artwork, gusset / sides a plain film colour).
   Checks only a person can judge (TrimBox vs size, dieline vs table ...) are accepted after the
   waiting time and kept in the report. What the runner cannot answer stops that PDF with the reason
   and the job URL (a value the schema rejects, a PDF the pipeline refuses, the same question coming
   back twice, a paused or cancelled job); the rest of the batch goes on and the exit code is 1.
5. Outputs land in `phase1/output/<ITEM>/`:

| File | What |
|---|---|
| `render_<view>.png` | the output preset's views (exact print colours) |
| `<ITEM>.glb`, `<ITEM>_turntable.mp4` | the 3D model and the turntable (when the preset makes one) |
| `keyline_<panel>.svg`, `texture_<panel>.webp` | keyline preview and finished texture per panel |
| `details.json` | every detail with confidence, what was measured from the drawing, what the runner assumed, the pouch dimensions the geometry was built to, the size measured on the built 3D model, the keyline values, the workflow path, the job URL |

`--open` opens the job page: orbit the pouch, switch flat / filled, show dimensions, adjust artwork,
size, material and scene (the Adjust panel), re-render.

## Reading the PDF

The details come from the PDF's own text layer whenever it has one (words and table cells through
PyMuPDF, exact, confidence 1.0). OCR is optional: the index's PDF profile setting `ocr` is `auto`
(OCR only where the text layer gives nothing), `off` (never; files without a text layer pause for
the details, which this runner then answers as above) or `always`. `details.json` says which
(`text_source`: `pdf_text`, `ocr` or `none`).

## Accuracy

The geometry is built in millimetres from the table values (1 three.js unit = 1 mm); the render
step measures the built model and `details.json` records it next to the table values
(`model_measured_mm` vs `pouch_mm`). Live runs on this machine: FGPO7215 240 x 312 (model
240.00 x 312.00), FGPO7396 75 x 108 (model 75.00 x 108.00); the in-process tests assert that the
measured model equals the built pouch for every PDF they run.

## Tests

`backend/tests/test_phase1.py` runs the runner against the API in-process with a render stub that
measures the built geometry: the published workflow equals the YAML and the seed; a PDF with a full
table (FGPO7215) ends DONE at 240 x 312 x 120 with substitutes for its missing panels; the pillow
blanks sheet (FGPO7396) ends DONE at 75 x 108 with nothing assumed; a plain page ends DONE on
PDF-derived defaults after one pause; `--details` win over defaults and over a complete table; a
gusset type without a width gets a derived gusset; an operator's answer within `--wait` wins;
an unknown `--pouch-type` stops instead of looping; a print sheet is not taken as a pouch size.
