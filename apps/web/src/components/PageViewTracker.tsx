import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

import { getInitialReferrer,track } from '../lib/analytics';

/**
 * Invisible component that tracks page views on route changes.
 * Must be rendered inside <BrowserRouter>.
 *
 * Tracks:
 * - Page pathname on every route change
 * - Time spent on the previous page (sent as durationMs)
 * - Document referrer on the first page view
 */
export function PageViewTracker() {
  const location = useLocation();
  const prevPathRef = useRef<string | null>(null);
  const prevTimeRef = useRef<number>(performance.now());
  const isFirstRef = useRef(true);

  useEffect(() => {
    const currentPath = location.pathname;
    const now = performance.now();

    // Send duration for the previous page view (skip on first render)
    if (prevPathRef.current !== null && prevPathRef.current !== currentPath) {
      const durationMs = Math.round(now - prevTimeRef.current);
      track('page_duration', {
        page: prevPathRef.current,
        durationMs,
      });
    }

    // Track the new page view
    const referrer = isFirstRef.current ? getInitialReferrer() : '';
    track('page_view', {
      page: currentPath,
      referrer,
    });

    prevPathRef.current = currentPath;
    prevTimeRef.current = now;
    isFirstRef.current = false;
  }, [location.pathname]);

  return null;
}
