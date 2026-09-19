import { prisma } from "@/lib/prisma";
import { DEFAULT_KEYLINES, sanitizeKeyline, type Keyline, type PouchType } from "@/lib/dieline/types";

export const KEYLINE_KEY_PREFIX = "keyline:";
const POUCH_TYPES = Object.keys(DEFAULT_KEYLINES) as PouchType[];

/** Built-in keyline defaults overridden by whatever an administrator saved. */
export async function loadKeylineDefaults(): Promise<Record<PouchType, Keyline>> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: KEYLINE_KEY_PREFIX } } });
  const result = { ...DEFAULT_KEYLINES } as Record<PouchType, Keyline>;
  for (const row of rows) {
    const type = row.key.slice(KEYLINE_KEY_PREFIX.length) as PouchType;
    if (!POUCH_TYPES.includes(type)) continue;
    try {
      result[type] = sanitizeKeyline(JSON.parse(row.value), DEFAULT_KEYLINES[type]);
    } catch {
      // ignore a corrupt row: the built-in default stays
    }
  }
  return result;
}

