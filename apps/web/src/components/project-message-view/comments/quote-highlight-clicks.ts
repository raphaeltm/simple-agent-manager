/**
 * Clicking painted quote words opens the comment they belong to.
 *
 * A CSS highlight is not an element, so it cannot take a click or a cursor itself. The
 * surface's container listens instead and tests the pointer against the client rects of the
 * ranges `useQuoteHighlights` last painted. The comment's own controls (its message chip,
 * its row in the comments list) stay the keyboard and screen-reader route to the same thread.
 */
import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

import {
  highlightsSupported,
  type PaintedQuote,
  type QuoteTarget,
  useAttachedElement,
} from './quote-highlight';

/** Set on the container while the pointer is over painted words; styled in `index.css`. */
export const QUOTE_HOVER_ATTRIBUTE = 'data-quote-hover';

/** Clicks on these keep their own meaning, even over painted words. */
const INTERACTIVE_SELECTOR =
  'a, button, input, textarea, select, summary, label, [role="button"], [contenteditable="true"]';

export function rangeContainsPoint(range: Range, x: number, y: number): boolean {
  if (typeof range.getClientRects !== 'function') return false;
  for (const rect of Array.from(range.getClientRects())) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}

/** The painted quotes under a point, the open comment's first. */
export function quotesAtPoint(
  painted: readonly PaintedQuote[],
  x: number,
  y: number
): QuoteTarget[] {
  return painted
    .filter((quote) => rangeContainsPoint(quote.range, x, y))
    .sort((a, b) => Number(b.active) - Number(a.active))
    .map((quote) => quote.target);
}

/**
 * Of the threads under a click, the one to open: the newest open thread, else the newest.
 * Overlapping comments all show in the opened list; this picks the one it is focused on.
 */
export function threadToOpen<T extends { id: string; status: string; createdAt: number }>(
  threadIds: readonly string[],
  threads: readonly T[]
): T | null {
  const hit = new Set(threadIds);
  const candidates = threads.filter((thread) => hit.has(thread.id));
  const newest = (list: T[]) =>
    list.reduce<T | null>((best, t) => (!best || t.createdAt > best.createdAt ? t : best), null);
  return newest(candidates.filter((thread) => thread.status !== 'resolved')) ?? newest(candidates);
}

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null;
}

/**
 * Call `onActivate` with the quotes under a primary click inside `containerRef`, and show a
 * pointer while hovering them. A click that ends a text selection, or lands on a control, is
 * left alone so selecting text to comment on it keeps working.
 */
export function useQuoteHighlightClicks(
  containerRef: RefObject<HTMLElement | null>,
  paintedRef: RefObject<readonly PaintedQuote[]>,
  onActivate: (targets: QuoteTarget[]) => void,
  enabled = true
): void {
  // Read through a ref so a new callback identity does not re-attach the listeners.
  const onActivateRef = useRef(onActivate);
  useLayoutEffect(() => {
    onActivateRef.current = onActivate;
  });

  const container = useAttachedElement(containerRef);

  useEffect(() => {
    if (!container || !enabled || !highlightsSupported()) return;

    const hits = (event: MouseEvent): QuoteTarget[] =>
      isInteractive(event.target)
        ? []
        : quotesAtPoint(paintedRef.current ?? [], event.clientX, event.clientY);

    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const found = hits(event);
      if (found.length > 0) onActivateRef.current(found);
    };

    let frame = 0;
    let lastMove: PointerEvent | null = null;
    const onPointerMove = (event: PointerEvent) => {
      lastMove = event;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (lastMove) container.toggleAttribute(QUOTE_HOVER_ATTRIBUTE, hits(lastMove).length > 0);
      });
    };
    const onPointerLeave = () => {
      lastMove = null;
      container.removeAttribute(QUOTE_HOVER_ATTRIBUTE);
    };

    container.addEventListener('click', onClick);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerleave', onPointerLeave);
    return () => {
      container.removeEventListener('click', onClick);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', onPointerLeave);
      if (frame) cancelAnimationFrame(frame);
      container.removeAttribute(QUOTE_HOVER_ATTRIBUTE);
    };
  }, [container, paintedRef, enabled]);
}
