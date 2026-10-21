import { useMediaQuery } from './useMediaQuery';

const QUERY = '(display-mode: standalone)';

/**
 * Returns true when the app is running as an installed PWA (standalone mode).
 * Covers both the standard `display-mode: standalone` media query and the
 * legacy `navigator.standalone` property used by older iOS Safari.
 */
export function useIsStandalone(): boolean {
  const displayStandalone = useMediaQuery(QUERY);
  return (
    displayStandalone ||
    (typeof navigator !== 'undefined' &&
      (navigator as { standalone?: boolean }).standalone === true)
  );
}
