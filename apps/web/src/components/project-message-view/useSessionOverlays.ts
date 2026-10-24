/**
 * Which of the chat's on-demand surfaces is open.
 *
 * Six booleans and twelve handlers for the panels the session tool rail opens — Timeline,
 * Comments, Resources, Automation, Related and Share. They lived inline in
 * `SessionMessageView`, which this extraction keeps under the 500-line ceiling
 * (`.claude/rules/18-file-size-limits.md`); the behaviour is unchanged.
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

export function useSessionOverlays(): SessionOverlays {
  const [showTimeline, setShowTimeline] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [showResources, setShowResources] = useState(false);
  const [showAutomation, setShowAutomation] = useState(false);
  const [showRelated, setShowRelated] = useState(false);
  const [showShare, setShowShare] = useState(false);

  const openTimeline = useCallback(() => setShowTimeline(true), []);
  const closeTimeline = useCallback(() => setShowTimeline(false), []);
  const openComments = useCallback(() => setShowComments(true), []);
  const closeComments = useCallback(() => setShowComments(false), []);
  const openResources = useCallback(() => setShowResources(true), []);
  const closeResources = useCallback(() => setShowResources(false), []);
  const openAutomation = useCallback(() => setShowAutomation(true), []);
  const closeAutomation = useCallback(() => setShowAutomation(false), []);
  const openRelated = useCallback(() => setShowRelated(true), []);
  const closeRelated = useCallback(() => setShowRelated(false), []);
  const openShare = useCallback(() => setShowShare(true), []);
  const closeShare = useCallback(() => setShowShare(false), []);

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
