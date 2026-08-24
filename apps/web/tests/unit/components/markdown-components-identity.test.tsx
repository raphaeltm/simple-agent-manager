/**
 * What actually reaches react-markdown must be identical across renders.
 *
 * The DOM-stability tests cannot see this: they drive their re-render through
 * `memo`'s bail-out, so they pass even when the components object is rebuilt.
 * That blind spot let a `components={{ ...MARKDOWN_COMPONENTS }}` spread ship —
 * harmless in itself (react-markdown resolves per tag, and a shallow spread
 * copies each override by reference) but it removed the margin the hoist exists
 * to provide, and it contradicted the rule it was committed alongside.
 *
 * This test captures the prop react-markdown is handed on each render and
 * asserts both the container and the individual overrides are the same objects.
 * It fails on an inline literal AND on a spread. See .claude/rules/64.
 */
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ components: [] as unknown[] }));

vi.mock('react-markdown', () => ({
  default: ({ components, children }: { components: unknown; children: string }) => {
    captured.components.push(components);
    return <div data-testid="markdown-stub">{children}</div>;
  },
}));
vi.mock('remark-gfm', () => ({ default: () => undefined }));

import { RenderedMarkdownImpl } from '../../../src/components/MarkdownRenderer';

describe('markdown components prop identity', () => {
  beforeEach(() => {
    captured.components = [];
  });

  it('passes the very same components object on every render', () => {
    const { rerender } = render(<RenderedMarkdownImpl content={'one'} />);
    rerender(<RenderedMarkdownImpl content={'two'} />);
    rerender(<RenderedMarkdownImpl content={'three'} />);

    expect(captured.components.length).toBeGreaterThanOrEqual(3);
    const [first, ...rest] = captured.components;
    for (const next of rest) {
      // Container identity. A spread or an inline literal breaks this.
      expect(next).toBe(first);
    }
  });

  it('keeps each individual override identical across renders', () => {
    const { rerender } = render(<RenderedMarkdownImpl content={'one'} />);
    rerender(<RenderedMarkdownImpl content={'two'} />);

    const [a, b] = captured.components as Record<string, unknown>[];
    // Per-tag identity is what react-markdown actually resolves on, and what
    // determines whether React reconciles or remounts each node.
    for (const tag of ['h1', 'h2', 'h3', 'p', 'ul', 'ol', 'li', 'blockquote', 'a', 'code']) {
      expect(b[tag], `override for <${tag}> changed identity between renders`).toBe(a[tag]);
    }
  });
});
