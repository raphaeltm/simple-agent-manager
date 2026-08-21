/**
 * Detects a text selection inside a container and reports the quote plus the
 * anchor id of the nearest commentable block.
 *
 * Anchoring strategy: every commentable region carries `data-comment-anchor="<id>"`.
 * We walk up from the selection's common ancestor to find it. In production this
 * is exactly how a message id or a markdown block id would be recovered.
 *
 * TRIGGER CHOICE (this is the whole correctness story on mobile):
 * `selectionchange` is the only event that fires for every way a selection can be
 * made. An earlier version listened to mouseup/keyup/touchend only, which works on
 * desktop and is silently dead on a phone:
 *   - long-press selection settles *after* `touchend`, so reading on touchend sees
 *     a collapsed selection;
 *   - dragging the native selection handles afterwards emits NO touchend on
 *     document at all, so adjusting a selection produced nothing.
 * mouseup/keyup are kept purely so desktop gets an instant response instead of
 * waiting out the debounce.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ActiveSelection {
  anchorId: string;
  quote: string;
  /** Viewport coordinates for the floating chip (fine pointers only). */
  x: number;
  y: number;
}

/** Selections shorter than this are almost always accidental drags, not intent. */
const MIN_SELECTION_CHARS = 3;
/** Keeps a quoted anchor from swallowing an entire message. */
const MAX_QUOTE_CHARS = 240;
/**
 * Quiet period before a `selectionchange` burst is treated as settled. Long-press
 * and handle-drag both emit a stream of these; reading on every one would make the
 * affordance strobe while the user is still adjusting.
 */
const SELECTION_SETTLE_MS = 280;

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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setSelection(null);
  }, []);

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

    function schedule() {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(read, SELECTION_SETTLE_MS);
    }

    function readNow() {
      if (timer.current) clearTimeout(timer.current);
      read();
    }

    document.addEventListener('selectionchange', schedule);
    document.addEventListener('mouseup', readNow);
    document.addEventListener('keyup', readNow);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('mouseup', readNow);
      document.removeEventListener('keyup', readNow);
    };
  }, [enabled]);

  return { selection, clear };
}

/**
 * True when the primary input is touch. Drives affordance placement: a floating
 * chip beside the selection is right for a mouse, but on a phone it fights the
 * OS's own selection callout (Copy / Look Up), which renders in the same spot and
 * wins. Touch gets a bottom bar instead — out of the callout's way and in the
 * thumb zone.
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const sync = () => setCoarse(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return coarse;
}
