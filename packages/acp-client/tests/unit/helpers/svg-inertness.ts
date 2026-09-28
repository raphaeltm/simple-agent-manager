/**
 * Test support for rendering real Mermaid and judging the result. The chat and
 * library-markdown suites share it, and the Playwright audit runs the same
 * `findActiveContent` inside a real browser.
 */

/** Width jsdom reports per character of SVG text, so long labels wrap as in a browser. */
const CHARACTER_WIDTH = 8;

/**
 * jsdom has no layout engine, so Mermaid's text measurement finds no SVG
 * geometry methods. Text is measured by its length, so Mermaid wraps a long
 * label into rows; everything else has a fixed size. Tests judge markup, not
 * layout.
 */
export function installSvgLayoutStubs(): void {
  const proto = window.SVGElement.prototype as SVGElement & {
    getBBox?: () => DOMRect;
    getComputedTextLength?: () => number;
  };
  proto.getBBox ??= () => ({ x: 0, y: 0, width: 80, height: 20 }) as DOMRect;
  proto.getComputedTextLength ??= function (this: SVGElement) {
    return (this.textContent ?? '').length * CHARACTER_WIDTH;
  };
}

/**
 * Everything under `root` a browser could execute or use to fetch a resource:
 * non-SVG elements, event handlers, references that leave the document, and CSS
 * that names a remote resource. An empty list means the markup is inert.
 *
 * Self-contained on purpose: Playwright serializes it to run in a real browser,
 * so it may not refer to anything outside its own body.
 */
export function findActiveContent(root: Element): string[] {
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const inlineRasterImage = /^data:image\/(?:png|gif|jpe?g|webp);base64,/i;
  const externalCssReference = /url\s*\(\s*['"]?\s*(?!#)|image-set\s*\(|@import|\\/i;
  const findings: string[] = [];
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const tag = element.localName;
    if (element.namespaceURI !== svgNamespace) {
      findings.push(`non-SVG element <${tag}> (${element.namespaceURI})`);
    }
    for (const { name, value } of Array.from(element.attributes)) {
      const isHref = name === 'href' || name === 'xlink:href';
      const allowedHref =
        tag === 'image' ? inlineRasterImage.test(value.trim()) : value.trim().startsWith('#');
      if (/^on/i.test(name)) findings.push(`<${tag} ${name}>`);
      else if (/javascript:/i.test(value)) findings.push(`<${tag} ${name}="${value}">`);
      else if (isHref ? !allowedHref : externalCssReference.test(value)) {
        findings.push(`<${tag} ${name}="${value}">`);
      }
    }
    if (tag === 'style' && externalCssReference.test(element.textContent ?? '')) {
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
