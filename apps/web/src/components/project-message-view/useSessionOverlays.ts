/**
 * Which of the chat's on-demand surfaces is open.
 *
 * Six booleans and twelve handlers for the panels the session tool rail opens — Timeline,
 * Comments, Resources, Automation, Related and Share. They lived inline in
 * `SessionMessageView`, which this extraction keeps under the 500-line ceiling
 * (`.claude/rules/18-file-size-limits.md`).
 *
 * Every handler is `useCallback`-stable, which is load-bearing rather than tidy: they feed
 * `useSessionTools`' memoised action array, and an inline arrow would hand the rail a new prop
 * identity on every poll tick and remount the whole strip mid-interaction
 * (`apps/web/.claude/rules/64-unstable-prop-identity-remounts-subtrees.md`). The returned
 * object is memoised for the same reason, so passing it down as one prop is safe.
 */
import { useCallback, useMemo, useState } from 'react';

export interface SessionOverlays {
  showTimeline: boolean;
  openTimeline: () => void;
  closeTimeline: () => void;
  showComments: boolean;
  openComments: () => void;
  closeComments: () => void;
  showResources: boolean;
  openResources: () => void;
  closeResources: () => void;
  showAutomation: boolean;
  openAutomation: () => void;
  closeAutomation: () => void;
  showRelated: boolean;
  openRelated: () => void;
  closeRelated: () => void;
  showShare: boolean;
  openShare: () => void;
  closeShare: () => void;
}

/**
 * The drawers and dialogs the rail opens are exclusive: opening one closes the others, because
 * each is a SAM Glass overlay and only one live blur may be on screen at a time
 * (`apps/web/.claude/rules/80-sam-glass.md`). Comments stay independent: on desktop they are a
 * rail docked inside the conversation, not an overlay, and must survive opening Timeline.
 */
type ExclusivePanel = 'timeline' | 'resources' | 'automation' | 'related' | 'share';

export function useSessionOverlays(): SessionOverlays {
  const [panel, setPanel] = useState<ExclusivePanel | null>(null);
  const [showComments, setShowComments] = useState(false);
  const closeIf = useCallback(
    (target: ExclusivePanel) => setPanel((current) => (current === target ? null : current)),
    []
  );

  const showTimeline = panel === 'timeline';
  const showResources = panel === 'resources';
  const showAutomation = panel === 'automation';
  const showRelated = panel === 'related';
  const showShare = panel === 'share';

  const openTimeline = useCallback(() => setPanel('timeline'), []);
  const closeTimeline = useCallback(() => closeIf('timeline'), [closeIf]);
  const openComments = useCallback(() => setShowComments(true), []);
  const closeComments = useCallback(() => setShowComments(false), []);
  const openResources = useCallback(() => setPanel('resources'), []);
  const closeResources = useCallback(() => closeIf('resources'), [closeIf]);
  const openAutomation = useCallback(() => setPanel('automation'), []);
  const closeAutomation = useCallback(() => closeIf('automation'), [closeIf]);
  const openRelated = useCallback(() => setPanel('related'), []);
  const closeRelated = useCallback(() => closeIf('related'), [closeIf]);
  const openShare = useCallback(() => setPanel('share'), []);
  const closeShare = useCallback(() => closeIf('share'), [closeIf]);

  return useMemo(
    () => ({
      showTimeline,
      openTimeline,
      closeTimeline,
      showComments,
      openComments,
      closeComments,
      showResources,
      openResources,
      closeResources,
      showAutomation,
      openAutomation,
      closeAutomation,
      showRelated,
      openRelated,
      closeRelated,
      showShare,
      openShare,
      closeShare,
    }),
    [
      showTimeline,
      openTimeline,
      closeTimeline,
      showComments,
      openComments,
      closeComments,
      showResources,
      openResources,
      closeResources,
      showAutomation,
      openAutomation,
      closeAutomation,
      showRelated,
      openRelated,
      closeRelated,
      showShare,
      openShare,
      closeShare,
    ]
  );
}
