/**
 * The rendered markdown DOM must survive an unrelated parent re-render.
 *
 * This is not a cosmetic concern. A native text Selection lives on real DOM
 * nodes: if React replaces the nodes under the user's finger, the browser drops
 * the selection AND its drag handles. On Android that made quoting text
 * impossible — a long-press selected one word, the re-render that followed
 * (from the selection popover appearing) rebuilt the paragraph, and the
 * selection was gone before the user could extend it.
 *
 * The cause was `components={{ ... }}` written inline in the render body:
 * react-markdown does `createElement(components[tag], ...)`, so a fresh object
 * literal gives every override a new function identity, React sees a different
 * component *type* for each node, and unmounts/remounts the whole document
 * instead of reconciling it.
 *
 * These tests fail on the pre-fix code — verified, not assumed.
 */
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { RenderedMarkdown, RenderedMarkdownImpl } from '../../../src/components/MarkdownRenderer';

const CONTENT = [
  '# A heading',
  '',
  'A paragraph long enough that a user might plausibly want to select part of it.',
  '',
  '- a list item',
  '- another list item',
].join('\n');

/** Renders markdown next to a counter that can be bumped without touching the content. */
function Harness({ content = CONTENT }: { content?: string }) {
  const [n, setN] = useState(0);
  return (
    <div>
      <button type="button" data-testid="bump" onClick={() => setN((v) => v + 1)}>
        {n}
      </button>
      <RenderedMarkdown content={content} />
    </div>
  );
}

describe('RenderedMarkdown DOM stability', () => {
  it('reuses the same element nodes across an unrelated parent re-render', () => {
    const { container, getByTestId } = render(<Harness />);

    const before = {
      p: container.querySelector('p'),
      h1: container.querySelector('h1'),
      li: container.querySelector('li'),
    };
    expect(before.p).not.toBeNull();

    act(() => getByTestId('bump').click());
    expect(getByTestId('bump').textContent).toBe('1');

    // Identity, not equality: a remount produces nodes that serialize
    // identically but are different objects — and a Selection anchored to the
    // old ones dies with them.
    expect(container.querySelector('p')).toBe(before.p);
    expect(container.querySelector('h1')).toBe(before.h1);
    expect(container.querySelector('li')).toBe(before.li);
  });

  it('preserves a live text Selection across an unrelated parent re-render', () => {
    // The behaviour the DOM-identity assertion above exists to protect. jsdom
    // implements enough of the Selection API to catch a full remount.
    const { container, getByTestId } = render(<Harness />);
    const paragraph = container.querySelector('p');
    expect(paragraph).not.toBeNull();

    const range = document.createRange();
    range.selectNodeContents(paragraph as Node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const selectedBefore = window.getSelection()?.toString();
    expect(selectedBefore?.length ?? 0).toBeGreaterThan(10);

    act(() => getByTestId('bump').click());

    expect(window.getSelection()?.toString()).toBe(selectedBefore);
    expect(window.getSelection()?.isCollapsed).toBe(false);
  });

  it('survives a real re-render of the renderer itself, without memo', () => {
    // The tests above drive the re-render through memo's bail-out, so they pass
    // even if the components object is rebuilt — memo alone would satisfy them.
    // This one renders the UNMEMOIZED implementation, forcing it to actually
    // re-execute, which is the only way to prove the module-scope hoist (not
    // memo) is what keeps the DOM stable.
    function UnmemoizedHarness() {
      const [n, setN] = useState(0);
      return (
        <div>
          <button type="button" data-testid="bump" onClick={() => setN((v) => v + 1)}>
            {n}
          </button>
          <RenderedMarkdownImpl content={CONTENT} />
        </div>
      );
    }

    const { container, getByTestId } = render(<UnmemoizedHarness />);
    const before = container.querySelector('p');
    expect(before).not.toBeNull();

    act(() => getByTestId('bump').click());
    expect(getByTestId('bump').textContent).toBe('1');

    expect(container.querySelector('p')).toBe(before);
  });

  it('still re-renders when the content itself changes', () => {
    // The memo must not make the component stale — this is the control that
    // proves the fix did not trade one bug for another.
    const { container, rerender } = render(<RenderedMarkdown content={'First body text.'} />);
    expect(container.textContent).toContain('First body text.');

    rerender(<RenderedMarkdown content={'Second body text.'} />);
    expect(container.textContent).toContain('Second body text.');
    expect(container.textContent).not.toContain('First body text.');
  });
});
