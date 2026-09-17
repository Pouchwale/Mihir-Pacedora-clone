import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

const isPostgres = (url: string) => /^postgres(ql)?:\/\//.test(url);

/**
 * Database URL with production-safe settings:
 * - On Render the app must use the Render PostgreSQL database (never a local SQLite file).
 * - Connections to a Render database from outside Render (external URL) are forced to use SSL.
 * - More pooled connections than Prisma's default (2 x CPUs + 1, only 3 on a 1-CPU instance),
 *   unless DATABASE_URL sets connection_limit explicitly.
 */
function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (process.env.RENDER && (!url || !isPostgres(url))) {
    throw new Error("DATABASE_URL must point to the Render PostgreSQL database");
  }
  if (!url || !isPostgres(url)) return url;

  const params: string[] = [];
  if (!/[?&]connection_limit=/.test(url)) params.push("connection_limit=10", "pool_timeout=20");
  if (/\.render\.com/.test(url) && !/[?&]sslmode=/.test(url)) params.push("sslmode=require");
  return params.length ? `${url}${url.includes("?") ? "&" : "?"}${params.join("&")}` : url;
}

function createClient() {
  const url = databaseUrl();
  return new PrismaClient({
    log: process.env.PRISMA_LOG_QUERIES === "true" ? ["query", "warn", "error"] : ["warn", "error"],
    ...(url ? { datasources: { db: { url } } } : {}),
  });
}

export const prisma = global.prisma || createClient();

if (process.env.NODE_ENV !== "production") global.prisma = prisma;
