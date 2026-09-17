import { prisma } from "@/lib/prisma";

// Every authenticated request re-checks the account (active? current role?). Pages such as the
// dashboard fire many requests at once (thumbnails, polling), so results are cached briefly.
// Admin changes to an account clear its entry immediately via invalidateAccount().
const TTL_MS = 10_000;
type Account = { accountType: string | null; isActive: boolean } | null;
const byId = new Map<string, { value: Account; at: number }>();
const byEmail = new Map<string, { value: Account; at: number }>();

async function cached(map: Map<string, { value: Account; at: number }>, key: string, load: () => Promise<Account>) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await load();
  map.set(key, { value, at: Date.now() });
  if (map.size > 5000) map.clear();
  return value;
}

export function getAccountById(id: string) {
  return cached(byId, id, () =>
    prisma.user.findUnique({ where: { id }, select: { accountType: true, isActive: true } })
  );
}

export function getAccountByEmail(email: string) {
  return cached(byEmail, email.toLowerCase(), () =>
    prisma.user.findUnique({ where: { email }, select: { accountType: true, isActive: true } })
  );
}

/** Call after changing or deleting an account so the change applies to the next request. */
export function invalidateAccounts() {
  byId.clear();
  byEmail.clear();
}
