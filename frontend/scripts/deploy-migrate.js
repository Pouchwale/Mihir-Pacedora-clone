// Runs before each deploy on Render (preDeployCommand):
//  1. Applies database migrations.
//     A database created earlier with `prisma db push` (tables exist but no migration history)
//     is first brought up to date with a non-destructive push and then marked as baselined.
//  2. Runs the idempotent seed (default templates + first administrator).
const { execSync } = require("child_process");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const root = path.join(__dirname, "..", "..");
const schema = "frontend/prisma/schema.prisma";
const run = (cmd) => execSync(cmd, { stdio: "inherit", cwd: root });

async function hasTable(prisma, name) {
  const rows = await prisma.$queryRaw`SELECT to_regclass(${`public."${name}"`})::text AS t`;
  return !!rows[0]?.t;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

  const prisma = new PrismaClient();
  let legacy = false;
  try {
    legacy = (await hasTable(prisma, "User")) && !(await hasTable(prisma, "_prisma_migrations"));
  } finally {
    await prisma.$disconnect();
  }

  if (legacy) {
    console.log("[migrate] Existing database without migration history: syncing schema (non-destructive)");
    // Fails instead of dropping data if a destructive change would be needed
    run(`npx prisma db push --schema ${schema} --skip-generate`);
    run(`npx prisma migrate resolve --schema ${schema} --applied 0_init`);
  }

  run(`npx prisma migrate deploy --schema ${schema}`);
  run("node frontend/scripts/seed.js");
}

main().catch((error) => {
  console.error("[migrate] failed:", error.message || error);
  process.exit(1);
});
