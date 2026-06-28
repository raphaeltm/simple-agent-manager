import { useMediaQuery } from '@simple-agent-manager/ui';

const QUERY = '(display-mode: standalone)';

/**
 * Returns true when the app is running as an installed PWA (standalone mode).
 * Covers both the standard `display-mode: standalone` media query and the
 * legacy `navigator.standalone` property used by older iOS Safari.
 */
export function useIsStandalone(): boolean {
  const matchesQuery = useMediaQuery(QUERY);
  const iosStandalone =
    typeof navigator !== 'undefined' &&
    (navigator as { standalone?: boolean }).standalone === true;
  return matchesQuery || iosStandalone;
}
