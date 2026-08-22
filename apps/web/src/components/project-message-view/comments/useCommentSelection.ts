import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

export interface ActiveMessageSelection {
  anchorId: string;
  quote: string;
  x: number;
  y: number;
}

const MIN_SELECTION_CHARS = 3;
const MAX_DISPLAY_QUOTE_CHARS = 240;
const SELECTION_SETTLE_MS = 280;

function truncateQuote(text: string): string {
  return text.length > MAX_DISPLAY_QUOTE_CHARS
    ? `${text.slice(0, MAX_DISPLAY_QUOTE_CHARS).trimEnd()}…`
    : text;
}

function findCommentAnchor(node: Node | null): HTMLElement | null {
  let element = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (element) {
    if (element.dataset.commentAnchor) return element;
    element = element.parentElement;
  }
  return null;
}

export function useCommentSelection(
  enabled: boolean,
  containerRef: RefObject<HTMLElement | null>
) {
  const [selection, setSelection] = useState<ActiveMessageSelection | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setSelection(null);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const readSelection = () => {
      const currentSelection = window.getSelection();
      const container = containerRef.current;

      // When the browser clears the Selection (Touch-to-Search dismiss, scroll,
      // tap elsewhere), keep the existing snapshot — it already holds anchorId +
      // quote.  Only explicit user actions (Dismiss, Comment, new selection
      // outside chat, session change) should clear it.
      if (!currentSelection || !container || currentSelection.isCollapsed || currentSelection.rangeCount === 0) {
        return;
      }

      const text = currentSelection.toString().trim();
      if (text.length < MIN_SELECTION_CHARS) {
        return;
      }

      const range = currentSelection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setSelection(null);
        return;
      }

      const anchor = findCommentAnchor(range.commonAncestorContainer);
      const anchorId = anchor?.dataset.commentAnchor;
      if (!anchorId || !container.contains(anchor)) {
        setSelection(null);
        return;
      }

      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return;
      }

      setSelection({
        anchorId,
        quote: truncateQuote(text),
        x: Math.min(Math.max(rect.left + rect.width / 2, 56), window.innerWidth - 56),
        y: Math.min(Math.max(rect.top, 44), window.innerHeight - 16),
      });
    };

    const scheduleRead = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(readSelection, SELECTION_SETTLE_MS);
    };

    const readNow = () => {
      if (timer.current) clearTimeout(timer.current);
      readSelection();
    };

    document.addEventListener('selectionchange', scheduleRead);
    document.addEventListener('mouseup', readNow);
    document.addEventListener('keyup', readNow);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('selectionchange', scheduleRead);
      document.removeEventListener('mouseup', readNow);
      document.removeEventListener('keyup', readNow);
    };
  }, [containerRef, enabled]);

  return { selection, clear };
}

export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(pointer: coarse)');
    const sync = () => setCoarse(mediaQuery.matches);
    sync();
    mediaQuery.addEventListener('change', sync);
    return () => mediaQuery.removeEventListener('change', sync);
  }, []);

  return coarse;
}
