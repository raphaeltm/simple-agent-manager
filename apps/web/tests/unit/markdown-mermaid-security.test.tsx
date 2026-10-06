/**
 * Library markdown (the file preview) draws Mermaid through RenderedMarkdown's own
 * diagram component, not the chat one. These tests drive that path with the real
 * Mermaid and DOMPurify to prove it applies the same rendering policy.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// One judge of "inert" for every Mermaid path: the chat suites and the browser
// audit use the same helper.
import {
  findActiveContent,
  installSvgLayoutStubs,
  svgTexts,
} from '../../../../packages/acp-client/tests/unit/helpers/svg-inertness';
import { RenderedMarkdown } from '../../src/components/MarkdownRenderer';

const PWN = 'window.__pwned=1';

beforeAll(() => {
  installSvgLayoutStubs();
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
      expect.arrayContaining(['Review stage', 'Draft', 'approve', 'Line one Line two'])
    );
    expect(findActiveContent(svg)).toEqual([]);
  }, 30_000);

  it('keeps a wrapped label readable as words', async () => {
    const label = 'Render a Mermaid diagram inside the library preview without any HTML labels';
    const svg = await renderLibraryDiagram(`flowchart LR\n  A[${label}] --> B[Short]`);

    const text = Array.from(svg.querySelectorAll('text')).find((node) =>
      node.textContent?.startsWith('Render')
    );
    expect(text?.querySelectorAll('tspan.row').length).toBeGreaterThan(1);
    expect(svgTexts(svg)).toEqual(expect.arrayContaining([label, 'Short']));
  }, 30_000);

  it('ignores a directive that turns HTML labels back on', async () => {
    const svg = await renderLibraryDiagram(
      `%%{init: {"htmlLabels": true}}%%\nflowchart TD\n  A["<img src=x onerror=${PWN}>"] --> B[Safe node]`
    );

    expect(svg.querySelector('foreignObject')).toBeNull();
    expect(svgTexts(svg)).toEqual(expect.arrayContaining(['Safe node']));
    expect(findActiveContent(svg)).toEqual([]);
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
      expect(findActiveContent(svg)).toEqual([]);
    },
    30_000
  );
});
