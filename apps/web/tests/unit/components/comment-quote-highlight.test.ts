/**
 * Finding a comment's quoted words in the rendered message. The quote came from a browser
 * selection of the same rendering, so its whitespace can differ from the DOM text (paragraph
 * breaks read as newlines), and it may have been cut short with "…" when captured.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSurfaceHighlights,
  findTextRange,
  matchableQuote,
  type PaintedQuote,
  setSurfaceHighlights,
} from '../../../src/components/project-message-view/comments/quote-highlight';
import {
  quotesAtPoint,
  threadToOpen,
} from '../../../src/components/project-message-view/comments/quote-highlight-clicks';
import { type HighlightStubs, stubCssHighlights } from '../../test-utils/css-highlights';

function rendered(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

describe('findTextRange', () => {
  it('covers the exact words, across the elements that render them', () => {
    const root = rendered(
      '<p>The handler returns <strong>500</strong> when the ledger write fails.</p>'
    );

    expect(findTextRange(root, 'returns 500 when')?.toString()).toBe('returns 500 when');
  });

  it('matches a quote that spans paragraphs, whose breaks the DOM text does not have', () => {
    const root = rendered('<p>First, retry.</p><p>Then, alert someone.</p>');

    expect(findTextRange(root, 'retry.\n\nThen, alert')?.toString()).toBe('retry.Then, alert');
  });

  it('matches a quote cut short with an ellipsis on capture', () => {
    const root = rendered('<p>The idempotency check runs after the write, which is the bug.</p>');

    expect(matchableQuote('The idempotency check runs after…')).toBe(
      'The idempotency check runs after'
    );
    expect(findTextRange(root, 'The idempotency check runs after…')?.toString()).toBe(
      'The idempotency check runs after'
    );
  });

  it('falls back to where the quote starts when its later words no longer match', () => {
    const root = rendered('<p>Set the token to sk-live-123 and restart the worker now.</p>');

    // Saved with the secret redacted, so the whole quote is not in the message.
    const range = findTextRange(
      root,
      'Set the token to [redacted] and restart the worker now please'
    );
    expect(range?.toString()).toBe('Set the token to');
  });

  it('finds nothing when the words are not in the message', () => {
    const root = rendered('<p>Completely different text.</p>');

    expect(findTextRange(root, 'ledger write')).toBeNull();
    expect(findTextRange(root, '   ')).toBeNull();
  });
});

describe('highlight registry', () => {
  let stubs: HighlightStubs | null = null;
  afterEach(() => {
    stubs?.restore();
    stubs = null;
  });

  it('keeps every surface\'s ranges when one repaints or unmounts', () => {
    stubs = stubCssHighlights();
    const root = rendered('<p>alpha beta gamma delta</p>');
    const chat = Symbol('chat');
    const library = Symbol('library');
    const alpha = findTextRange(root, 'alpha') as Range;
    const gamma = findTextRange(root, 'gamma') as Range;
    const delta = findTextRange(root, 'delta') as Range;

    setSurfaceHighlights(chat, [alpha], [gamma]);
    setSurfaceHighlights(library, [], [delta]);
    expect(stubs.activeQuotes()).toEqual(['alpha']);
    expect(stubs.otherQuotes()).toEqual(['gamma', 'delta']);

    // A library preview over the chat closes: the chat's words stay painted.
    clearSurfaceHighlights(library);
    expect(stubs.activeQuotes()).toEqual(['alpha']);
    expect(stubs.otherQuotes()).toEqual(['gamma']);

    clearSurfaceHighlights(chat);
    expect(stubs.registry.size).toBe(0);
  });
});

describe('opening a clicked quote', () => {
  const threads = [
    { id: 'old-open', status: 'open', createdAt: 1 },
    { id: 'new-open', status: 'sent', createdAt: 2 },
    { id: 'newest-resolved', status: 'resolved', createdAt: 3 },
    { id: 'elsewhere', status: 'open', createdAt: 4 },
  ];

  it('opens the newest open thread under the pointer', () => {
    expect(threadToOpen(['old-open', 'new-open', 'newest-resolved'], threads)?.id).toBe('new-open');
  });

  it('falls back to the newest thread when none under the pointer is open', () => {
    expect(threadToOpen(['newest-resolved'], threads)?.id).toBe('newest-resolved');
    expect(threadToOpen([], threads)).toBeNull();
  });

  it('reads only the quotes whose rects contain the point, the open comment first', () => {
    const box = (top: number) =>
      ({ getClientRects: () => [{ left: 0, right: 100, top, bottom: top + 10 }] }) as unknown as Range;
    const painted: PaintedQuote[] = [
      { target: { itemId: 'm', quote: 'a', threadId: 'other' }, range: box(0), active: false },
      { target: { itemId: 'm', quote: 'b', threadId: 'below' }, range: box(50), active: false },
      { target: { itemId: 'm', quote: 'c', threadId: 'active' }, range: box(0), active: true },
    ];
    expect(quotesAtPoint(painted, 5, 5).map((t) => t.threadId)).toEqual(['active', 'other']);
    expect(quotesAtPoint(painted, 5, 30)).toEqual([]);
  });
});
