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

/**
 * How long a mouse click on painted words waits before opening the thread, so the first click
 * of a double-click (selecting a word to comment on it) does not open the rail and reflow the
 * text under the second click. Touch opens at once: a long press, not a double tap, selects.
 */
const QUOTE_CLICK_DOUBLE_CLICK_MS = 300;

/**
 * The line boxes of the text a range covers. `Range.getClientRects()` also returns the border
 * box of every element wholly inside the range, so a quote spanning paragraphs or list items
 * would count blank block space as painted words.
 */
function textRects(range: Range): DOMRect[] {
  if (typeof range.getClientRects !== 'function') return [];
  const root = range.commonAncestorContainer as Node | undefined;
  if (!root || root.nodeType === Node.TEXT_NODE) return Array.from(range.getClientRects());
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!range.intersectsNode(node)) continue;
    const part = document.createRange();
    part.setStart(node, node === range.startContainer ? range.startOffset : 0);
    part.setEnd(node, node === range.endContainer ? range.endOffset : node.length);
    rects.push(...Array.from(part.getClientRects()));
  }
  return rects;
}

export function rangeContainsPoint(range: Range, x: number, y: number): boolean {
  return textRects(range).some(
    (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  );
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
 * Of the threads under a click, the one to open: the one already open if it is under the
 * pointer, else the newest open thread, else the newest. Overlapping comments all show in the
 * opened list; this picks the one it is focused on.
 */
export function threadToOpen<T extends { id: string; status: string; createdAt: number }>(
  threadIds: readonly string[],
  threads: readonly T[],
  openThreadId: string | null = null
): T | null {
  const hit = new Set(threadIds);
  const candidates = threads.filter((thread) => hit.has(thread.id));
  const alreadyOpen = candidates.find((thread) => thread.id === openThreadId);
  if (alreadyOpen) return alreadyOpen;
  const newest = (list: T[]) =>
    list.reduce<T | null>((best, t) => (!best || t.createdAt > best.createdAt ? t : best), null);
  return newest(candidates.filter((thread) => thread.status !== 'resolved')) ?? newest(candidates);
}

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null;
}

function hasSelection(): boolean {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed);
}

/**
 * Call `onActivate` with the quotes under a primary click inside `containerRef`, and show a
 * pointer while hovering them. Selecting text to comment on it keeps working: a click that
 * ends or dismisses a selection, a double or triple click, and a click on a control are all
 * left alone.
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

    // Read on press: by the time `click` fires, the press has already collapsed a selection
    // the person was only dismissing.
    let selectedAtPress = false;
    let pointerType = 'mouse';
    let pending: ReturnType<typeof setTimeout> | null = null;
    const cancelPending = () => {
      if (pending !== null) clearTimeout(pending);
      pending = null;
    };

    const onPointerDown = (event: PointerEvent) => {
      selectedAtPress = hasSelection();
      pointerType = event.pointerType || 'mouse';
    };

    const onClick = (event: MouseEvent) => {
      // The second click of a double click cancels the first one's open.
      cancelPending();
      if (event.button !== 0 || event.defaultPrevented || event.detail > 1) return;
      if (selectedAtPress || hasSelection()) return;
      const found = hits(event);
      if (found.length === 0) return;
      if (pointerType !== 'mouse') {
        onActivateRef.current(found);
        return;
      }
      pending = setTimeout(() => {
        pending = null;
        if (!hasSelection()) onActivateRef.current(found);
      }, QUOTE_CLICK_DOUBLE_CLICK_MS);
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

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('click', onClick);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerleave', onPointerLeave);
    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('click', onClick);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', onPointerLeave);
      cancelPending();
      if (frame) cancelAnimationFrame(frame);
      container.removeAttribute(QUOTE_HOVER_ATTRIBUTE);
    };
  }, [container, paintedRef, enabled]);
}
