import { useRef, useCallback, useState } from 'react';

/**
 * Threshold in pixels for determining whether the user is "at the bottom"
 * of a scroll container. A small tolerance accounts for fractional pixels,
 * browser rounding differences, and minor layout shifts.
 */
const DEFAULT_BOTTOM_THRESHOLD = 50;

export interface UseAutoScrollOptions {
  /**
   * Pixel distance from bottom within which the user is considered "at the bottom".
   * @default 50
   */
  bottomThreshold?: number;
}

export interface UseAutoScrollReturn {
  /** Callback ref — assign to the scrollable container's `ref` prop */
  scrollRef: (node: HTMLDivElement | null) => void;
  /** Whether the user is currently at (or near) the bottom */
  isAtBottom: boolean;
  /** Programmatically scroll to bottom and re-engage auto-scroll */
  scrollToBottom: () => void;
}

/**
 * Smart auto-scroll hook for chat-style containers.
 *
 * Behavior:
 * - When the user is at the bottom of the scroll container, new content
 *   automatically scrolls into view (both new messages and streaming chunks).
 * - When the user scrolls up to read earlier content, auto-scroll disengages
 *   so they aren't yanked back to the bottom.
 * - Scrolling back to the bottom re-engages auto-scroll.
 *
 * Uses a callback ref so observers are set up as soon as the DOM element mounts,
 * and torn down when it unmounts. ResizeObserver on children detects content
 * growth (streaming chunks, expanding tool calls); MutationObserver detects
 * new child elements (new messages appended to the list).
 */
export function useAutoScroll(options: UseAutoScrollOptions = {}): UseAutoScrollReturn {
  const { bottomThreshold = DEFAULT_BOTTOM_THRESHOLD } = options;

  // Stable ref to the DOM element for use in scrollToBottom
  const elementRef = useRef<HTMLDivElement | null>(null);
  // Track whether the user is "stuck to bottom" — start true so initial
  // messages auto-scroll.
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Cleanup ref for tearing down observers when node changes or unmounts
  const cleanupRef = useRef<(() => void) | null>(null);

  /**
   * Determine whether the scroll container is at (or near) the bottom.
   */
  const checkIsAtBottom = useCallback(
    (el: HTMLElement): boolean => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      return distanceFromBottom <= bottomThreshold;
    },
    [bottomThreshold],
  );

  /**
   * Callback ref: sets up scroll listener + ResizeObserver + MutationObserver
   * when the element mounts, and tears them down when it unmounts.
   *
   * Memory optimization: Uses a single ResizeObserver on the scroll container
   * itself (not individual children). Combined with a MutationObserver for
   * childList changes, this detects both new messages and streaming content
   * growth without creating per-child observers that accumulate over hundreds
   * of conversation items.
   */
  const scrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      // Tear down previous observers
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }

      elementRef.current = node;

      if (!node) return;

      // Coalesce rapid scroll-to-bottom requests into a single rAF
      let rafPending = false;
      const scheduleScrollToBottom = () => {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          if (elementRef.current && isAtBottomRef.current) {
            elementRef.current.scrollTop = elementRef.current.scrollHeight;
          }
        });
      };

      // --- Scroll listener ---
      const handleScroll = () => {
        const atBottom = checkIsAtBottom(node);
        isAtBottomRef.current = atBottom;
        setIsAtBottom(atBottom);
      };

      node.addEventListener('scroll', handleScroll, { passive: true });

      // --- ResizeObserver on the container (not individual children) ---
      // Fires when the container's content dimensions change (streaming
      // chunks expanding a message, new children added, etc.)
      const resizeObserver = new ResizeObserver(() => {
        if (isAtBottomRef.current) {
          scheduleScrollToBottom();
        }
      });

      resizeObserver.observe(node);

      // --- MutationObserver for new children ---
      const mutationObserver = new MutationObserver(() => {
        if (isAtBottomRef.current) {
          scheduleScrollToBottom();
        }
      });

      mutationObserver.observe(node, { childList: true, subtree: true });

      // Store cleanup
      cleanupRef.current = () => {
        node.removeEventListener('scroll', handleScroll);
        resizeObserver.disconnect();
        mutationObserver.disconnect();
      };
    },
    [checkIsAtBottom],
  );

  /**
   * Scroll to the very bottom of the container.
   */
  const scrollToBottom = useCallback(() => {
    const el = elementRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    isAtBottomRef.current = true;
    setIsAtBottom(true);
  }, []);

  return { scrollRef, isAtBottom, scrollToBottom };
}
