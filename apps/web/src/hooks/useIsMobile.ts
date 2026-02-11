import { useState, useEffect } from 'react';

const MOBILE_BREAKPOINT = 767;
const QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;

/**
 * Returns true when the viewport is at or below the mobile breakpoint (767px).
 * Listens for resize/orientation changes via matchMedia.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    // Sync in case SSR/hydration mismatch
    setIsMobile(mql.matches);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}
