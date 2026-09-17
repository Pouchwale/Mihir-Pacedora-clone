"use client";

import { useEffect, useRef } from "react";

/**
 * Runs `fn` immediately and then every `intervalMs` while enabled.
 * Skips ticks while the tab is hidden and refreshes as soon as it becomes visible again.
 */
export function usePolling(fn: () => void, intervalMs: number, enabled = true) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (!document.hidden) fnRef.current();
    };
    fnRef.current();
    const interval = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [intervalMs, enabled]);
}
