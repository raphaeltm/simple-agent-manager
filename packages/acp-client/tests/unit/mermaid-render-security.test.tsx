/**
 * Agent-written Mermaid through the real chat pipeline: MessageBubble →
 * MermaidDiagram → mermaid.render → sanitizeMermaidSvg → innerHTML. Nothing is
 * mocked; jsdom only gets the SVG measurement methods it lacks.
 *
 * Every attack pairs "nothing executable or remote survived" with a label that
 * must still be drawn, so a diagram that silently failed to render cannot pass.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MessageBubble } from '../../src/components/MessageBubble';
import { findActiveContent, installSvgLayoutStubs, svgTexts } from './helpers/svg-inertness';

const PWN = 'window.__pwned=1';

beforeAll(() => {
  installSvgLayoutStubs();
});

afterEach(() => {
  cleanup();
});

async function renderAgentDiagram(source: string): Promise<SVGSVGElement> {
  render(<MessageBubble role="agent" text={['```mermaid', source, '```'].join('\n')} />);
  const viewport = await screen.findByTestId('mermaid-diagram-svg', {}, { timeout: 20_000 });
  const svg = viewport.querySelector('svg');
  if (!svg) throw new Error('Mermaid rendered no <svg>');
  return svg;
}

describe('Mermaid diagrams keep their labels as SVG text', () => {
  it('draws node, subgraph, edge and multi-line labels without HTML', async () => {
    const svg = await renderAgentDiagram(
      [
        'flowchart TD',
        '  subgraph Pipeline[Build pipeline stage]',
        '    A[Start here] -->|edge label| B{Is it ok?}',
        '    B -->|Yes| C["Line one<br>Line two"]',
        '  end',
      ].join('\n')
    );

    expect(svg.querySelector('foreignObject')).toBeNull();
    const texts = svgTexts(svg);
    expect(texts).toEqual(
      expect.arrayContaining([
        'Build pipeline stage',
        'Start here',
        'edge label',
        'Is it ok?',
        expect.stringMatching(/Line one\s*Line two/),
      ])
    );
    // A multi-line label stays two rows, not one run of text.
    const multiLine = Array.from(svg.querySelectorAll('text')).find((text) =>
      text.textContent?.includes('Line one')
    );
    expect(multiLine?.querySelectorAll('tspan.row')).toHaveLength(2);
    expect(findActiveContent(svg)).toEqual([]);
  }, 30_000);

  it('keeps markdown-string labels and a sequence diagram readable', async () => {
    const flow = await renderAgentDiagram(
      'flowchart LR\n  A["`**Bold** and _italic_`"] --> B[Plain]'
    );
    expect(svgTexts(flow)).toEqual(expect.arrayContaining(['Bold and italic', 'Plain']));
    cleanup();

    const sequence = await renderAgentDiagram('sequenceDiagram\n  Alice->>Bob: Hello Bob');
    expect(svgTexts(sequence)).toEqual(expect.arrayContaining(['Alice', 'Bob', 'Hello Bob']));
    expect(findActiveContent(sequence)).toEqual([]);
  }, 30_000);
});

describe('Mermaid source cannot plant HTML, script or event handlers', () => {
  const cases: Array<{ name: string; source: string; stillDrawn: string }> = [
    {
      name: 'an img/onerror node label',
      source: `flowchart TD\n  A["<img src=x onerror=${PWN}>"] --> B[Safe node]`,
      stillDrawn: 'Safe node',
    },
    {
      name: 'a script node label',
      source: `flowchart TD\n  A["<script>${PWN}</script>Label"] --> B[Safe node]`,
      stillDrawn: 'Safe node',
    },
    {
      name: 'a subgraph title',
      source: `flowchart TD\n  subgraph S["<img src=x onerror=${PWN}>Title"]\n    A --> B[Safe node]\n  end`,
      stillDrawn: 'Safe node',
    },
    {
      name: 'an edge label',
      source: `flowchart TD\n  A -->|"<img src=x onerror=${PWN}>edge"| B[Safe node]`,
      stillDrawn: 'Safe node',
    },
    {
      name: 'accessibility title and description',
      source: [
        'flowchart TD',
        `  accTitle: <img src=x onerror=${PWN}>`,
        '  accDescr: </desc><image href="https://evil.example/acc.png"/>',
        '  A --> B[Safe node]',
      ].join('\n'),
      stillDrawn: 'Safe node',
    },
    {
      name: 'a markdown-string label',
      source: 'flowchart TD\n  A["`<img src=x onerror=' + PWN + '> **md**`"] --> B[Safe node]',
      stillDrawn: 'Safe node',
    },
    {
      name: 'mXSS: <style> inside <foreignObject> inside a label',
      source: `flowchart TD\n  A["<svg><foreignObject><p><style><img src=x onerror=${PWN}></style></p></foreignObject></svg>"] --> B[Safe node]`,
      stillDrawn: 'Safe node',
    },
    {
      name: 'mXSS: MathML mglyph/style comment confusion',
      source: `flowchart TD\n  A["<math><mtext><table><mglyph><style><!--</style><img title=#quot;--&gt;&lt;img src=1 onerror=${PWN}&gt;#quot;>"] --> B[Safe node]`,
      stillDrawn: 'Safe node',
    },
    {
      name: 'mXSS: </p> breaking out of <svg> into <style>',
      source: `flowchart TD\n  A["<svg></p><style><a id=#quot;</style><img src=1 onerror=${PWN}>#quot;>"] --> B[Safe node]`,
      stillDrawn: 'Safe node',
    },
    {
      name: 'a javascript: click link',
      source: `flowchart TD\n  A[Click me] --> B[Safe node]\n  click A href "javascript:${PWN}"`,
      stillDrawn: 'Click me',
    },
    {
      name: 'a directive asking for loose security plus a click callback',
      source:
        '%%{init: {"securityLevel": "loose"}}%%\nflowchart TD\n  A[Click me] --> B[Safe node]\n  click A call alert(1)',
      stillDrawn: 'Click me',
    },
    {
      name: 'a directive widening Mermaid’s own label sanitizer',
      source: `%%{init: {"dompurifyConfig": {"ADD_TAGS": ["iframe"], "ADD_ATTR": ["onerror", "srcdoc"]}, "htmlLabels": true}}%%\nflowchart TD\n  A["<iframe srcdoc='<script>parent.${PWN}</script>'></iframe>x"] --> B[Safe node]`,
      stillDrawn: 'Safe node',
    },
  ];

  it.each(cases)(
    'neutralizes $name',
    async ({ source, stillDrawn }) => {
      const svg = await renderAgentDiagram(source);

      expect(findActiveContent(svg)).toEqual([]);
      expect(svgTexts(svg)).toEqual(expect.arrayContaining([stillDrawn]));
      expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
    },
    30_000
  );
});

describe('Mermaid directives cannot undo the rendering policy', () => {
  it.each([
    ['%%{init: {"htmlLabels": true}}%%'],
    ['%%{init: {"flowchart": {"htmlLabels": true}}}%%'],
    ['---\nconfig:\n  htmlLabels: true\n---'],
  ])(
    'ignores %s and still draws labels as SVG text',
    async (directive) => {
      const svg = await renderAgentDiagram(
        `${directive}\nflowchart TD\n  A[First label] --> B[Second label]`
      );

      // Honouring the directive would emit <foreignObject> labels, which the
      // sanitizer drops, so the labels would vanish rather than leak.
      expect(svg.querySelector('foreignObject')).toBeNull();
      expect(svgTexts(svg)).toEqual(expect.arrayContaining(['First label', 'Second label']));
    },
    30_000
  );

  it.each([
    ['themeCSS', '"themeCSS": "background-image: url(https://evil.example/theme.png)"'],
    ['themeCSS @import', '"themeCSS": "@import url(https://evil.example/import.css);"'],
    ['fontFamily', '"fontFamily": "x;background-image:url(https://evil.example/font.png)"'],
    ['altFontFamily', '"altFontFamily": "x;background-image:url(https://evil.example/alt.png)"'],
  ])(
    'ignores CSS injected through %s',
    async (_key, init) => {
      const svg = await renderAgentDiagram(
        `%%{init: {${init}}}%%\nflowchart TD\n  A[Styled node] --> B[Other]`
      );
      const stylesheet = svg.querySelector('style')?.textContent ?? '';

      // The diagram's own stylesheet survives intact. Had the directive landed,
      // the sanitizer would have emptied the whole sheet instead.
      expect(stylesheet).toContain('font-family:system-ui');
      expect(stylesheet).not.toContain('evil.example');
      expect(findActiveContent(svg)).toEqual([]);
    },
    30_000
  );

  it('ignores arrowMarkerAbsolute, keeping marker references inside the document', async () => {
    const svg = await renderAgentDiagram(
      '%%{init: {"arrowMarkerAbsolute": true}}%%\nflowchart TD\n  A[From] --> B[To]'
    );

    const markerEnds = Array.from(svg.querySelectorAll('[marker-end]')).map((element) =>
      element.getAttribute('marker-end')
    );
    expect(markerEnds.length).toBeGreaterThan(0);
    for (const reference of markerEnds) expect(reference).toMatch(/^url\(#/);
  }, 30_000);
});

describe('Mermaid diagrams never reference resources outside the document', () => {
  const cases: Array<{ name: string; source: string; stillDrawn: string }> = [
    {
      name: 'an external flowchart click link',
      source:
        'flowchart TD\n  A[Click me] --> B[Safe node]\n  click A "https://evil.example/click" _blank',
      stillDrawn: 'Click me',
    },
    {
      name: 'a class diagram link',
      source: 'classDiagram\n  class Evil\n  link Evil "https://evil.example/class"',
      stillDrawn: 'Evil',
    },
    {
      name: 'a sequence diagram actor link',
      source:
        'sequenceDiagram\n  participant A\n  link A: Dashboard @ https://evil.example/seq\n  A->>A: hello',
      stillDrawn: 'hello',
    },
    {
      name: 'a state classDef that styles with a remote image',
      source:
        'stateDiagram-v2\n  classDef evil background-image:url(https://evil.example/classdef.png),fill:red\n  [*] --> Styled\n  class Styled evil',
      stillDrawn: 'Styled',
    },
  ];

  it.each(cases)(
    'drops $name',
    async ({ source, stillDrawn }) => {
      const svg = await renderAgentDiagram(source);

      expect(svg.outerHTML).not.toContain('evil.example');
      expect(findActiveContent(svg)).toEqual([]);
      expect(svgTexts(svg)).toEqual(expect.arrayContaining([stillDrawn]));
    },
    30_000
  );
});
