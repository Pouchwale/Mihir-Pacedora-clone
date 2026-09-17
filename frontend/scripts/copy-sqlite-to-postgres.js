// One-time copy of the local SQLite data (frontend/dev.db) into a PostgreSQL database,
// e.g. the Render database, using its EXTERNAL connection URL.
//
// Usage (from the project root, after the target database has been migrated by a deploy):
//   set TARGET_DATABASE_URL=postgresql://user:pass@host/db     (PowerShell: $env:TARGET_DATABASE_URL="...")
//   node frontend/scripts/copy-sqlite-to-postgres.js [--merge]
//
// - Requires Node.js 22.5+ (uses the built-in node:sqlite module).
// - Refuses to run when the target already contains users other than seeded administrators,
//   unless --merge is given. Existing rows are never overwritten (ON CONFLICT DO NOTHING).
// - Users that already exist in the target (same email) are matched by email, so designs keep
//   their author.
// - SECURITY: accounts whose password is a common/default password (e.g. admin123, password123)
//   are copied DEACTIVATED. Set a new password in User Management, then activate them.
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, "..", "dev.db");
const TARGET = process.env.TARGET_DATABASE_URL;
const MERGE = process.argv.includes("--merge");

const WEAK_PASSWORDS = [
  "password", "password1", "password123", "123456", "12345678", "123456789", "qwerty", "admin", "admin123",
  "admin@123", "designer123", "director123", "customer123", "test123", "test1234", "welcome123", "abc123",
];

// Copy order respects foreign keys. Sessions are skipped (the app uses JWT sessions).
const TABLES = ["User", "Account", "Template", "ApprovalRequest", "AppSetting", "VerificationToken"];

function convert(value, dataType) {
  if (value === null || value === undefined) return null;
  if (dataType.startsWith("timestamp")) {
    const d = typeof value === "number" || /^\d+$/.test(String(value)) ? new Date(Number(value)) : new Date(value);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid date value: ${value}`);
    return d;
  }
  if (dataType === "boolean") return value === true || value === 1 || value === "1" || value === "true";
  if (dataType === "integer" || dataType === "bigint") return Number(value);
  return typeof value === "bigint" ? value.toString() : value;
}

async function main() {
  if (!TARGET) throw new Error("Set TARGET_DATABASE_URL to the Render database EXTERNAL connection URL");
  const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });
  const pg = new Client({
    connectionString: TARGET,
    ssl: /localhost|127\.0\.0\.1/.test(TARGET) ? false : { rejectUnauthorized: true },
  });
  await pg.connect();

  try {
    const hasSchema = await pg.query(`SELECT to_regclass('public."User"')::text AS t`);
    if (!hasSchema.rows[0].t) {
      throw new Error("Target database has no tables yet. Deploy the app on Render first (it runs the migrations).");
    }
    const nonAdmins = await pg.query(`SELECT count(*)::int AS n FROM "User" WHERE "accountType" IS DISTINCT FROM 'Administrator'`);
    if (nonAdmins.rows[0].n > 0 && !MERGE) {
      throw new Error(`Target already has ${nonAdmins.rows[0].n} non-admin users. Re-run with --merge to add missing rows only.`);
    }

    // Local user id -> target user id (matched by email when the user already exists)
    const userIdMap = new Map();
    const weakAccounts = [];
    const targetUsers = await pg.query(`SELECT id, lower(email) AS email FROM "User"`);
    const targetByEmail = new Map(targetUsers.rows.map((u) => [u.email, u.id]));

    for (const table of TABLES) {
      const exists = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      if (!exists) {
        console.log(`- ${table}: not in local database, skipped`);
        continue;
      }
      const colsRes = await pg.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
        [table]
      );
      const pgTypes = new Map(colsRes.rows.map((r) => [r.column_name, r.data_type]));
      const localCols = sqlite.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
      const columns = localCols.filter((c) => pgTypes.has(c));

      const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
      let inserted = 0;
      let skipped = 0;
      for (const row of rows) {
        if (table === "User") {
          row.email = String(row.email).trim().toLowerCase();
          const existingId = targetByEmail.get(row.email);
          userIdMap.set(row.id, existingId || row.id);
          if (existingId) {
            skipped++;
            continue;
          }
          if (row.password && WEAK_PASSWORDS.some((w) => bcrypt.compareSync(w, row.password))) {
            row.isActive = 0;
            weakAccounts.push(`${row.email} (${row.accountType})`);
          }
        }
        if (table === "Account" || table === "Template") {
          const key = table === "Account" ? "userId" : "authorId";
          if (row[key]) row[key] = userIdMap.get(row[key]) ?? row[key];
        }
        if (table === "User" && row.accountType === "Director") {
          // The Director role was replaced by Head of Designer
          row.accountType = "Head of Designer";
        }
        if (table === "AppSetting" && row.key === "customerSharingRole") {
          skipped++;
          continue; // setting no longer exists
        }
        if (table === "ApprovalRequest") {
          if (row.status === "PENDING_HEAD") row.status = "PENDING";
          if (row.customerEmail) row.customerEmail = String(row.customerEmail).trim().toLowerCase();
          if (row.designerEmail) row.designerEmail = String(row.designerEmail).trim().toLowerCase();
        }

        const values = columns.map((c) => convert(row[c], pgTypes.get(c)));
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
        const sql = `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
        const res = await pg.query(sql, values);
        if (res.rowCount) inserted++;
        else skipped++;
      }
      console.log(`- ${table}: ${inserted} copied, ${skipped} already present`);
    }
    if (weakAccounts.length) {
      console.log("\nSECURITY: these accounts use a common password and were copied DEACTIVATED:");
      weakAccounts.forEach((a) => console.log(`  - ${a}`));
      console.log("Log in as the administrator, set a new password for each (key icon), then activate them.");
    }
    console.log("Done.");
  } finally {
    sqlite.close();
    await pg.end();
  }
}

main().catch((error) => {
  console.error("Copy failed:", error.message || error);
  process.exit(1);
});
