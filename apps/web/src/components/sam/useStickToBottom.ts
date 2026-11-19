import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Distance from the bottom, in CSS pixels, still treated as reading the newest message. */
const PINNED_THRESHOLD_PX = 80;

/**
 * Chat scrolling for a conversation that grows at the bottom and pages older
 * content in at the top. While the reader is at the bottom, new content keeps
 * them there; once they scroll up they are left alone; prepending older content
 * keeps the turn they were looking at in place (Safari has no scroll anchoring).
 *
 * `firstKey` identifies the oldest rendered item, so a prepend is detectable.
 */
export function useStickToBottom(firstKey: string | undefined) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const anchorRef = useRef<{ firstKey: string | undefined; height: number; top: number } | null>(
    null
  );
  const [showJump, setShowJump] = useState(false);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const pinned =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= PINNED_THRESHOLD_PX;
    pinnedRef.current = pinned;
    setShowJump(!pinned);
  }, []);

  const scrollToBottom = useCallback(() => {
    pinnedRef.current = true;
    setShowJump(false);
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, []);

  /** Call immediately before requesting older content. */
  const holdPosition = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    pinnedRef.current = false;
    anchorRef.current = { firstKey, height: scroller.scrollHeight, top: scroller.scrollTop };
  }, [firstKey]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const anchor = anchorRef.current;
    if (!scroller || !anchor || anchor.firstKey === firstKey) return;
    anchorRef.current = null;
    scroller.scrollTop = anchor.top + (scroller.scrollHeight - anchor.height);
  }, [firstKey]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const follow = () => {
      if (pinnedRef.current) scroller.scrollTop = scroller.scrollHeight;
    };
    follow();
    if (typeof ResizeObserver === 'undefined') return;
    // The scroller itself shrinks when the composer grows or the work panel opens.
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  return { scrollerRef, contentRef, onScroll, holdPosition, scrollToBottom, showJump };
}
