# Approval PDF -> pouch mockup pipeline

Reads an ArtPro+ job approval sheet and produces validated specs and a clean artwork texture for the
3D mockup. **Everything runs locally: no API, no network, no keys.** Text in these PDFs is outlines,
so the spec table is read with a bundled OCR model (RapidOCR, CPU).

## Setup

```
cd pdf_pipeline
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

## Use

```
.venv\Scripts\python -m pouchpdf index  <folder>      # stage 1: build / refresh the index
.venv\Scripts\python -m pouchpdf watch  <folder>      # keep re-indexing (polls every 5 s)
.venv\Scripts\python -m pouchpdf specs  <file.pdf>    # stage 2 only: print the spec JSON
.venv\Scripts\python -m pouchpdf run    <file.pdf>    # stages 1-4, writes output/jobs/<time>_<item>/
.venv\Scripts\python -m pytest -q tests               # one test group per stage
```

Each job folder holds `job.json` (input, extracted specs, panels, warnings, output paths), `job.log`,
and per panel `artwork_full_bleed.png` + `texture.png`. `output/jobs.jsonl` lists every job.

## In the app

Designers open **PDF to Mockup** on the dashboard (`/pdf-mockup`): attach the sheets, watch progress,
review the specs in a form, check each panel's artwork and the warnings, then **Build 3D mockup**.
The app starts `python -m pouchpdf job …` from `pdf_pipeline/.venv`; uploads are kept in
`output/library`, jobs in `output/webjobs`. This needs Python on the machine that runs the app
(a plain Render web service has none).

## Stages (one module each)

| Module | Stage | Notes |
|---|---|---|
| `indexer.py` | 1 Indexing | SQLite, keyed by `FGPO\d+` from the filename; panel from the filename (`Front`, `Back`, `Gusset`, also the typo `Fornt`); changed files are re-indexed and lose their cached specs |
| `ocr.py` + `specs.py` | 2 Specs | Renders the sheet left of the TrimBox at 200 DPI, OCR, pairs each label with the value on its row. Swap the engine by passing another `image -> [OcrBox]` function to `extract_specs` |
| `artwork.py` | 3 Artwork | Crops to the TrimBox at 300 DPI (CMYK -> sRGB), removes technical marks, centre-crops the bleed to the finished pouch size |
| `pipeline.py` | 4 Linking + job log | Follows `back_code` / `gusset_code` through the index; a missing file gives a warning and a fallback colour sampled from the front |

### Never guessing
A field is `null` and listed in `issues` when its label or value is missing, the whole cell is not a
clean number (`3l2 mm` fails, it is not read as `2 mm`), OCR confidence is below 0.85, a number is
outside its sane range, or the TrimBox does not equal pouch size + bleed (2.2375 mm sides, 4 mm
top/bottom) within 2 mm. Any issue sets `needs_review: true`: show the values in an editable form.

### Technical marks
1. **Layers** (ArtPro+ exports): every layer whose name looks technical (`Dimensions and text`,
   `Dynamic Marks`, `Footer…`) is switched off, so the real artwork under the marks is rendered.
2. **Spot ink** (files without layers): the technical ink is disabled to find exactly which pixels the
   marks cover, and those thin lines are filled from their surroundings. If marks cover more than 6 %
   of the artwork they are left in place and a warning is raised.

Values to tune live in `config.py`.
