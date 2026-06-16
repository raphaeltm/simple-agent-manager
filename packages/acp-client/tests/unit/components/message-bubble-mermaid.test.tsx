import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MERMAID_SVG_SANITIZE_CONFIG } from '../../../src/components/MermaidDiagram';
import { MessageBubble } from '../../../src/components/MessageBubble';

const initializeConfigs: unknown[] = [];

const mocks = vi.hoisted(() => ({
  mermaidRender: vi.fn(),
  mermaidInitialize: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: (...args: unknown[]) => {
      initializeConfigs.push(args[0]);
      return mocks.mermaidInitialize(...args);
    },
    render: mocks.mermaidRender,
  },
}));

describe('MessageBubble Mermaid rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializeConfigs.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders finalized mermaid code blocks as sanitized diagrams', async () => {
    mocks.mermaidRender.mockResolvedValue({
      svg: '<svg viewBox="0 0 100 80"><text>Mock Diagram</text><script>alert("xss")</script></svg>',
    });

    render(
      <MessageBubble
        role="agent"
        text={[
          'Architecture:',
          '',
          '```mermaid',
          'graph TD',
          '  A-->B',
          '```',
        ].join('\n')}
      />,
    );

    await waitFor(() => {
      const diagramSvg = screen.getByTestId('mermaid-diagram-svg');
      expect(diagramSvg.innerHTML).toContain('Mock Diagram');
    });

    expect(mocks.mermaidRender).toHaveBeenCalledWith(
      expect.stringContaining('acp-mermaid-'),
      'graph TD\n  A-->B',
    );
    expect(screen.getByTestId('mermaid-diagram-svg').innerHTML).not.toContain('<script>');
    expect(initializeConfigs).toEqual([
      expect.objectContaining({ securityLevel: 'strict', startOnLoad: false }),
    ]);
  });

  it('does not wrap mermaid diagrams in a pre element', async () => {
    mocks.mermaidRender.mockResolvedValue({
      svg: '<svg viewBox="0 0 100 80"><text>Diagram</text></svg>',
    });

    render(<MessageBubble role="agent" text={'```mermaid\ngraph TD\n  A-->B\n```'} />);

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-diagram-svg').innerHTML).toContain('Diagram');
    });

    expect(screen.getByTestId('mermaid-diagram').closest('pre')).toBeNull();
  });

  it('defers mermaid rendering while a message is streaming', () => {
    render(
      <MessageBubble
        role="agent"
        streaming
        text={'```mermaid\ngraph TD\n  A -->\n```'}
      />,
    );

    expect(screen.getByTestId('mermaid-code-fallback').textContent).toContain('graph TD');
    expect(screen.getByTestId('mermaid-code-fallback').style.background).toBe('rgb(1, 22, 39)');
    expect(screen.getByTestId('mermaid-code-fallback').style.color).toBe('rgb(214, 222, 235)');
    expect(screen.queryByTestId('mermaid-diagram')).toBeNull();
    expect(mocks.mermaidRender).not.toHaveBeenCalled();
  });

  it('shows a graceful error state with source access for invalid mermaid', async () => {
    mocks.mermaidRender.mockRejectedValue(new Error('Parse error on line 2'));

    render(<MessageBubble role="agent" text={'```mermaid\nnot a diagram\n```'} />);

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-diagram-error').textContent).toContain('Mermaid diagram error');
    });

    const error = screen.getByTestId('mermaid-diagram-error');
    expect(error.textContent).toContain('Parse error on line 2');
    expect(error.textContent).toContain('not a diagram');
  });

  it('preserves non-mermaid code highlighting and language-less code blocks', () => {
    render(
      <MessageBubble
        role="agent"
        text={[
          '```ts',
          'const value = 1;',
          '```',
          '',
          '```',
          'line one',
          'line two',
          '```',
        ].join('\n')}
      />,
    );

    expect(screen.queryByTestId('mermaid-diagram')).toBeNull();
    expect(document.querySelectorAll('pre').length).toBe(2);
    expect(document.body.textContent).toContain('const');
    expect(document.body.textContent).toContain('line one\nline two');
  });

  it('keeps inline code inline without invoking mermaid rendering', () => {
    render(<MessageBubble role="agent" text="Use `graph TD` in a fenced block." />);

    expect(screen.getByText('graph TD').tagName).toBe('CODE');
    expect(screen.queryByTestId('mermaid-diagram')).toBeNull();
    expect(mocks.mermaidRender).not.toHaveBeenCalled();
  });

  it('sanitizes foreignObject label content without preserving dangerous HTML', async () => {
    mocks.mermaidRender.mockResolvedValue({
      svg: [
        '<svg viewBox="0 0 100 80">',
        '<foreignObject width="100" height="40">',
        '<div xmlns="http://www.w3.org/1999/xhtml">',
        '<img src="x" onerror="alert(1)"/>',
        '<script>alert(2)</script>',
        '<span class="nodeLabel">Safe Label</span>',
        '</div>',
        '</foreignObject>',
        '</svg>',
      ].join(''),
    });

    render(<MessageBubble role="agent" text={'```mermaid\ngraph TD\n  A-->B\n```'} />);

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-diagram-svg').innerHTML).toContain('Safe Label');
    });

    const html = screen.getByTestId('mermaid-diagram-svg').innerHTML;
    expect(html).toContain('foreignObject');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert');
  });

  it('uses explicit sanitizer allowlists for Mermaid SVG output', () => {
    expect(MERMAID_SVG_SANITIZE_CONFIG.ALLOWED_TAGS.length).toBeGreaterThan(10);
    expect(MERMAID_SVG_SANITIZE_CONFIG.ALLOWED_ATTR.length).toBeGreaterThan(10);
    expect(MERMAID_SVG_SANITIZE_CONFIG.ADD_TAGS.map((tag) => tag.toLowerCase())).toEqual(
      expect.arrayContaining(['foreignobject', 'div', 'span', 'p', 'br']),
    );
    expect(MERMAID_SVG_SANITIZE_CONFIG.ALLOWED_TAGS).not.toContain('script');
    expect(MERMAID_SVG_SANITIZE_CONFIG.ALLOWED_ATTR).not.toContain('onclick');
  });
});
