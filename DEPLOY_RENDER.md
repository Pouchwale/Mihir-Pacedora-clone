# Deploying Gujarat Print Pack Mockup on Render

This app is deployed as **one Render Web Service (Node)** plus **one Render PostgreSQL database**.
Everything is described in [`render.yaml`](render.yaml), so Render can create both for you.

---

## 1. Which Render plan should you use? (about 100 users)

### Recommendation

| Resource | Plan in `render.yaml` | Specs | Approx. price* |
|---|---|---|---|
| Web service | **Standard** (`standard` / `1c-2g`) | 1 CPU, 2 GB RAM | ~$25 / month |
| PostgreSQL | **Basic-1gb** (`basic-1gb`) | 1 GB RAM | ~$20 / month |
| Database disk | **15 GB** | designs, uploaded 3D models, briefs | ~$0.30 / GB / month |
| Region | **Singapore** | closest Render region to India | — |

**Total: roughly $45–55 per month.**

\* Prices change. Confirm current prices on <https://render.com/pricing> before you create the services.
A Render workspace on the free **Hobby** plan can run these paid services. The **Professional** workspace
(per team member per month) is only needed if you want longer database point-in-time recovery or
several team members managing the Render dashboard.

### Why these plans (measured on this app)

The app was load-tested on PostgreSQL with 100 simultaneous requests:

- Server memory went from **~160 MB idle to ~430 MB** under that load. Designs store large 3D models
  (up to 16 MB each) that pass through server memory.
  - **Starter (512 MB)** would be at risk of running out of memory and restarting, so **Standard (2 GB)** is recommended.
- Single page loads take **50–110 ms**. 100 truly simultaneous page requests queued to ~2.7 s on one CPU.
  With 100 staff, real concurrent usage is normally 5–15 requests at once, which stays well under 1 s.
- 20 parallel downloads of a 16 MB custom model finished without errors.

### Plans NOT recommended for real use

| Plan | Problem |
|---|---|
| Free web service | Sleeps after ~15 min idle; the first visitor then waits about a minute. 512 MB RAM. |
| Free PostgreSQL | **Expires after 30 days** (data is deleted), 1 GB storage, no backups. |
| Starter web service (512 MB) | Can run out of memory with several large model uploads at once. |
| Basic-256mb PostgreSQL | Too little RAM for large design data; fine only for a test/demo. |

### When to upgrade

- Pages regularly slower than 1–2 s, or CPU constantly high in *Metrics* → **Pro (2 CPU, 4 GB)** web service.
- Memory near 2 GB in *Metrics* → **Pro** web service.
- Database disk above ~80% → increase disk size (can only grow, not shrink).
- Database CPU/RAM constantly high → **Basic-4gb** PostgreSQL.

---

## 2. Before you deploy

1. **Commit and push** the project to GitHub (repository `Pouchwale/Mihir-Pacedora-clone`, branch `main`).
   Check that these are *not* committed (they are in `.gitignore`): `frontend/.env`, `frontend/dev.db`,
   `*.db.backup*`, `.next/`, `node_modules/`.
2. Choose the first administrator login you will use on the live site:
   - `ADMIN_EMAIL`: e.g. `you@yourcompany.com`
   - `ADMIN_PASSWORD`: **at least 10 characters**, not reused anywhere else.

---

## 3. Create the services on Render (Blueprint)

1. Render Dashboard → **New** → **Blueprint**.
2. Connect GitHub and select the repository. Render reads `render.yaml`.
3. Render asks for the values marked `sync: false`:
   | Variable | What to enter |
   |---|---|
   | `NEXTAUTH_URL` | Leave **empty** to use the `https://<name>.onrender.com` address. Set `https://your-domain` only if you use a custom domain. |
   | `ADMIN_EMAIL` | Your first administrator email |
   | `ADMIN_PASSWORD` | Your first administrator password (10+ characters) |
   | `HF_API_KEY` | Optional Hugging Face key for AI artwork; leave empty to disable |
   `DATABASE_URL` (internal database URL) and `NEXTAUTH_SECRET` (random) are filled in automatically.
4. Click **Apply**. Render creates the database, then builds and deploys the web service:
   - **Build:** `npm ci --include=dev && npm run build`
   - **Pre-deploy:** `npm run db:deploy` (applies migrations, creates the 7 built-in templates and your administrator)
   - **Start:** `npm start`
   - **Health check:** `/api/health` (returns `{"status":"ok"}` when the database is reachable)
5. Open the web service URL and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, account type **Administrator**.

> Using an **existing** Render PostgreSQL database from an earlier deployment instead of creating a new one?
> Set its internal URL as `DATABASE_URL` on the web service (and remove the `databases:` block).
> The pre-deploy step detects a database without migration history and upgrades it without deleting data.

---

## 4. Copy your existing local data (optional, one time)

This copies users, designs (including uploaded models), approval requests and settings from
`frontend/dev.db` on your PC into the Render database.

1. Render → your database → **Networking / Access Control**: add your current public IP address.
2. Render → your database → **Connect** → copy the **External Database URL**.
3. On your PC, in the project folder (PowerShell):
   ```powershell
   $env:TARGET_DATABASE_URL = "postgresql://...external URL..."
   npm run db:copy-local-data
   ```
   - Requires Node.js 22.5 or newer on your PC.
   - It refuses to run if the live database already has non-admin users. `npm run db:copy-local-data -- --merge`
     only adds missing rows and never overwrites.
4. **Security:** accounts whose password is a common password (for example `admin123`, `password123`)
   are copied **deactivated**, and the script prints them. Your local database currently has several
   (including administrators `admin` and `admin@example.com`). For each one you still need:
   *User Management → key icon → set a new password → activate*. Delete test accounts you don't need.
5. Remove your IP address from the database access list again.

---

## 5. After the first deploy: checklist

- [ ] Sign in as the administrator and change nothing else until the list below is done.
- [ ] Create or activate accounts for your team (Designer, Head of Designer, Customer).
- [ ] Remove `ADMIN_PASSWORD` from the web service environment (it is only used while no administrator exists).
- [ ] Render → database → confirm **backups / point-in-time recovery** are enabled for the plan.
- [ ] (Optional) Add a custom domain on the web service, then set `NEXTAUTH_URL=https://your-domain` and redeploy.
- [ ] Every future `git push` to the main branch redeploys automatically (`autoDeployTrigger: commit`).

---

## 6. Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL URL (set from the Render database automatically) |
| `NEXTAUTH_SECRET` | yes | Random secret for login sessions (generated by Render). Changing it logs everyone out. |
| `NEXTAUTH_URL` | no | Public site URL; defaults to Render's `RENDER_EXTERNAL_URL` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first deploy | First administrator, created only when no active administrator exists |
| `HF_API_KEY` | no | Hugging Face API key for AI artwork generation |
| `NODE_VERSION` | yes | `22` |

---

## 7. Security built into the app

- **Database:** on Render the app refuses to start unless `DATABASE_URL` is the Render PostgreSQL database.
  Connections from outside Render (external URL) are forced to use SSL. Keep the database *IP allow list* empty
  except while copying data.
- **Logins:** passwords are hashed with bcrypt, at least 8 characters, locked for 15 minutes after repeated
  failures (per account and network), and sessions expire after 12 hours. Deactivating or deleting an account
  or changing its role applies within seconds.
- **Attacks blocked:** cross-site requests (CSRF), clickjacking, script injection through uploaded images or
  thumbnails (only PNG/JPEG/WebP accepted), oversized uploads (max 60 MB per request, 40 MB per model,
  20 MB per brief), malformed requests, public-link bypass of the approval flow, and the unused Next.js image
  optimizer. A Content-Security-Policy only allows the site's own scripts, styles and API.
- **Limits:** AI artwork generation is limited to 30 per user per hour.
- **Your part:** use a strong, unique `ADMIN_PASSWORD`; give each person their own account; deactivate
  accounts of people who leave; keep `NEXTAUTH_SECRET` secret.

---

## 8. Local development (Windows)

- Run **`run.bat`**. The database is chosen by `DATABASE_URL` in `frontend/.env`:
  - `postgresql://...` (e.g. the Render database *External* URL, with your IP in its allow list): the app uses
    the Render database directly; `run.bat` applies migrations and the seed first.
  - `file:../dev.db`: an offline SQLite copy. `run.bat` generates a SQLite copy of the schema
    (`frontend/prisma/schema.sqlite.prisma`) and keeps the local database in sync.
- `frontend/prisma/schema.prisma` (PostgreSQL) is the source of truth. After changing the schema, create a
  migration against a PostgreSQL database (`npx prisma migrate dev --name <change>`) and commit
  `frontend/prisma/migrations/`. Render applies it on the next deploy.
- Don't run `npm run build` locally for everyday work. It generates the PostgreSQL client; `run.bat`
  switches back to SQLite automatically the next time you start it.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| Deploy fails in **pre-deploy** with `ADMIN_PASSWORD must be at least 10 characters` | Use a longer password in the environment and redeploy. |
| Log line `No administrator exists. Set ADMIN_EMAIL and ADMIN_PASSWORD` | Set both variables and redeploy. |
| Login works but redirects to the wrong address | Set `NEXTAUTH_URL` to the exact public URL (with `https://`). |
| Health check failing | Web service and database must be in the same region; check `DATABASE_URL`. |
| "Too many failed login attempts" | Wait 15 minutes (8 failed attempts per account and network, 30 per account overall). |
| Startup error `DATABASE_URL must point to the Render PostgreSQL database` | Set `DATABASE_URL` on the web service to the Render database (the Blueprint does this automatically). |
| Service restarts with out-of-memory errors | Upgrade the web service plan (see section 1). |
