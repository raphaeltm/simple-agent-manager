/**
 * Finding a comment's quoted words in the rendered message. The quote came from a browser
 * selection of the same rendering, so its whitespace can differ from the DOM text (paragraph
 * breaks read as newlines), and it may have been cut short with "…" when captured.
 */
import { describe, expect, it } from 'vitest';

import { findTextRange, matchableQuote } from '../../../src/pages/comment-reader/quote-highlight';

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
