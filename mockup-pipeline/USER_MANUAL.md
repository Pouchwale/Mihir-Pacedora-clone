# GP3 Mockup — User Manual

GP3 Mockup turns an artwork approval PDF into a 3D mockup of the pouch, roll or shrink sleeve, in the
exact print colours. You upload the PDF; the app reads the artwork and the spec table, works out the
pouch type and its dieline, builds the 3D model and renders pictures, a 3D file and a turntable video.
You can then adjust it, approve it, download everything, and send customers a link to a live 3D view.

```
Upload PDF ──► Read artwork & spec table ──► Pouch type & keyline ──► Link back / gusset panels
           ──► Build 3D ──► Apply artwork ──► Render pictures, GLB, video ──► DONE
```

This manual has two parts:

- **Part A — Everyone** (designers, head of designers, managers, admins): signing in, uploading, jobs,
  the 3D view, adjustments, reviews, sharing and downloads.
- **Part B — Administrators**: users and rights, the activity log, error reports, the index (the
  rulebook), workflows, storage, and running the server (settings, backups, HTTPS, logs).

---

## Contents

**Part A — Everyone**

1. [Roles: who can do what](#1-roles-who-can-do-what)
2. [Signing in](#2-signing-in)
3. [Using it on a phone](#3-using-it-on-a-phone)
4. [Uploading PDFs](#4-uploading-pdfs)
5. [The Jobs list](#5-the-jobs-list)
6. [The job page](#6-the-job-page)
7. [The 3D view](#7-the-3d-view)
8. [Adjusting a mockup](#8-adjusting-a-mockup)
9. [When a job asks you a question (reviews)](#9-when-a-job-asks-you-a-question-reviews)
10. [Sharing with customers](#10-sharing-with-customers)
11. [Downloads](#11-downloads)
12. [Reporting a problem](#12-reporting-a-problem)

**Part B — Administrators**

13. [Users and rights](#13-users-and-rights)
14. [Activity log and error reports](#14-activity-log-and-error-reports)
15. [The index: the rulebook](#15-the-index-the-rulebook)
16. [Workflows](#16-workflows)
17. [Rule tester and YAML import / export](#17-rule-tester-and-yaml-import--export)
18. [Storage and cleanup](#18-storage-and-cleanup)
19. [Running the server](#19-running-the-server)
20. [Troubleshooting](#20-troubleshooting)
21. [Glossary](#21-glossary)

---

# Part A — Everyone

## 1. Roles: who can do what

Everyone can upload PDFs, follow their jobs, answer reviews, adjust mockups, share them and download
them. Beyond that, each role adds rights:

| Right | Admin | Head of Designer | Designer | Manager |
|---|:-:|:-:|:-:|:-:|
| Upload, review, adjust, share, download **own** jobs | ✓ | ✓ | ✓ | ✓ |
| See **every** user's jobs | ✓ | | | |
| Approve finished jobs | ✓ | ✓ | | ✓ |
| Edit the index (materials, clients, presets, item overrides…) | ✓ | ✓ | ✓ | |
| Edit keyline / dieline values, pouch types, size rules, workflows | ✓ | ✓ | | |
| See the activity log of every user | ✓ | | | ✓ |
| Manage users, passwords and rights | ✓ | | | |
| Handle error reports | ✓ | | | |

An admin can give or take single rights per person (Users page). Everyone except the admin sees only
the jobs they uploaded; a job that belongs to someone else shows "does not exist, or it belongs to
another user".

## 2. Signing in

Open the address your administrator gave you, for example `http://<server-PC-IP>:8765` on the office
network, and sign in with your email and password.

- **Wrong password eight times** locks the account for 15 minutes. Too many failed attempts from one
  computer are also blocked for a few minutes. An admin can unlock you at once.
- **One place at a time.** If your account is already signed in somewhere else (another PC, another
  browser, your phone), the sign-in form says so and asks for an **Administrator password**. When an
  admin types theirs, you are signed in here and the other place is signed out. This stops one
  account being shared or used without anyone noticing.
- **Session timeout.** A sign-in lasts at most a working day (12 hours by default). The admin can also
  set an idle timeout: after that long without using the app you are signed out.
- **Sign out** is at the bottom of the menu. Use it on shared computers.
- **Theme:** Light, Dark or Auto (follows your computer) at the bottom of the menu.

## 3. Using it on a phone

The whole app works on a phone:

- The menu is behind the **☰** button at the top left; the **⬆** button at the top right opens Upload.
  Picking a page closes the menu.
- A job opens on its **3D & Renders** tab. The Keyline & Dieline Studio works too but is meant for a
  big screen.
- In the 3D view, drag one finger to turn the pouch, pinch to zoom and use two fingers to move it.
  Each toolbar is one row: swipe it sideways to reach more buttons.
- Wide tables scroll sideways inside their card.

## 4. Uploading PDFs

**Upload PDFs** (menu, or the button on the Jobs page).

1. Drop files on the box, or click it to choose them. You can drop:
   - one or many **PDFs**;
   - a **ZIP** of PDFs (each PDF inside is handled as if dropped on its own);
   - an **SAP Item Master XML** export, which fills the spec values of the jobs in the same upload.
2. **What are these designs?** Leave *Auto-detect* (shrink sleeves are found by their FGSL code or
   sleeve wording), or pick *Pouches / rolls* or *Shrink sleeves*.
3. For shrink sleeves, **Shrink sleeves go on**: *Automatic* picks the container from the item name
   (ml drinks: can, oil or PET: bottle, ghee: jar, powders: tin), or pick one.
4. If the admin has published more than one workflow, choose the **Workflow** (normally leave
   *Standard*).
5. Click **Upload**. Each job appears on the Jobs page and starts on its own.

**How files are grouped.** A file whose name says *front* (also *F+B*, *F&B*) or names no panel becomes
a job. A file whose name says *back* or *gusset* is a panel: it is linked to the front with the item
code just before it (e.g. FGPO7151 Gusset belongs to FGPO7150 Front), and a job waiting for that panel
continues by itself. A sheet that carries front, gusset and back together needs nothing else.

**Limits.** Each file may be up to 200 MB (the admin can change this). Only PDF, ZIP and XML files are
accepted. Name files with their item code first (e.g. `FGPO7535_Strawberry-app.pdf`).

## 5. The Jobs list

The cards at the top count **All jobs**, **Done**, **In progress** and **Need attention**; click one to
filter. Below them: search (item code, client or file name; press **/** to jump there), status, pouch
style chips, and a grid / list switch. The list refreshes by itself every few seconds.

**Job statuses**

| Status | Meaning |
|---|---|
| QUEUED | Waiting its turn (jobs run one at a time). |
| RUNNING | Being worked on now; the step is shown. |
| NEEDS REVIEW | The job paused and asks you something (section 9). |
| PAUSED | Paused by a person; Resume continues where it stopped. |
| FAILED | Something went wrong; the job page shows why. Rerun it or raise an error. |
| DONE | Finished: 3D view, renders and downloads are ready. |
| CANCELLED | Stopped by a person; a rerun starts it again. |

**Pause / Resume / Cancel** are on every job card and on the job page. A queued job pauses or cancels
at once; a running job stops after the step it is on (a step can take from seconds to a few minutes).
Nothing done so far is lost.

## 6. The job page

**Header.** Item code, status, file, client, pouch type, keyline and workflow version.

| Button | What it does |
|---|---|
| Pause / Resume / Cancel | As on the Jobs list. |
| Raise an error | Sends the admin a report about this job (section 12). |
| Download all (ZIP) | Every output plus an audit file (section 11). |
| 🔗 Share 3D | Copies a customer link to the live 3D view (section 10). |
| Approve | Marks the mockups approved (Admin, Head of Designer, Manager). Rerunning or adjusting the job removes the approval, because the pictures change. |

**Tabs**

| Tab | What you find |
|---|---|
| 📐 Keyline & Dieline Studio | The flat dieline with the artwork: measure, check layers and marks, and adjust (see section 8); **Apply and re-render** makes the result final. |
| 📦 3D & Renders | The live 3D view (section 7), the **Adjust** panel, the rendered pictures, the GLB 3D file and the video. |
| Workflow | The flowchart this job walked, coloured: green passed, amber waiting for review, red failed, blue running, grey not visited. Click a node for its steps, times and outputs; **Rerun from this node** redoes everything from there. |
| Specs | Every value read from the PDF, with how sure the reading was and where it came from (the PDF's own text, the table, or OCR). |
| Keyline Table | Every keyline value (sizes, seals, zipper, notch…) and where it came from (rule, measured from the drawing, spec table, default). |
| Steps | The engine steps with status and time; **Rerun** any step. |
| Log | Everything that happened to the job, with who did it. |

## 7. The 3D view

**Top toolbar:** *Realistic* (studio light) or *Exact colours* (every pixel the print colour), *Window*
(transparent window, when the pouch has one), *Scene* (dimension lines, filled or flat pouch,
background, floor), *Full screen*.

**Bottom toolbar:** views *Front*, *Back*, *¾ left*, *¾ right*, *Top*, *Reset*; *Spin 360°*; *Video*
(records a 6-second turntable in your browser; MP4 where the browser can); *PNG* (the pouch on a
transparent background) and *JPEG* (the view with its background), both at twice the screen size.

**Mouse:** drag to turn, right-drag to move, scroll to zoom, arrow keys turn it.
**Touch:** one finger turns, pinch zooms, two fingers move.

Under the view: the keyline size and the measured size of the 3D model (flat and filled).

## 8. Adjusting a mockup

Open **Adjust** beside the 3D view (or in the Keyline & Dieline Studio). Changes show at once in the
view; **Apply and re-render** reruns the job from the first step they affect, so the pictures, GLB and
video match. **Reset to automatic** undoes all adjustments.

| Section | What you can change |
|---|---|
| Artwork per panel | Which artwork a panel shows: automatic, a panel of the sheet, the front's artwork, a plain colour, or **your own picture or PDF** (fill, fit inside, or stretch). Swap front and back, turn, mirror, move and scale. |
| Colour correction | Brightness, contrast, saturation per panel. |
| Logos and text | Add text (size in mm, font, bold, colour, alignment, box) or a logo / picture; drag them on the flat panel or type positions in mm; rotate, set opacity, order. They are baked into the final artwork. |
| Size and shape | Width, height, gusset; seals, zipper and notch position, corner radius, fill level, bulge. |
| Features | Zipper on/off, tear notch, butterfly notch, hang hole, transparent window and its position. |
| Material and finish | Matt or gloss, metallic film where unprinted, colour of plain panels. |
| Scene and views | Exact colours or studio light, background (white, transparent, colour, gradient), shadow, which views to render. |

Tick **save as default for <item>** (Admin, and roles with index rights) to make these values the
starting point for every later upload of the same item code. Keyline values in that default need the
keyline right.

## 9. When a job asks you a question (reviews)

A job pauses with **NEEDS REVIEW** when it cannot trust what it read. By default the app answers most
questions itself and only stops when it cannot decide. When it stops, the job page shows a form:

| The job asks about | What you do |
|---|---|
| Spec values | Confirm or correct each flagged value; the cell picture from the PDF is shown next to it. |
| Pouch details | The PDF has no table: enter type, width, height and gusset. |
| Pouch type | Pick the type from the list. |
| Keyline values | Enter the values that were out of range. |
| Missing panels | Upload the missing back or gusset PDF, or choose a substitute (back = front artwork, plain film). Uploading it from the Upload page also works. |
| Technical marks | Check the magenta preview of the masked dieline marks and accept. |
| Workflow review | A review step the admin put in the workflow: continue, or choose the branch. |

Your answer is saved on the job and logged with your name, and the job continues from that point.
If another person answered first, or the job was paused or cancelled meanwhile, your answer is refused
with a message instead of restarting it.

## 10. Sharing with customers

1. On a **DONE** job, click **🔗 Share 3D**. The link is copied (or shown for you to copy).
2. Send it to the customer (WhatsApp, email…). They need no account.

The customer sees the live 3D pouch with its pictures and logos, the item code, client and pouch type,
and can turn it, zoom, change views and download **PNG** or **JPEG** pictures, saved as `MOCKUP.png` /
`MOCKUP.jpg`. They cannot record video, see your job page, the spec values, other jobs or anything else.

- A link works for **7 days**. After that the customer sees "expired"; send a new link.
- A link cannot be withdrawn before it expires, so send it only to the right person.
- Links work from outside the office through the ngrok tunnel. If the message says "this link opens on
  this PC only", the tunnel is not running: tell the admin.
- On ngrok's free plan the customer first sees an ngrok "You are about to visit…" page and must click
  **Visit Site**. A paid ngrok plan removes that page.

## 11. Downloads

- **Download all (ZIP)** on a finished job: the rendered pictures for every view, the GLB 3D file, the
  turntable video (when the output preset makes one), the keyline previews, and `data/audit.json`
  (input files and their fingerprints, values read and corrected, pouch type, keyline and workflow
  versions, who approved).
- Single files are on the **3D & Renders** tab.
- **PNG / JPEG** from the 3D view save exactly what is on screen.

## 12. Reporting a problem

**Raise an error** (on every job and at the bottom of the menu) sends the admin a short report with
the page you are on, e.g. "the back panel shows the front artwork". When the admin marks it resolved,
you see their note.

---

# Part B — Administrators

## 13. Users and rights

**Users** (menu, admin only) lists everyone with role, status, last sign-in, last upload and counts.

- **Add user:** email (their sign-in id), name, role and a password of at least 10 characters; send it
  to them yourself.
- **Edit:** change name, email, role, or deactivate. Changing role, email or password signs that person
  out everywhere, so the new rights apply at once.
- **Set password**, **Unlock** (after 8 wrong passwords) and **Sign out** (ends all their sessions).
- **Access:** give or take single rights on top of the role (approve, edit index, edit keyline, view
  activity, see all jobs, handle errors). **Back to the role's access** removes the overrides.
- At least one active administrator always remains: removing the last one is refused.
- **Second sign-in approval:** when someone's account is already in use elsewhere, they will ask you to
  type your password on their sign-in screen. Do it only if you know why they need a second place; the
  first place is then signed out. Each such sign-in is recorded in the activity log as approved.

## 14. Activity log and error reports

**Activity log** (Admin, Manager): every sign-in (and failed attempt), page opened, upload and change,
by user and day, with filters. It is the audit trail and is never deleted.

**Error reports** (Admin): reports raised by users, with the page and job they were on. Write a note,
**Mark resolved** (the person sees your note) or **Reopen**. The menu shows a badge with open reports.

## 15. The index: the rulebook

Everything that describes pouches lives in the **index** (menu → Indexing), not in the program. Every
save needs a **reason**, creates a new **version** (who, when, why), and older versions stay readable
and can be restored from the **History** tab. Jobs remember the versions they used, so an old job
re-renders exactly the same until someone reruns it with **latest index**.

| Index entry | What it holds |
|---|---|
| Field dictionary | Every value read from a PDF: its printed label and spellings, type, options and their printed synonyms, unit, range, required, minimum confidence. **Test with a PDF** shows what a sheet gives. |
| Pouch catalog | Form → Style → Sealing type, grouping the pouch types. |
| Pouch types | 3D template, match rules (which PDFs get this type), required panels, keyline template, default material and output preset, priority. |
| Keyline templates | Every keyline value: unit, default, range, formula, sources (measured / spec table). |
| Size rules | Standard finished sizes; a size matching none gives a warning naming the nearest. |
| PDF profile & panels | How sheets are read: layout mode, layers, ink names, OCR on/off/always, panel rules, texture resolution. |
| Materials | Matt / gloss / metallic film etc., with a preview sphere. |
| Output presets | Views, resolution, background, lighting, formats, file names; one is the default. |
| Clients | Per-client keyline overrides and default output preset. |
| Item overrides | Per-item code: forced pouch type, keyline values, saved adjustments. |
| Validation rules | Size tolerances and checks. |
| Sleeve containers | Bottle, can, jar, tin…: shapes for shrink sleeves, and an uploaded 3D model if you have one. |
| Storage & cleanup | Disk housekeeping (section 18). |

**Who decides a keyline value** (first one that applies wins): item override → client override → the
pouch type's rule (a formula, or a pinned default) → measured from the PDF's dieline → spec table →
plain default. Each value's source is shown on the job's Keyline Table.

**Add a pouch type:** Keyline templates → open the closest → **Duplicate** → new key, change what
differs, reason, **Create**. Then Pouch types → closest → **Duplicate**, keep its 3D template, pick the
new keyline template, set required panels and a priority, edit the **match rules** (groups are OR,
conditions inside a group are AND). Check it in the **Rule tester**.

**Change a keyline value:** for all jobs of a type, edit its keyline template (tick **Pin** to beat
measured values); for one client, the client's keyline overrides; for one item, an item override.

Formulas allow arithmetic, comparisons, `x if c else y`, `min max round abs sum len ceil floor`; they
are checked when you save.

## 16. Workflows

**Workflows** shows the flowchart every job follows. Open one to edit it on the canvas:

| Node | Does |
|---|---|
| START | The uploaded PDF. |
| PREPARE | Checks the PDF, separates artwork from drawing, reads the table and dimensions. |
| DECISION | Follows the first outgoing branch whose conditions hold, else the ELSE branch. |
| FETCH | Names fields this branch needs; a missing or uncertain one pauses for review. |
| VALIDATE | Size rules and cross-checks. |
| SET POUCH TYPE | Assigns a type, or "automatic" (match rules). |
| RESOLVE KEYLINE · LINK PANELS · BUILD 3D · ARTWORK · RENDER | As named. |
| REVIEW | Pauses for a person; with several branches the person picks one. |
| SUB-WORKFLOW | Runs another published workflow, then continues. |
| END | Results. |

Edits are saved as a **draft**. **Test** runs a PDF through the draft and lights up the path (test runs
stay out of the jobs list). **Publish** checks the graph (one START, ELSE on every decision, no dead ends
or loops, known types and fields) and makes it the version new jobs use. Old jobs keep the version they
ran.

## 17. Rule tester and YAML import / export

- **Rule tester:** enter or load spec values and see which pouch type matches, condition by condition,
  and how every keyline value resolves.
- **YAML import / export:** download the whole index as one file (a readable backup), or import one: you
  see a dry-run of every change and it applies only after you give a reason.

## 18. Storage and cleanup

Indexing → **Storage & cleanup**. The server applies these rules once an hour. Nothing is ever lost.
Old log files are not deleted automatically; remove old ones from `MockupData\logs` by hand if needed.

| Setting | Effect | Default |
|---|---|---|
| Compact after (days) | Jobs finished that long ago have their PNG files recompressed: same format, **every pixel identical** (checked before replacing), about a third smaller. The job's log says how much was freed. | 30 (0 = never) |
| PDF cache (days) | Working copies of uploaded PDFs older than that are deleted; the upload itself is kept and copied back when needed. | 7 (0 = never) |

The folders `MockupData\uploads` and `MockupData\Output Mockups` are readable copies kept for people to
browse; the app never reads them back, so you may delete old ones by hand.

## 19. Running the server

### Starting and stopping

The server runs on one Windows PC. It starts by itself when that PC's user signs in (the shortcut
`Start Mockup Pipeline.vbs` in the Startup folder runs `backend\autostart.ps1`) and restarts itself if
it stops. Only one copy of the keeper runs, even if the shortcut is opened twice.

- **Start by hand:** `powershell -ExecutionPolicy Bypass -File backend\run_local.ps1`
- **Restart** (to apply new settings or an update): end the `python.exe` of the server in Task Manager;
  the keeper starts it again within about 15 seconds. Jobs that were queued continue; a job that was
  running restarts from its step.
- Office devices reach it at `http://<this PC's IP>:8765`; run `backend\allow_lan_firewall.ps1` once as
  administrator to open the port to the office network only.

### Settings (`backend\.env`)

Edit the file, then restart the server.

| Setting | Meaning | Default |
|---|---|---|
| `SECRET_KEY` | Signs share links. Keep it private; changing it stops every link already sent. | (set) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Creates the first admin on an empty database only. | — |
| `SESSION_HOURS` | Longest a sign-in lasts. | 12 |
| `SESSION_IDLE_MINUTES` | Sign out after this long without activity (0 = off). | 0 |
| `SINGLE_SESSION` | One place per account; a second needs an admin's password. | true |
| `PUBLIC_URL` | The ngrok address for share links (set in `autostart.ps1`). | — |
| `BACKUP_DIR`, `BACKUP_HOUR`, `BACKUP_KEEP_DAYS` | Nightly backup (below). | MockupData\backups, 2, 14 |
| `MAX_UPLOAD_MB` | Largest file accepted. | 200 |
| `AUTO_REVIEW` | Answer review questions automatically when possible. | true |

### Backups and restore

Every night at `BACKUP_HOUR` (a night missed while the PC was off is caught up soon after start) the
server copies to `BACKUP_DIR`: the database (`db\dev-<date>.db`, last 14 kept), a mirror of all stored
files (`storage\`, nothing ever deleted from it), and `env.backup`. `LAST_BACKUP.txt` says when.

**Set `BACKUP_DIR` to another disk, a NAS share or a synced folder (OneDrive)**: a backup on the same
disk does not survive that disk. Run one by hand from `backend`:
`.venv\Scripts\python -m app.cli backup`.

**Restore:** stop the server; copy `db\dev-<date>.db` over `backend\.work\dev.db` (delete `dev.db-wal`
and `dev.db-shm`); copy `storage` back to `backend\.work\storage`; copy `env.backup` to `backend\.env`
if it was lost; start the server.

### HTTPS on the office network

Not available in this version: the office network address is plain `http://<IP>:8765`, so anyone on the
office network could read passwords as they are sent. Use the app only on a trusted office network.

### Logs: why did it stop?

`MockupData\logs\server\<day>.log` (one line per event) holds job steps and errors, plus:

- `server started` / `server stopped (clean shutdown)`;
- a `load` line every 5 minutes: memory used, free memory, free disk, jobs queued and running;
- a **warning** when free memory falls under 700 MB or free disk under 3 GB;
- `previous run ended without a clean shutdown` when the last run crashed or the PC lost power — look at
  the `load` lines just before it, and at `crash-faults.log` for crashes inside the PDF or image
  libraries.

Most likely reasons for a stop: the PC ran out of memory during a big render (free RAM falling in the
`load` lines), the disk filled, a restart or power cut, or a start-up failure shown in
`MockupData\logs\autostart-<day>.log`.

### Capacity

Jobs run **one at a time**, one to five minutes each (15–40 an hour). A batch of 20 PDFs takes 20 to 60
minutes. Browsing is light: 30 people using the pages at once is fine. Memory is the real limit: a big
sheet needs 1–2 GB, so keep that much free on the server PC.

## 20. Troubleshooting

| Problem | What to do |
|---|---|
| "Signed in somewhere else" | Sign out on the other device, or ask an admin to type their password on the sign-in screen. |
| "Too many failed attempts" | Wait 15 minutes, or ask an admin to **Unlock** you. |
| Signed out by itself | The session timed out; sign in again. |
| A job stays QUEUED | Another job is running (one at a time). If nothing is running for a long time, tell the admin. |
| A job FAILED | Read the reason on the job page; fix the input and **Rerun**, or **Raise an error**. "Password-protected" or "not a readable PDF" means the file itself must be fixed. |
| NEEDS REVIEW | Answer the form on the job page (section 9). |
| Wrong pouch type or size | Answer the review, or adjust (section 8), or ask an admin to fix the match rules / keyline. |
| Customer says the link expired | Share 3D again for a fresh link. |
| Customer sees "Visit Site" | ngrok's free plan; they click Visit Site once. A paid plan removes it. |
| "This link opens on this PC only" | The tunnel is not running: the admin restarts the server or ngrok. |
| A job "does not exist" | It belongs to another user, or the number is wrong. |
| Everything is slow | A big job is rendering, or the server PC is short of memory (see the `load` lines). |

## 21. Glossary

| Word | Meaning |
|---|---|
| Approval PDF | The artwork file sent for print approval, with artwork, dieline and spec table. |
| Dieline / keyline | The cutting and folding outline of the pouch, with all its sizes. |
| Spec table | The table on the sheet: client, item, sealing type, sizes, zipper, notch… |
| Panel | Front, back, gusset, sides: one printed face of the pouch. |
| Gusset | The folded side or bottom that gives the pouch depth. |
| Bleed | Extra artwork beyond the cut line. |
| Index | The rulebook: everything that describes pouches, versioned. |
| Workflow | The flowchart a job follows. |
| Review | A question the job asks a person before continuing. |
| GLB | A 3D file that opens in most 3D viewers and web pages. |
| Share link | A link to a job's live 3D view for customers, valid for a limited time. |
| ngrok | The service that makes share links reachable from outside the office. |
