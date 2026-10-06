/**
 * The second layer on its own: whatever markup reaches sanitizeMermaidSvg, what
 * comes out must be inert once the browser re-parses it through innerHTML. The
 * payloads are known DOMPurify mutation-XSS shapes plus the ways SVG and CSS
 * can make a browser fetch a remote resource.
 */
import DOMPurify from 'dompurify';
import { describe, expect, it } from 'vitest';

import { sanitizeMermaidSvg } from '../../src/mermaid';
import { findActiveContent } from './helpers/svg-inertness';

const PWN = 'window.__pwned=1';

/** Sanitize, then re-parse the result the way the renderers insert it. */
function renderSanitized(markup: string): HTMLDivElement {
  const host = document.createElement('div');
  host.innerHTML = sanitizeMermaidSvg(markup, DOMPurify);
  return host;
}

function activeContentIn(host: HTMLElement): string[] {
  return Array.from(host.children).flatMap((child) => findActiveContent(child));
}

describe('sanitizeMermaidSvg', () => {
  const mutationXss: Array<[string, string]> = [
    [
      '</p> leaving <svg> for a <style> attribute',
      `<svg></p><style><a id="</style><img src=1 onerror=${PWN}>">`,
    ],
    [
      'MathML mglyph/style comment',
      `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=${PWN}&gt;">`,
    ],
    [
      'nested forms around MathML',
      `<form><math><mtext></form><form><mglyph><style></math><img src onerror=${PWN}>`,
    ],
    [
      '<style> inside a foreignObject paragraph',
      `<svg><foreignObject><p><style><img src=x onerror=${PWN}></style></p></foreignObject></svg>`,
    ],
    [
      'HTML inside foreignObject',
      `<svg><foreignObject><div><img src=x onerror=${PWN}><span>label</span></div></foreignObject></svg>`,
    ],
    [
      'iframe srcdoc inside foreignObject',
      `<svg><foreignObject><iframe srcdoc="<script>parent.${PWN}</script>"></iframe></foreignObject></svg>`,
    ],
    [
      'HTML under the <desc> integration point',
      `<svg><desc><img src=x onerror=${PWN}></desc></svg>`,
    ],
    [
      '<style> under the <title> integration point',
      `<svg><title><style><img src=x onerror=${PWN}></style></title></svg>`,
    ],
    [
      'annotation-xml encoded as HTML',
      `<svg><annotation-xml encoding="text/html"><style><img src=x onerror=${PWN}></style></annotation-xml></svg>`,
    ],
    [
      'CDATA closing a <style>',
      `<svg><style><![CDATA[</style><img src=x onerror=${PWN}>]]></style></svg>`,
    ],
    [
      'comment breaking out of a <style>',
      `<svg><p><style><!--</style><img src=x onerror=${PWN}>--></style></svg>`,
    ],
    ['markup inside an SVG comment', `<svg><!--<img src=x onerror=${PWN}>--></svg>`],
    ['CDATA inside <text>', `<svg><text><![CDATA[<img src=x onerror=${PWN}>]]></text></svg>`],
    ['<script> in the SVG', `<svg><script>${PWN}</script></svg>`],
    [
      'event handler attributes',
      `<svg onload="${PWN}"><rect onclick="${PWN}" width="1" height="1"/></svg>`,
    ],
    [
      'an animated href',
      `<svg><a><animate attributeName="href" values="javascript:${PWN}"/><text y="20">x</text></a></svg>`,
    ],
    ['<set> writing an event handler', `<svg><set attributeName="onmouseover" to="${PWN}"/></svg>`],
    [
      '<use> pulling in a data: SVG',
      '<svg><use href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=#x"/></svg>',
    ],
    ['a javascript: image', `<svg><image href="javascript:${PWN}"/></svg>`],
    ['a javascript: link', `<svg><a href="javascript:${PWN}"><text y="20">x</text></a></svg>`],
  ];

  it.each(mutationXss)('neutralizes %s', (_name, payload) => {
    const host = renderSanitized(payload);

    expect(activeContentIn(host)).toEqual([]);
    // Payload text may survive as escaped text inside <style> or <text>; what
    // matters is that no element or attribute it describes exists.
    expect(
      host.querySelectorAll('script, iframe, img, [onerror], [onload], [onclick]')
    ).toHaveLength(0);
  });

  const remoteReferences: Array<[string, string]> = [
    [
      'an external <image>',
      '<svg><image href="https://evil.example/px.png" width="1" height="1"/></svg>',
    ],
    [
      'an external xlink:href <image>',
      '<svg><image xlink:href="https://evil.example/px.png" width="1" height="1"/></svg>',
    ],
    [
      'a data: SVG <image>',
      '<svg><image href="data:image/svg+xml;base64,PHN2Zy8+" width="1" height="1"/></svg>',
    ],
    ['an external <a>', '<svg><a href="https://evil.example/"><text y="20">link</text></a></svg>'],
    [
      'an external <textPath>',
      '<svg><text><textPath href="https://evil.example/p.svg#p">x</textPath></text></svg>',
    ],
    [
      'a gradient inheriting from another document',
      '<svg><linearGradient id="g" href="https://evil.example/g.svg#g"/></svg>',
    ],
    [
      '<style> with url()',
      '<svg><style>svg{background-image:url(https://evil.example/css.png)}</style><rect width="1" height="1"/></svg>',
    ],
    [
      '<style> with an escaped url()',
      '<svg><style>svg{background-image:\\75 rl(https://evil.example/esc.png)}</style><rect width="1" height="1"/></svg>',
    ],
    [
      '<style> with image-set()',
      '<svg><style>svg{background-image:image-set("https://evil.example/set.png" 1x)}</style><rect width="1" height="1"/></svg>',
    ],
    ['<style> with @import', '<svg><style>@import "https://evil.example/imp.css";</style></svg>'],
    [
      'a style attribute with url()',
      '<svg><rect width="1" height="1" style="background-image:url(https://evil.example/attr.png)"/></svg>',
    ],
    [
      'a fill with an external paint server',
      '<svg><rect width="1" height="1" fill="url(https://evil.example/fill.svg#g)"/></svg>',
    ],
    [
      'a filter from another document',
      '<svg><rect width="1" height="1" filter="url(https://evil.example/f.svg#f)"/></svg>',
    ],
    [
      'an upper-case URL() marker',
      '<svg><path d="M0 0L9 9" marker-end="URL(https://evil.example/m.svg#m)"/></svg>',
    ],
    [
      'a protocol-relative url()',
      '<svg><rect width="1" height="1" style="fill:url(//evil.example/x.svg#g)"/></svg>',
    ],
    [
      'an feImage filter source',
      '<svg><filter id="f"><feImage href="https://evil.example/fe.png"/></filter></svg>',
    ],
  ];

  it.each(remoteReferences)('drops %s', (_name, payload) => {
    const host = renderSanitized(payload);

    expect(host.innerHTML).not.toContain('evil.example');
    expect(activeContentIn(host)).toEqual([]);
  });

  it('keeps what Mermaid draws: in-document references, CSS and inline raster images', () => {
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const host = renderSanitized(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" role="graphics-document document" aria-roledescription="flowchart-v2">',
        '<style>#d{font-family:system-ui;fill:#e6f2ee;}#d .marker{fill:url(#g);}</style>',
        '<defs><marker id="m" refX="5" refY="5" orient="auto"><path d="M0 0L10 5L0 10z"/></marker>',
        '<linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient>',
        '<filter id="shadow"><feDropShadow dx="1" dy="1" stdDeviation="1"/></filter></defs>',
        '<rect width="100" height="40" fill="url(#g)" style="filter:url(#shadow)" data-look="classic"/>',
        '<path d="M0 0L10 10" marker-end="url(#m)"/>',
        '<text x="10" y="20" text-anchor="middle"><tspan xml:space="preserve" class="row">Safe label</tspan></text>',
        `<image href="${png}" width="1" height="1"/>`,
        '</svg>',
      ].join('')
    );

    const svg = host.querySelector('svg');
    expect(activeContentIn(host)).toEqual([]);
    expect(svg?.getAttribute('viewBox')).toBe('0 0 100 40');
    expect(svg?.getAttribute('aria-roledescription')).toBe('flowchart-v2');
    expect(host.querySelector('style')?.textContent).toContain('fill:url(#g)');
    expect(host.querySelector('rect')?.getAttribute('fill')).toBe('url(#g)');
    expect(host.querySelector('rect')?.getAttribute('style')).toBe('filter:url(#shadow)');
    expect(host.querySelector('rect')?.getAttribute('data-look')).toBe('classic');
    expect(host.querySelector('path[marker-end]')?.getAttribute('marker-end')).toBe('url(#m)');
    // jsdom's parser lower-cases this tag name; browsers keep feDropShadow.
    expect(host.querySelector('filter')?.firstElementChild?.localName.toLowerCase()).toBe(
      'fedropshadow'
    );
    expect(host.querySelector('image')?.getAttribute('href')).toBe(png);
    expect(host.querySelector('tspan')?.textContent).toBe('Safe label');
  });

  it('leaves the shared DOMPurify instance untouched', () => {
    renderSanitized('<svg><image href="https://evil.example/px.png"/></svg>');

    // The Mermaid hooks live on a dedicated instance, so the host's other
    // sanitizing (plain HTML with ordinary links) behaves as before.
    const html = DOMPurify.sanitize('<a href="https://example.com/docs">docs</a>');
    expect(html).toBe('<a href="https://example.com/docs">docs</a>');
  });
});
