// Simple in-memory brute-force protection for the credentials login.
// Suitable for a single app instance (one Render web service instance). If the service is
// scaled to several instances, each keeps its own counters.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;

const failures = new Map<string, { count: number; first: number }>();

export function assertLoginAllowed(key: string, maxFailures = MAX_FAILURES) {
  const entry = failures.get(key);
  if (!entry) return;
  if (Date.now() - entry.first > WINDOW_MS) {
    failures.delete(key);
    return;
  }
  if (entry.count >= maxFailures) {
    const minutes = Math.ceil((WINDOW_MS - (Date.now() - entry.first)) / 60000);
    throw new Error(`Too many failed login attempts. Try again in ${minutes} minute(s).`);
  }
}

export function recordLoginFailure(key: string) {
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || now - entry.first > WINDOW_MS) {
    failures.set(key, { count: 1, first: now });
  } else {
    entry.count++;
  }
  // Keep memory bounded
  if (failures.size > 10000) {
    failures.forEach((v, k) => {
      if (now - v.first > WINDOW_MS) failures.delete(k);
    });
  }
}

export function clearLoginFailures(key: string) {
  failures.delete(key);
}
