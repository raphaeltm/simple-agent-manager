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

    it('preserves foreignObject with safe Mermaid label content', async () => {
      const mermaidFlowchartSvg = '<svg><foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel">Node A</span></div></foreignObject></svg>';
      mocks.mermaidRender.mockResolvedValue({ svg: mermaidFlowchartSvg });

      render(<RenderedMarkdown content={MERMAID_BLOCK} />);

      await waitFor(() => {
        const diagram = screen.getByTestId('mermaid-diagram');
        expect(diagram.innerHTML).toContain('Node A');
        expect(diagram.innerHTML).toContain('foreignObject');
        expect(diagram.innerHTML).toContain('nodeLabel');
      });
    });

    it('strips dangerous HTML inside foreignObject', async () => {
      const maliciousSvg = '<svg><foreignObject><div><img src="x" onerror="alert(1)"/><script>alert(2)</script><span>Safe Label</span></div></foreignObject></svg>';
      mocks.mermaidRender.mockResolvedValue({ svg: maliciousSvg });

      render(<RenderedMarkdown content={MERMAID_BLOCK} />);

      await waitFor(() => {
        const diagram = screen.getByTestId('mermaid-diagram');
        expect(diagram.innerHTML).not.toBe('');
        expect(diagram.innerHTML).toContain('Safe Label');
        expect(diagram.innerHTML).toContain('foreignObject');
        expect(diagram.innerHTML).not.toContain('<img');
        expect(diagram.innerHTML).not.toContain('onerror');
        expect(diagram.innerHTML).not.toContain('<script');
        expect(diagram.innerHTML).not.toContain('alert');
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

    it('uses explicit ALLOWED_TAGS, ADD_TAGS, and ALLOWED_ATTR in SVG sanitize config', () => {
      // Verify the config has explicit allowlists (defense-in-depth)
      expect(SVG_SANITIZE_CONFIG.ALLOWED_TAGS).toBeDefined();
      expect(SVG_SANITIZE_CONFIG.ALLOWED_TAGS!.length).toBeGreaterThan(10);
      expect(SVG_SANITIZE_CONFIG.ALLOWED_ATTR).toBeDefined();
      expect(SVG_SANITIZE_CONFIG.ALLOWED_ATTR!.length).toBeGreaterThan(10);

      // Dangerous tags must NOT be in any allowlist
      const allAllowedTags = [...SVG_SANITIZE_CONFIG.ALLOWED_TAGS!, ...SVG_SANITIZE_CONFIG.ADD_TAGS!];
      const blockedTags = ['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'img'];
      for (const tag of blockedTags) {
        expect(allAllowedTags).not.toContain(tag);
      }

      // Event handler attributes must NOT be in the allowlist
      const blockedAttrs = ['onclick', 'onerror', 'onload', 'onmouseover', 'onfocus'];
      for (const attr of blockedAttrs) {
        expect(SVG_SANITIZE_CONFIG.ALLOWED_ATTR).not.toContain(attr);
      }

      // Core SVG tags must be in ALLOWED_TAGS
      const requiredSvgTags = ['svg', 'g', 'path', 'rect', 'text', 'tspan', 'defs', 'style', 'marker'];
      for (const tag of requiredSvgTags) {
        expect(SVG_SANITIZE_CONFIG.ALLOWED_TAGS).toContain(tag);
      }

      // foreignObject and HTML elements must be in ADD_TAGS (extends SVG profile)
      // Note: jsdom normalizes SVG tag names to lowercase at runtime
      const addTagsLower = SVG_SANITIZE_CONFIG.ADD_TAGS!.map((t: string) => t.toLowerCase());
      const requiredAddTags = ['foreignobject', 'div', 'span'];
      for (const tag of requiredAddTags) {
        expect(addTagsLower).toContain(tag);
      }

      // HTML_INTEGRATION_POINTS must include foreignobject for namespace bridging
      expect(SVG_SANITIZE_CONFIG.HTML_INTEGRATION_POINTS).toBeDefined();
      expect((SVG_SANITIZE_CONFIG as Record<string, unknown>).HTML_INTEGRATION_POINTS).toHaveProperty('foreignobject', true);
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
