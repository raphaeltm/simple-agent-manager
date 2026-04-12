import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach,describe, expect, it, vi } from 'vitest';

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

import { RenderedMarkdown, SVG_SANITIZE_CONFIG } from '../../../src/components/MarkdownRenderer';

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

  it('renders syntax-highlighted code blocks', () => {
    const content = '```typescript\nconst x = 1;\n```';
    render(<RenderedMarkdown content={content} />);
    expect(screen.getByText('const')).toBeInTheDocument();
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
      'graph TD\n  A-->B',
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
    const MERMAID_BLOCK = '```mermaid\ngraph TD\n  A-->B\n```';

    it('strips <script> tags from SVG output', async () => {
      const maliciousSvg = '<svg><text>Diagram</text><script>alert("xss")</script></svg>';
      mocks.mermaidRender.mockResolvedValue({ svg: maliciousSvg });

      render(<RenderedMarkdown content={MERMAID_BLOCK} />);

      await waitFor(() => {
        const diagram = screen.getByTestId('mermaid-diagram');
        expect(diagram.innerHTML).not.toBe('');
        expect(diagram.innerHTML).toContain('Diagram');
        expect(diagram.innerHTML).not.toContain('<script>');
        expect(diagram.innerHTML).not.toContain('alert');
      });
    });

    it('strips event handler attributes from SVG output', async () => {
      const maliciousSvg = '<svg><rect onclick="alert(1)" onerror="alert(2)" width="100" height="100"/><text>Safe</text></svg>';
      mocks.mermaidRender.mockResolvedValue({ svg: maliciousSvg });

      render(<RenderedMarkdown content={MERMAID_BLOCK} />);

      await waitFor(() => {
        const diagram = screen.getByTestId('mermaid-diagram');
        expect(diagram.innerHTML).not.toBe('');
        expect(diagram.innerHTML).toContain('Safe');
        expect(diagram.innerHTML).not.toContain('onclick');
        expect(diagram.innerHTML).not.toContain('onerror');
        expect(diagram.innerHTML).not.toContain('alert');
      });
    });

    it('strips javascript: URIs from SVG output', async () => {
      const maliciousSvg = '<svg><a href="javascript:alert(1)"><text>Click me</text></a></svg>';
      mocks.mermaidRender.mockResolvedValue({ svg: maliciousSvg });

      render(<RenderedMarkdown content={MERMAID_BLOCK} />);

      await waitFor(() => {
        const diagram = screen.getByTestId('mermaid-diagram');
        expect(diagram.innerHTML).not.toBe('');
        expect(diagram.innerHTML).toContain('Click me');
        expect(diagram.innerHTML).not.toContain('javascript:');
      });
    });

    it('strips <use> elements with external references', async () => {
      const maliciousSvg = '<svg><use href="http://evil.com/evil.svg#xss"/><text>Safe</text></svg>';
      mocks.mermaidRender.mockResolvedValue({ svg: maliciousSvg });

      render(<RenderedMarkdown content={MERMAID_BLOCK} />);

      await waitFor(() => {
        const diagram = screen.getByTestId('mermaid-diagram');
        expect(diagram.innerHTML).not.toBe('');
        expect(diagram.innerHTML).toContain('Safe');
        expect(diagram.innerHTML).not.toContain('evil.com');
      });
    });

    it('strips foreignObject elements (DOMPurify blocks by default)', async () => {
      const maliciousSvg = '<svg><foreignObject><div><img src="x" onerror="alert(1)"/></div></foreignObject><text>Safe</text></svg>';
      mocks.mermaidRender.mockResolvedValue({ svg: maliciousSvg });

      render(<RenderedMarkdown content={MERMAID_BLOCK} />);

      await waitFor(() => {
        const diagram = screen.getByTestId('mermaid-diagram');
        expect(diagram.innerHTML).not.toBe('');
        expect(diagram.innerHTML).toContain('Safe');
        expect(diagram.innerHTML).not.toContain('foreignObject');
        expect(diagram.innerHTML).not.toContain('onerror');
      });
    });

    it('preserves valid SVG content through sanitization', async () => {
      const validSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="#1a3a32" stroke="#29423b"/><text x="50" y="55" text-anchor="middle" fill="#e6f2ee">Node A</text></svg>';
      mocks.mermaidRender.mockResolvedValue({ svg: validSvg });

      render(<RenderedMarkdown content={MERMAID_BLOCK} />);

      await waitFor(() => {
        const diagram = screen.getByTestId('mermaid-diagram');
        expect(diagram.innerHTML).not.toBe('');
        expect(diagram.innerHTML).toContain('Node A');
        expect(diagram.innerHTML).toContain('<rect');
        expect(diagram.innerHTML).toContain('<text');
        expect(diagram.innerHTML).toContain('fill="#1a3a32"');
      });
    });

    it('uses explicit ALLOWED_TAGS and ALLOWED_ATTR in SVG sanitize config', () => {
      // Verify the config has explicit allowlists (defense-in-depth)
      expect(SVG_SANITIZE_CONFIG.ALLOWED_TAGS).toBeDefined();
      expect(SVG_SANITIZE_CONFIG.ALLOWED_TAGS!.length).toBeGreaterThan(10);
      expect(SVG_SANITIZE_CONFIG.ALLOWED_ATTR).toBeDefined();
      expect(SVG_SANITIZE_CONFIG.ALLOWED_ATTR!.length).toBeGreaterThan(10);

      // script, iframe, object, embed must NOT be in the allowlist
      const blockedTags = ['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea'];
      for (const tag of blockedTags) {
        expect(SVG_SANITIZE_CONFIG.ALLOWED_TAGS).not.toContain(tag);
      }

      // Event handler attributes must NOT be in the allowlist
      const blockedAttrs = ['onclick', 'onerror', 'onload', 'onmouseover', 'onfocus'];
      for (const attr of blockedAttrs) {
        expect(SVG_SANITIZE_CONFIG.ALLOWED_ATTR).not.toContain(attr);
      }

      // Core Mermaid-required tags must be present
      const requiredTags = ['svg', 'g', 'path', 'rect', 'text', 'tspan', 'defs', 'style', 'marker'];
      for (const tag of requiredTags) {
        expect(SVG_SANITIZE_CONFIG.ALLOWED_TAGS).toContain(tag);
      }
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
        expect(diagram.innerHTML).toContain('text-anchor');
        expect(diagram.innerHTML).toContain('transform=');
        expect(diagram.innerHTML).toContain('Node');
      });
    });

    it('calls mermaid.initialize with securityLevel strict', () => {
      // The singleton ensureMermaidInit() fires once per module load during
      // the first mermaid render in this suite. We capture config args outside
      // the mock lifecycle (survives clearAllMocks) to assert on them here.
      const hasStrictCall = initializeConfigs.some(
        (config) =>
          config &&
          typeof config === 'object' &&
          (config as Record<string, unknown>).securityLevel === 'strict',
      );
      expect(hasStrictCall).toBe(true);
    });
  });
});
