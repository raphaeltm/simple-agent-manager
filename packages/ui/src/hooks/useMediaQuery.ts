import { useSyncExternalStore } from 'react';

/**
 * Subscribe to a CSS media query using `useSyncExternalStore`.
 * Returns a consistent snapshot during render — no state/effect needed.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onStoreChange);
      return () => mql.removeEventListener('change', onStoreChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
