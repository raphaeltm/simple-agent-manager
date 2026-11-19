import { useMediaQuery } from './useMediaQuery';

const MOBILE_BREAKPOINT = 767;
const QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;

/**
 * Returns true when the viewport is at or below the mobile breakpoint (767px), following
 * resize and orientation changes.
 */
export function useIsMobile(): boolean {
  return useMediaQuery(QUERY);
}
