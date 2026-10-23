/**
 * Find a comment's quoted passage inside the rendered message, highlight it, and scroll the
 * passage (not the message) into view.
 *
 * Uses the CSS Custom Highlight API: it paints ranges without touching the DOM, so it works
 * on top of the production markdown renderer and cannot disturb text selection or React's
 * reconciliation. Chromium 105+, Safari 17.2+, Firefox 140+.
 */
import { type RefObject, useLayoutEffect } from 'react';

const ACTIVE = 'ctx-quote-active';
const OTHER = 'ctx-quote-other';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A Range over `quote` inside `root`'s text, tolerant of whitespace and markup differences. */
export function findTextRange(root: Node, quote: string): Range | null {
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
  let index = text.indexOf(quote);
  let length = quote.length;
  if (index === -1) {
    const pattern = quote.trim().split(/\s+/).map(escapeRegExp).join('\\s*');
    const match = new RegExp(pattern).exec(text);
    if (!match) return null;
    index = match.index;
    length = match[0].length;
  }
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

export interface QuoteSpec {
  itemId: string;
  quote: string;
  active: boolean;
}

/** The quote's range in any rendered part of its message (a message may be split in parts). */
function rangeIn(container: HTMLElement, spec: QuoteSpec): Range | null {
  for (const node of container.querySelectorAll(`[data-ctx-item="${spec.itemId}"]`)) {
    const range = findTextRange(node, spec.quote);
    if (range) return range;
  }
  return null;
}

/** The active quote's range in `container`, found fresh (DOM may have changed). */
export function activeRange(container: HTMLElement | null, specs: QuoteSpec[]): Range | null {
  const spec = specs.find((candidate) => candidate.active);
  if (!container || !spec) return null;
  return rangeIn(container, spec);
}

/** Paint every quote; the active one strongly, the others faintly. */
export function useQuoteHighlights(
  containerRef: RefObject<HTMLElement | null>,
  specs: QuoteSpec[],
  renderKey: string
) {
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof CSS === 'undefined' || !('highlights' in CSS)) return;
    const active: Range[] = [];
    const other: Range[] = [];
    for (const spec of specs) {
      const range = rangeIn(container, spec);
      if (range) (spec.active ? active : other).push(range);
    }
    CSS.highlights.set(ACTIVE, new Highlight(...active));
    CSS.highlights.set(OTHER, new Highlight(...other));
    return () => {
      CSS.highlights.delete(ACTIVE);
      CSS.highlights.delete(OTHER);
    };
  }, [containerRef, specs, renderKey]);
}

/**
 * The paragraph that holds the quote, and the paragraphs around it. Lets a direction show
 * just the commented paragraph, or put the thread right after it.
 */
export function splitAtQuote(
  text: string,
  quote: string
): { before: string; passage: string; after: string } {
  const paragraphs = text.split(/\n\n/);
  const index = paragraphs.findIndex((paragraph) =>
    paragraph.replace(/`|\*\*/g, '').includes(quote)
  );
  if (index === -1) return { before: '', passage: text, after: '' };
  return {
    before: paragraphs.slice(0, index).join('\n\n'),
    passage: paragraphs[index] ?? '',
    after: paragraphs.slice(index + 1).join('\n\n'),
  };
}

/** Highlight colors; rendered once by the prototype page. */
export const QUOTE_HIGHLIGHT_CSS = `
::highlight(${ACTIVE}) {
  background-color: color-mix(in srgb, var(--sam-color-warning) 40%, transparent);
  color: var(--sam-color-fg-primary);
}
::highlight(${OTHER}) {
  background-color: color-mix(in srgb, var(--sam-color-info) 22%, transparent);
}
`;

/** Scroll `scroller` so the range sits at `ratio` of its height (0 = top). */
export function scrollRangeIntoView(scroller: HTMLElement, range: Range, ratio = 0.32) {
  const rect = range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  scroller.scrollTop += rect.top - box.top - box.height * ratio;
}

/** Where the range is relative to the scroller's visible area. */
export function rangePlacement(scroller: HTMLElement, range: Range): 'above' | 'visible' | 'below' {
  const rect = range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (rect.bottom < box.top + 8) return 'above';
  if (rect.top > box.bottom - 8) return 'below';
  return 'visible';
}
