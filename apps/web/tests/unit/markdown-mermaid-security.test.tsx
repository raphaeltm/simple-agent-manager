/**
 * Library markdown (the file preview) draws Mermaid through RenderedMarkdown's own
 * diagram component, not the chat one. These tests drive that path with the real
 * Mermaid and DOMPurify to prove it applies the same rendering policy.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { RenderedMarkdown } from '../../src/components/MarkdownRenderer';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const PWN = 'window.__pwned=1';

beforeAll(() => {
  // jsdom has no layout engine; Mermaid only needs these to measure text.
  const proto = window.SVGElement.prototype as SVGElement & {
    getBBox?: () => DOMRect;
    getComputedTextLength?: () => number;
  };
  proto.getBBox ??= () => ({ x: 0, y: 0, width: 80, height: 20 }) as DOMRect;
  proto.getComputedTextLength ??= () => 60;
});

afterEach(() => {
  cleanup();
});

async function renderLibraryDiagram(source: string): Promise<SVGSVGElement> {
  render(<RenderedMarkdown content={['```mermaid', source, '```'].join('\n')} />);
  let svg: SVGSVGElement | null = null;
  await waitFor(
    () => {
      svg = screen.getByTestId('mermaid-diagram').querySelector('svg');
      expect(svg).not.toBeNull();
    },
    { timeout: 20_000 }
  );
  return svg as unknown as SVGSVGElement;
}

/** Elements outside SVG, event handlers, and anything that leaves the document. */
function activeContent(svg: SVGSVGElement): string[] {
  return [svg, ...Array.from(svg.querySelectorAll('*'))].flatMap((element) => {
    const findings: string[] = [];
    if (element.namespaceURI !== SVG_NAMESPACE) findings.push(`<${element.localName}>`);
    for (const { name, value } of Array.from(element.attributes)) {
      if (name.startsWith('xmlns')) continue; // namespace declarations, not references
      if (/^on/i.test(name) || /javascript:|https?:|url\(\s*['"]?\s*(?!#)/i.test(value)) {
        findings.push(`<${element.localName} ${name}="${value}">`);
      }
    }
    return findings;
  });
}

const svgTexts = (svg: SVGSVGElement) =>
  Array.from(svg.querySelectorAll('text')).map((text) =>
    (text.textContent ?? '').replace(/\s+/g, ' ').trim()
  );

describe('Mermaid in library markdown', () => {
  it('draws subgraph, edge and multi-line labels as SVG text', async () => {
    const svg = await renderLibraryDiagram(
      [
        'flowchart TD',
        '  subgraph Stage[Review stage]',
        '    A[Draft] -->|approve| B["Line one<br>Line two"]',
        '  end',
      ].join('\n')
    );

    expect(svg.querySelector('foreignObject')).toBeNull();
    expect(svgTexts(svg)).toEqual(
      expect.arrayContaining([
        'Review stage',
        'Draft',
        'approve',
        expect.stringMatching(/Line one\s*Line two/),
      ])
    );
    expect(activeContent(svg)).toEqual([]);
  }, 30_000);

  it('ignores a directive that turns HTML labels back on', async () => {
    const svg = await renderLibraryDiagram(
      `%%{init: {"htmlLabels": true}}%%\nflowchart TD\n  A["<img src=x onerror=${PWN}>"] --> B[Safe node]`
    );

    expect(svg.querySelector('foreignObject')).toBeNull();
    expect(svgTexts(svg)).toEqual(expect.arrayContaining(['Safe node']));
    expect(activeContent(svg)).toEqual([]);
  }, 30_000);

  it.each([
    [
      'themeCSS with a remote background',
      '%%{init: {"themeCSS": "background-image: url(https://evil.example/theme.png)"}}%%\nflowchart TD\n  A[Styled node] --> B[Other]',
      'Styled node',
    ],
    [
      'an external click link',
      'flowchart TD\n  A[Click me] --> B[Other]\n  click A "https://evil.example/click" _blank',
      'Click me',
    ],
    [
      'a state classDef that loads a remote image',
      'stateDiagram-v2\n  classDef evil background-image:url(https://evil.example/classdef.png)\n  [*] --> Styled\n  class Styled evil',
      'Styled',
    ],
  ])(
    'keeps %s out of the rendered SVG',
    async (_name, source, stillDrawn) => {
      const svg = await renderLibraryDiagram(source);

      expect(svg.outerHTML).not.toContain('evil.example');
      expect(svgTexts(svg)).toEqual(expect.arrayContaining([stillDrawn]));
      expect(activeContent(svg)).toEqual([]);
    },
    30_000
  );
});
