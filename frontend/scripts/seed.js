// Idempotent production seed. Safe to run on every deploy:
//  - creates the built-in (default) templates only if none exist
//  - creates the first Administrator from ADMIN_EMAIL / ADMIN_PASSWORD only if no active
//    Administrator exists yet (never changes an existing account or password)
const path = require("path");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function seedDefaultTemplates() {
  const existing = await prisma.template.count({ where: { isDefault: true } });
  if (existing > 0) {
    console.log(`[seed] ${existing} default templates already present`);
    return;
  }
  const templates = require(path.join(__dirname, "..", "prisma", "default-templates.json"));
  for (const t of templates) {
    await prisma.template.upsert({
      where: { slug: t.slug },
      update: {},
      create: {
        slug: t.slug,
        name: t.name,
        description: t.description,
        modelFile: t.modelFile,
        thumbnail: t.thumbnail,
        isPublic: t.isPublic,
        isDefault: true,
        editorState: t.editorState ? JSON.stringify(t.editorState) : null,
      },
    });
  }
  console.log(`[seed] created ${templates.length} default templates`);
}

async function seedAdmin() {
  const admins = await prisma.user.count({ where: { accountType: "Administrator", isActive: true } });
  if (admins > 0) {
    console.log(`[seed] ${admins} active administrator(s) already present`);
    return;
  }

  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || !password) {
    console.warn("[seed] No administrator exists. Set ADMIN_EMAIL and ADMIN_PASSWORD and redeploy to create one.");
    return;
  }
  if (password.length < 10) {
    throw new Error("ADMIN_PASSWORD must be at least 10 characters");
  }

  const hashed = await bcrypt.hash(password, 12);
  await prisma.user.upsert({
    where: { email },
    update: { accountType: "Administrator", isActive: true, password: hashed },
    create: { email, name: "Administrator", password: hashed, accountType: "Administrator" },
  });
  console.log(`[seed] created administrator ${email}`);
}

async function main() {
  await seedDefaultTemplates();
  await seedAdmin();
}

main()
  .catch((error) => {
    console.error("[seed] failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
