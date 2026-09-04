"use client";

import { useCallback, useSyncExternalStore } from "react";

/// SSR-safe media query. During server rendering (and the hydration pass) it reports the
/// `serverValue` so the first client render matches the server HTML -- the real answer kicks in on
/// the first client-only render. Components using this must therefore be written so the
/// server-side answer is a sane default; desktop layouts here keep rendering inline on the server
/// and collapse into the mobile sheet only after hydration.
function subscribe(query: string, onChange: () => void) {
  const mql = window.matchMedia(query);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function useMediaQuery(query: string, serverValue: boolean): boolean {
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  const getServerSnapshot = useCallback(() => serverValue, [serverValue]);
  return useSyncExternalStore(
    (onChange) => subscribe(query, onChange),
    getSnapshot,
    getServerSnapshot
  );
}

/** Tailwind's `lg` breakpoint -- the width where two-column pages stop stacking. */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 1024px)", true);
}
