/**
 * Test support for rendering real Mermaid under jsdom and judging the result.
 */

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const INLINE_RASTER_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp);base64,/i;
const EXTERNAL_CSS_REFERENCE = /url\s*\(\s*['"]?\s*(?!#)|image-set\s*\(|@import|\\/i;

/**
 * jsdom has no layout engine, so Mermaid's text measurement finds no SVG
 * geometry methods. Fixed sizes are enough: tests judge markup, not layout.
 */
export function installSvgLayoutStubs(): void {
  const proto = window.SVGElement.prototype as SVGElement & {
    getBBox?: () => DOMRect;
    getComputedTextLength?: () => number;
  };
  proto.getBBox ??= () => ({ x: 0, y: 0, width: 80, height: 20 }) as DOMRect;
  proto.getComputedTextLength ??= () => 60;
}

function isAllowedReference(element: Element, href: string): boolean {
  return element.localName === 'image' ? INLINE_RASTER_IMAGE.test(href) : href.startsWith('#');
}

/**
 * Everything under `root` a browser could execute or use to fetch a resource:
 * non-SVG elements, event handlers, references that leave the document, and CSS
 * that names a remote resource. An empty list means the markup is inert.
 */
export function findActiveContent(root: Element): string[] {
  const findings: string[] = [];
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const tag = element.localName;
    if (element.namespaceURI !== SVG_NAMESPACE) {
      findings.push(`non-SVG element <${tag}> (${element.namespaceURI})`);
    }
    for (const { name, value } of Array.from(element.attributes)) {
      const isHref = name === 'href' || name === 'xlink:href';
      if (/^on/i.test(name)) findings.push(`<${tag} ${name}>`);
      else if (/javascript:/i.test(value)) findings.push(`<${tag} ${name}="${value}">`);
      else if (isHref && !isAllowedReference(element, value.trim())) {
        findings.push(`<${tag} ${name}="${value}">`);
      } else if (!isHref && EXTERNAL_CSS_REFERENCE.test(value)) {
        findings.push(`<${tag} ${name}="${value}">`);
      }
    }
    if (tag === 'style' && EXTERNAL_CSS_REFERENCE.test(element.textContent ?? '')) {
      findings.push(`<style> ${element.textContent}`);
    }
  }
  return findings;
}

/** The text a user sees in the diagram, one entry per SVG <text> element. */
export function svgTexts(root: Element): string[] {
  return Array.from(root.querySelectorAll('text')).map((text) =>
    (text.textContent ?? '').replace(/\s+/g, ' ').trim()
  );
}
