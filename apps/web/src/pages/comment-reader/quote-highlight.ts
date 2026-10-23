/**
 * Find a comment's quoted words inside the rendered message, paint them, and place them on
 * screen.
 *
 * Painting uses the CSS Custom Highlight API: it styles ranges without touching the DOM, so
 * it works on top of the markdown renderer and cannot disturb text selection or React's
 * reconciliation. Where the API is missing the reader still lands on the message and marks it.
 */
import { type RefObject, useLayoutEffect } from 'react';

/** Highlight names, styled in `index.css`. */
export const ACTIVE_QUOTE_HIGHLIGHT = 'sam-comment-quote';
export const OTHER_QUOTE_HIGHLIGHT = 'sam-comment-quote-other';

/**
 * Words of the quote used when the whole quote cannot be matched (a long quote truncated with
 * "…" on capture, or redacted on save): enough to find where the passage starts.
 */
const QUOTE_LEAD_WORDS = 8;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The quote as it can be matched: no capture ellipsis, no surrounding whitespace. */
export function matchableQuote(quote: string | null | undefined): string {
  return (quote ?? '').replace(/(?:…|\.\.\.)\s*$/u, '').trim();
}

function rangeOver(nodes: Text[], starts: number[], index: number, length: number): Range | null {
  const end = index + length;
  const range = document.createRange();
  let started = false;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i] as Text;
    const nodeStart = starts[i] as number;
    const nodeEnd = nodeStart + node.data.length;
    if (!started && index >= nodeStart && index < nodeEnd) {
      range.setStart(node, index - nodeStart);
      started = true;
    }
    if (started && end > nodeStart && end <= nodeEnd) {
      range.setEnd(node, end - nodeStart);
      return range;
    }
  }
  return null;
}

/**
 * A Range over `quote` in `root`'s text. Whitespace may differ (a selection reads paragraph
 * breaks as newlines the DOM text does not have), so words are matched with any whitespace
 * between them. Falls back to the quote's first words.
 */
export function findTextRange(root: Node, quote: string): Range | null {
  const needle = matchableQuote(quote);
  if (!needle) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    starts.push(text.length);
    nodes.push(node);
    text += node.data;
  }
  const exact = text.indexOf(needle);
  if (exact !== -1) return rangeOver(nodes, starts, exact, needle.length);

  const words = needle.split(/\s+/).filter(Boolean);
  for (const count of [words.length, Math.min(words.length, QUOTE_LEAD_WORDS)]) {
    if (count === 0) continue;
    const pattern = words.slice(0, count).map(escapeRegExp).join('\\s*');
    const match = new RegExp(pattern, 'u').exec(text);
    if (match) return rangeOver(nodes, starts, match.index, match[0].length);
  }
  return null;
}

export interface QuoteTarget {
  /** Rendered item the quote is in (`data-reader-item`). */
  itemId: string;
  quote: string | null | undefined;
}

/** The element that renders `itemId` inside `container`. */
export function itemElement(container: HTMLElement | null, itemId: string): HTMLElement | null {
  if (!container) return null;
  // Compared as data rather than interpolated into a selector, so no id needs escaping.
  for (const element of container.querySelectorAll<HTMLElement>('[data-reader-item]')) {
    if (element.dataset.readerItem === itemId) return element;
  }
  return null;
}

export function quoteRange(container: HTMLElement | null, target: QuoteTarget): Range | null {
  const element = itemElement(container, target.itemId);
  return element && target.quote ? findTextRange(element, target.quote) : null;
}

function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';
}

/**
 * Paint the open comment's quote strongly and the other loaded comments' quotes faintly.
 * `renderKey` changes whenever the rendered rows change, so ranges are found again.
 */
export function useQuoteHighlights(
  containerRef: RefObject<HTMLElement | null>,
  active: QuoteTarget | null,
  others: readonly QuoteTarget[],
  renderKey: string
): void {
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !highlightsSupported()) return;
    const activeRange = active ? quoteRange(container, active) : null;
    const otherRanges = others
      .map((target) => quoteRange(container, target))
      .filter((range): range is Range => range !== null);
    CSS.highlights.set(
      ACTIVE_QUOTE_HIGHLIGHT,
      new Highlight(...(activeRange ? [activeRange] : []))
    );
    CSS.highlights.set(OTHER_QUOTE_HIGHLIGHT, new Highlight(...otherRanges));
    return () => {
      CSS.highlights.delete(ACTIVE_QUOTE_HIGHLIGHT);
      CSS.highlights.delete(OTHER_QUOTE_HIGHLIGHT);
    };
  }, [containerRef, active, others, renderKey]);
}

/**
 * Scroll `scroller` so `box` sits at `ratio` of its visible height (0 = top), where the
 * bottom `bottomInset` px are covered (the phone thread sheet).
 */
export function scrollBoxIntoView(
  scroller: HTMLElement,
  box: DOMRect,
  ratio: number,
  bottomInset = 0
): void {
  const view = scroller.getBoundingClientRect();
  const visible = Math.max(0, view.height - bottomInset);
  scroller.scrollTop += box.top - view.top - visible * ratio;
}

/** Where `box` is relative to the scroller's visible area, less `bottomInset` px it hides. */
export function boxPlacement(
  scroller: HTMLElement,
  box: DOMRect,
  bottomInset = 0
): 'above' | 'visible' | 'below' {
  const view = scroller.getBoundingClientRect();
  if (box.bottom < view.top + 8) return 'above';
  if (box.top > view.bottom - bottomInset - 8) return 'below';
  return 'visible';
}
