import { useCallback, useSyncExternalStore } from 'react';

const hasMatchMedia = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function';

/**
 * Whether a CSS media query matches now, re-rendering when it starts or stops matching.
 * False where `matchMedia` is unavailable. The one implementation behind the breakpoint
 * hooks (`useIsMobile`, `useIsStandalone`, the comments rail and the workflow run page).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!hasMatchMedia()) return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query]
  );
  const snapshot = useCallback(() => hasMatchMedia() && window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
