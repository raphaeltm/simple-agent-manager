import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `mermaid` used to be a static `import` at the top of MarkdownRenderer, so the whole
 * diagram engine (~2.7 MB parsed) shipped in the initial bundle for every user on the
 * chat path even though diagrams are rare.
 *
 * These tests assert the module is only *evaluated* when a ```mermaid fence is actually
 * rendered. The vi.mock factories below run lazily on first import, so incrementing a
 * counter inside them is a direct probe of "was this module pulled in yet?" — the same
 * question the bundler answers by putting it in a separate chunk.
 */

// `vi.hoisted` so the counter exists before the (hoisted) mock factories can run. Without
// it, reintroducing a static `import mermaid from 'mermaid'` in MarkdownRenderer makes the
// factory fire during module hoisting and the file dies with a confusing TDZ error instead
// of the clean assertion failure these tests are supposed to produce.
const moduleEvaluations = vi.hoisted(() => ({ mermaid: 0, dompurify: 0 }));

vi.mock('mermaid', () => {
  moduleEvaluations.mermaid += 1;
  return {
    default: {
      initialize: vi.fn(),
      render: vi.fn().mockResolvedValue({ svg: '<svg data-testid="rendered-svg"></svg>' }),
    },
  };
});

vi.mock('dompurify', () => {
  moduleEvaluations.dompurify += 1;
  return {
    default: { sanitize: (html: string) => html },
  };
});

import {
  RenderedMarkdown,
  resetMermaidLoaderForTests,
} from '../../src/components/MarkdownRenderer';

/**
 * Snapshot taken immediately after importing MarkdownRenderer and before any render or
 * `beforeEach` reset. This is the value that proves the *static* import graph is clean:
 * if `mermaid` ever goes back to being a top-level import, this is non-zero.
 */
const evaluationsAtImportTime = { ...moduleEvaluations };

beforeEach(() => {
  moduleEvaluations.mermaid = 0;
  moduleEvaluations.dompurify = 0;
  resetMermaidLoaderForTests();
});

afterEach(() => {
  cleanup();
});

describe('MarkdownRenderer mermaid loading', () => {
  it('importing MarkdownRenderer does not pull in mermaid or DOMPurify', () => {
    // The regression guard for the original bug: mermaid must not be in the module's
    // static import graph, because that is what put it in the initial bundle.
    expect(evaluationsAtImportTime.mermaid).toBe(0);
    expect(evaluationsAtImportTime.dompurify).toBe(0);
  });

  it('renders ordinary markdown with zero mermaid cost', async () => {
    render(<RenderedMarkdown content={'# Heading\n\nSome **bold** text and a `code` span.\n'} />);

    expect(await screen.findByText('Heading')).toBeInTheDocument();
    expect(moduleEvaluations.mermaid).toBe(0);
    expect(moduleEvaluations.dompurify).toBe(0);
  });

  it('renders a fenced non-mermaid code block with zero mermaid cost', async () => {
    render(<RenderedMarkdown content={'```ts\nconst x: number = 1;\n```\n'} />);

    await waitFor(() => expect(screen.getByText(/const/)).toBeInTheDocument());
    expect(moduleEvaluations.mermaid).toBe(0);
  });

  it('loads mermaid on the first diagram and renders it', async () => {
    render(<RenderedMarkdown content={'```mermaid\ngraph TD;\n  A-->B;\n```\n'} />);

    await waitFor(() => expect(moduleEvaluations.mermaid).toBe(1));
    expect(moduleEvaluations.dompurify).toBe(1);

    const container = await screen.findByTestId('mermaid-diagram');
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
  });

  it('initializes mermaid only once when several diagrams load concurrently', async () => {
    // Measured as a delta rather than an absolute count: vitest caches a mocked module
    // after its first import, so the module-evaluation counter above cannot distinguish
    // "loaded again" from "served from the registry" in a later test.
    const { default: mermaid } = await import('mermaid');
    const initializeCallsBefore = vi.mocked(mermaid.initialize).mock.calls.length;

    render(
      <RenderedMarkdown
        content={'```mermaid\ngraph TD;\n  A-->B;\n```\n\n```mermaid\ngraph LR;\n  C-->D;\n```\n'}
      />
    );

    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid="mermaid-diagram"] svg')).toHaveLength(2)
    );

    // Both diagrams share the one memoised load — no duplicate initialize().
    expect(vi.mocked(mermaid.initialize).mock.calls.length - initializeCallsBefore).toBe(1);
  });
});
