import { useEffect, useState } from 'react';

/**
 * Matches Tailwind's `lg` breakpoint used by the message-row inline comment
 * split. Below this width, comment drafts remain mobile/tablet overlays or
 * inline panels; at and above it, the docked rail is the visible comment surface.
 */
const COMMENTS_RAIL_MEDIA_QUERY = '(min-width: 1024px)';

export function useCommentsRailViewport(): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(COMMENTS_RAIL_MEDIA_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia(COMMENTS_RAIL_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    setMatches(mediaQuery.matches);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return matches;
}
