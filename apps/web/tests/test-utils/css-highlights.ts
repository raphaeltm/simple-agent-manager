/**
 * jsdom implements neither the CSS Custom Highlight API nor layout. These stubs give tests a
 * real registry to read painted ranges back from, and let a test say which painted words the
 * pointer is over (`pointerOver`), since a range in jsdom has no client rects of its own.
 */
import { vi } from 'vitest';

import {
  ACTIVE_QUOTE_HIGHLIGHT,
  OTHER_QUOTE_HIGHLIGHT,
} from '../../src/components/project-message-view/comments/quote-highlight';

class FakeHighlight extends Set<Range> {
  constructor(...ranges: Range[]) {
    super(ranges);
  }
}

export interface HighlightStubs {
  registry: Map<string, FakeHighlight>;
  /** Text of the ranges painted under the open comment's name. */
  activeQuotes: () => string[];
  /** Text of the ranges painted under the other comments' name. */
  otherQuotes: () => string[];
  /** Put the pointer over painted words with exactly this text (or over nothing). */
  pointerOver: (...texts: string[]) => void;
  restore: () => void;
}

const POINT_BOX = { left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000 };
/** Where a test's click lands: inside `POINT_BOX`. */
export const POINTER = { clientX: 10, clientY: 10 };

export function stubCssHighlights(): HighlightStubs {
  const registry = new Map<string, FakeHighlight>();
  let over = new Set<string>();
  vi.stubGlobal('Highlight', FakeHighlight);
  vi.stubGlobal('CSS', { ...(globalThis.CSS ?? {}), highlights: registry });
  const original = Range.prototype.getClientRects;
  Range.prototype.getClientRects = function getClientRects(this: Range) {
    return (over.has(this.toString()) ? [POINT_BOX] : []) as unknown as DOMRectList;
  };
  const texts = (name: string) => [...(registry.get(name) ?? [])].map((range) => range.toString());
  return {
    registry,
    activeQuotes: () => texts(ACTIVE_QUOTE_HIGHLIGHT),
    otherQuotes: () => texts(OTHER_QUOTE_HIGHLIGHT),
    pointerOver: (...hit) => {
      over = new Set(hit);
    },
    restore: () => {
      Range.prototype.getClientRects = original;
      vi.unstubAllGlobals();
    },
  };
}
