import { useMediaQuery } from '../../../hooks/useMediaQuery';

/**
 * Matches Tailwind's `lg` breakpoint used by the message-row inline comment
 * split. Below this width, comment drafts remain mobile/tablet overlays or
 * inline panels; at and above it, the docked rail is the visible comment surface.
 */
const COMMENTS_RAIL_MEDIA_QUERY = '(min-width: 1024px)';

export function useCommentsRailViewport(): boolean {
  return useMediaQuery(COMMENTS_RAIL_MEDIA_QUERY);
}
