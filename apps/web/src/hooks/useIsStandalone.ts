import { useState, useEffect } from 'react';

const QUERY = '(display-mode: standalone)';

/**
 * Returns true when the app is running as an installed PWA (standalone mode).
 * Covers both the standard `display-mode: standalone` media query and the
 * legacy `navigator.standalone` property used by older iOS Safari.
 */
export function useIsStandalone(): boolean {
  const [isStandalone, setIsStandalone] = useState(() => {
    if (typeof window === 'undefined') return false;
    return (
      window.matchMedia(QUERY).matches ||
      (navigator as { standalone?: boolean }).standalone === true
    );
  });

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const handler = (e: MediaQueryListEvent) => setIsStandalone(e.matches);
    mql.addEventListener('change', handler);
    // Sync in case SSR/hydration mismatch
    setIsStandalone(
      mql.matches ||
        (navigator as { standalone?: boolean }).standalone === true,
    );
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isStandalone;
}
