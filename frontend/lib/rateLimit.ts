// Small in-memory fixed-window rate limiter (per app instance).
const buckets = new Map<string, { count: number; start: number }>();

/** Returns true when the call is allowed; false once `max` calls happened within `windowMs`. */
export function allowRequest(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.start > windowMs) {
    buckets.set(key, { count: 1, start: now });
    if (buckets.size > 20000) {
      buckets.forEach((v, k) => {
        if (now - v.start > windowMs) buckets.delete(k);
      });
    }
    return true;
  }
  bucket.count++;
  return bucket.count <= max;
}
