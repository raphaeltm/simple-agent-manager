/**
 * Detects a text selection inside a container and reports the quote plus the
 * anchor id of the nearest commentable block.
 *
 * Anchoring strategy: every commentable region carries `data-comment-anchor="<id>"`.
 * We walk up from the selection's common ancestor to find it. In production this
 * is exactly how a message id or a markdown block id would be recovered.
 */

import { useCallback, useEffect, useState } from 'react';

export interface ActiveSelection {
  anchorId: string;
  quote: string;
  /** Viewport coordinates for the floating "Comment" chip. */
  x: number;
  y: number;
}

/** Selections shorter than this are almost always accidental drags, not intent. */
const MIN_SELECTION_CHARS = 3;
/** Keeps a quoted anchor from swallowing an entire message. */
const MAX_QUOTE_CHARS = 240;

function findAnchorId(node: Node | null): string | null {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el) {
    const id = el.dataset?.commentAnchor;
    if (id) return id;
    el = el.parentElement;
  }
  return null;
}

export function useCommentSelection(enabled: boolean) {
  const [selection, setSelection] = useState<ActiveSelection | null>(null);

  const clear = useCallback(() => setSelection(null), []);

  useEffect(() => {
    if (!enabled) return;

    function read() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const text = sel.toString().trim();
      if (text.length < MIN_SELECTION_CHARS) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const anchorId = findAnchorId(range.commonAncestorContainer);
      if (!anchorId) {
        setSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSelection(null);
        return;
      }
      setSelection({
        anchorId,
        quote:
          text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS).trimEnd()}…` : text,
        // The chip is position:fixed, so these are viewport coordinates. Clamp on
        // BOTH axes: a selection can sit above or below the fold (long agent
        // messages routinely exceed a 375px viewport), and an unclamped chip is
        // rendered but unreachable — which reads to the user as "nothing happened".
        x: Math.min(Math.max(rect.left + rect.width / 2, 56), window.innerWidth - 56),
        y: Math.min(Math.max(rect.top, 44), window.innerHeight - 16),
      });
    }

    // `selectionchange` fires continuously during a drag; reading on mouseup/keyup
    // instead means we only measure a settled selection.
    document.addEventListener('mouseup', read);
    document.addEventListener('keyup', read);
    document.addEventListener('touchend', read);
    return () => {
      document.removeEventListener('mouseup', read);
      document.removeEventListener('keyup', read);
      document.removeEventListener('touchend', read);
    };
  }, [enabled]);

  return { selection, clear };
}
