/**
 * Find a comment's quoted words inside rendered text, paint them, and place them on screen.
 * Shared by the comment reader, the project chat and the library's markdown viewer.
 *
 * Painting uses the CSS Custom Highlight API: it styles ranges without touching the DOM, so
 * it works on top of any markdown renderer and cannot disturb text selection or React's
 * reconciliation. Where the API is missing nothing is painted, and each surface still lands
 * on the commented message or file.
 */
import { type RefObject, useLayoutEffect, useRef, useState } from 'react';

/** Highlight names, styled in `index.css`. */
export const ACTIVE_QUOTE_HIGHLIGHT = 'sam-comment-quote';
export const OTHER_QUOTE_HIGHLIGHT = 'sam-comment-quote-other';

/**
 * When the whole quote cannot be matched (redacted on save, or the message changed), the
 * longest leading run of its words that still matches, from this many words…
 */
const QUOTE_LEAD_WORDS = 8;
/** …down to this many: fewer words find too many places to say where the passage starts. */
const QUOTE_MIN_LEAD_WORDS = 3;

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

/** An element's text, flattened once so several quotes can be found in it. */
export interface TextIndex {
  nodes: Text[];
  /** Offset of each node's first character in `text`. */
  starts: number[];
  text: string;
}

export function indexText(root: Node): TextIndex {
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
  return { nodes, starts, text };
}

/**
 * A Range over `quote` in indexed text. Whitespace may differ (a selection reads paragraph
 * breaks as newlines the DOM text does not have), so words are matched with any whitespace
 * between them. Falls back to the longest leading run of the quote's words that matches.
 */
export function findInIndex({ nodes, starts, text }: TextIndex, quote: string): Range | null {
  const needle = matchableQuote(quote);
  if (!needle) return null;
  const exact = text.indexOf(needle);
  if (exact !== -1) return rangeOver(nodes, starts, exact, needle.length);

  const words = needle.split(/\s+/).filter(Boolean);
  const leading = (count: number) =>
    new RegExp(words.slice(0, count).map(escapeRegExp).join('\\s*'), 'u').exec(text);
  let match = leading(words.length);
  for (
    let count = Math.min(words.length - 1, QUOTE_LEAD_WORDS);
    !match && count >= QUOTE_MIN_LEAD_WORDS;
    count -= 1
  ) {
    match = leading(count);
  }
  return match ? rangeOver(nodes, starts, match.index, match[0].length) : null;
}

/** A Range over `quote` in `root`'s text (`findInIndex`). */
export function findTextRange(root: Node, quote: string): Range | null {
  return findInIndex(indexText(root), quote);
}

export interface QuoteTarget {
  /** Rendered item the quote is in: the value of the surface's item attribute. */
  itemId: string;
  quote: string | null | undefined;
  /** Thread the quote belongs to; what a click on the painted words opens. */
  threadId?: string;
}

/** A quote found on screen, as last painted. */
export interface PaintedQuote {
  target: QuoteTarget;
  range: Range;
  /** Painted as the open comment (strong), not as one of the others (faint). */
  active: boolean;
}

/**
 * The attribute that names a rendered item, as its `dataset` key: the reader marks rows with
 * `data-reader-item`; the chat and the library viewer mark commentable text with
 * `data-comment-anchor`.
 */
export type QuoteItemKey = 'readerItem' | 'commentAnchor';

const ITEM_ATTRIBUTES: Record<QuoteItemKey, string> = {
  readerItem: 'data-reader-item',
  commentAnchor: 'data-comment-anchor',
};

/** Every element that renders an item inside `container`, by item id (first one wins). */
function itemElements(container: HTMLElement, itemKey: QuoteItemKey): Map<string, HTMLElement> {
  const elements = new Map<string, HTMLElement>();
  for (const element of container.querySelectorAll<HTMLElement>(`[${ITEM_ATTRIBUTES[itemKey]}]`)) {
    const id = element.dataset[itemKey];
    if (id && !elements.has(id)) elements.set(id, element);
  }
  return elements;
}

/** The element that renders `itemId` inside `container`. */
export function itemElement(
  container: HTMLElement | null,
  itemId: string,
  itemKey: QuoteItemKey = 'readerItem'
): HTMLElement | null {
  // Compared as data rather than interpolated into a selector, so no id needs escaping.
  return container ? (itemElements(container, itemKey).get(itemId) ?? null) : null;
}

export function quoteRange(
  container: HTMLElement | null,
  target: QuoteTarget,
  itemKey: QuoteItemKey = 'readerItem'
): Range | null {
  const element = itemElement(container, target.itemId, itemKey);
  return element && target.quote ? findTextRange(element, target.quote) : null;
}

export function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';
}

/*
 * `CSS.highlights` is one registry for the whole document, keyed by name, and more than one
 * surface can paint at once (a library file previewed over a chat). Each surface registers its
 * own ranges here and the two named highlights always hold the union, so one surface
 * repainting or unmounting never erases another's.
 */
const surfaces = new Map<symbol, { active: Range[]; other: Range[] }>();

function publish(name: string, ranges: Range[]): void {
  if (ranges.length > 0) CSS.highlights.set(name, new Highlight(...ranges));
  else CSS.highlights.delete(name);
}

function syncRegistry(): void {
  if (!highlightsSupported()) return;
  const all = [...surfaces.values()];
  publish(
    ACTIVE_QUOTE_HIGHLIGHT,
    all.flatMap((surface) => surface.active)
  );
  publish(
    OTHER_QUOTE_HIGHLIGHT,
    all.flatMap((surface) => surface.other)
  );
}

/** Replace one surface's painted ranges. Exported for tests. */
export function setSurfaceHighlights(surface: symbol, active: Range[], other: Range[]): void {
  surfaces.set(surface, { active, other });
  syncRegistry();
}

/** Remove one surface's painted ranges. Exported for tests. */
export function clearSurfaceHighlights(surface: symbol): void {
  if (surfaces.delete(surface)) syncRegistry();
}

/**
 * How long, from when the open comment's words are first found after a new focus, they are
 * kept on screen while the surface settles (a jump into history, rows mounting above, a long
 * message or document laying out).
 */
const QUOTE_REVEAL_WINDOW_MS = 2500;
/**
 * How long a new focus waits for its words to be found (history loading, the row mounting)
 * before it stops trying to bring them on screen.
 */
const QUOTE_REVEAL_FIND_MS = 10_000;
/** Where revealed words land: this far down the visible height (0 = top). */
const QUOTE_REVEAL_RATIO = 0.3;

/** The nearest ancestor of `element` that scrolls vertically. */
function scrollParent(element: Element | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

/**
 * The element `ref` points at, as state. A surface's container can attach after the hook's
 * first commit (a chat shows a loading pane until its session arrives) without any of the
 * effect's inputs changing, so effects keyed on the ref object alone would never see it.
 * Compares on every commit; re-renders only when the element changes.
 */
export function useAttachedElement<T extends HTMLElement>(ref: RefObject<T | null>): T | null {
  const [element, setElement] = useState<T | null>(null);
  useLayoutEffect(() => {
    if (ref.current !== element) setElement(ref.current);
  });
  return element;
}

export interface QuoteHighlightOptions {
  /** Which attribute marks the items quotes are found in. Default: the reader's rows. */
  itemKey?: QuoteItemKey;
  /**
   * Find the ranges again whenever the container's DOM changes, at most once a frame. For a
   * virtualized list (rows mount and unmount on scroll) or streaming text, where `renderKey`
   * cannot say when the words were redrawn. Nothing is observed while there is nothing to
   * paint, so a chat without quoted comments pays nothing while an agent streams.
   */
  observeMutations?: boolean;
  /**
   * Changes when someone is sent to the open comment (a deep link, a thread's View). From when
   * its words are first found, for a short window, they are scrolled back on screen whenever a
   * repaint finds them off it. The user scrolling or typing ends it. Null reveals nothing.
   */
  revealKey?: string | null;
}

/**
 * What says the person has taken the scroll position over. Shared by the reveal window here
 * and the comment reader's own landing, so both surfaces stop following at the same signals.
 */
export const USER_SCROLL_EVENTS = ['wheel', 'touchmove', 'keydown'] as const;

type RevealWindow =
  { phase: 'finding'; until: number } | { phase: 'showing'; until: number } | null;

/**
 * Paint the open comment's quote strongly and the other comments' quotes faintly.
 * `renderKey` changes whenever the rendered rows change, so ranges are found again.
 * Returns what was last painted, for hit-testing (`useQuoteHighlightClicks`).
 */
export function useQuoteHighlights(
  containerRef: RefObject<HTMLElement | null>,
  active: QuoteTarget | null,
  others: readonly QuoteTarget[],
  renderKey: string,
  options: QuoteHighlightOptions = {}
): RefObject<readonly PaintedQuote[]> {
  const { itemKey = 'readerItem', observeMutations = false, revealKey = null } = options;
  const paintedRef = useRef<readonly PaintedQuote[]>([]);
  const [surface] = useState(() => Symbol('quote-highlights'));
  const reveal = useRef<RevealWindow>(null);
  const container = useAttachedElement(containerRef);

  useLayoutEffect(() => {
    reveal.current = revealKey
      ? { phase: 'finding', until: performance.now() + QUOTE_REVEAL_FIND_MS }
      : null;
    if (!revealKey || !container) return;
    const stop = () => {
      reveal.current = null;
    };
    for (const name of USER_SCROLL_EVENTS) {
      container.addEventListener(name, stop, { passive: true });
    }
    return () => {
      for (const name of USER_SCROLL_EVENTS) container.removeEventListener(name, stop);
    };
  }, [container, revealKey]);

  useLayoutEffect(() => {
    if (!container || !highlightsSupported()) return;
    if (!active && others.length === 0) {
      paintedRef.current = [];
      clearSurfaceHighlights(surface);
      return;
    }

    const bringOnScreen = (range: Range) => {
      const current = reveal.current;
      if (!current) return;
      const now = performance.now();
      if (now > current.until) {
        reveal.current = null;
        return;
      }
      if (current.phase === 'finding') {
        reveal.current = { phase: 'showing', until: now + QUOTE_REVEAL_WINDOW_MS };
      }
      const scroller = scrollParent(range.startContainer.parentElement);
      if (!scroller) return;
      const box = targetBox(range);
      if (boxPlacement(scroller, box) !== 'visible') {
        scrollBoxIntoView(scroller, box, QUOTE_REVEAL_RATIO);
      }
    };

    const paint = () => {
      const elements = itemElements(container, itemKey);
      // Each element's text is flattened once per paint, however many quotes are in it.
      const indexes = new Map<HTMLElement, TextIndex>();
      const find = (target: QuoteTarget) => {
        const element = elements.get(target.itemId);
        if (!element || !target.quote) return null;
        let index = indexes.get(element);
        if (!index) {
          index = indexText(element);
          indexes.set(element, index);
        }
        return findInIndex(index, target.quote);
      };
      const painted: PaintedQuote[] = [];
      const activeRange = active ? find(active) : null;
      if (active && activeRange) painted.push({ target: active, range: activeRange, active: true });
      for (const target of others) {
        const range = find(target);
        if (range) painted.push({ target, range, active: false });
      }
      paintedRef.current = painted;
      setSurfaceHighlights(
        surface,
        activeRange ? [activeRange] : [],
        painted.filter((quote) => !quote.active).map((quote) => quote.range)
      );
      if (activeRange) bringOnScreen(activeRange);
    };

    paint();
    let frame = 0;
    const schedulePaint = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        paint();
      });
    };
    const observer =
      observeMutations && typeof MutationObserver === 'function'
        ? new MutationObserver(schedulePaint)
        : null;
    // Painting never touches the DOM, so this cannot feed itself.
    observer?.observe(container, { childList: true, subtree: true, characterData: true });
    // An image loading moves the text below it without any DOM mutation. `load` does not
    // bubble, so it is caught on the way down.
    if (observer) container.addEventListener('load', schedulePaint, true);
    return () => {
      observer?.disconnect();
      if (observer) container.removeEventListener('load', schedulePaint, true);
      if (frame) cancelAnimationFrame(frame);
      clearSurfaceHighlights(surface);
      paintedRef.current = [];
    };
  }, [container, active, others, renderKey, itemKey, observeMutations, revealKey, surface]);

  return paintedRef;
}

/**
 * Where `target` is on screen. A range without layout support (some test DOMs) measures by
 * the element that holds its first word.
 */
export function targetBox(target: Range | HTMLElement): DOMRect {
  if (typeof target.getBoundingClientRect === 'function') return target.getBoundingClientRect();
  const holder = 'startContainer' in target ? target.startContainer.parentElement : null;
  return holder?.getBoundingClientRect() ?? new DOMRect();
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

/** How much of the words must show, about one line, for them to count as on screen. */
const MIN_VISIBLE_PX = 24;

/** Where `box` is relative to the scroller's visible area, less `bottomInset` px it hides. */
export function boxPlacement(
  scroller: HTMLElement,
  box: DOMRect,
  bottomInset = 0
): 'above' | 'visible' | 'below' {
  const view = scroller.getBoundingClientRect();
  if (box.bottom < view.top + MIN_VISIBLE_PX) return 'above';
  if (box.top > view.bottom - bottomInset - MIN_VISIBLE_PX) return 'below';
  return 'visible';
}
