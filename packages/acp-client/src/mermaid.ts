/**
 * Rendering policy for agent-written Mermaid diagrams.
 *
 * Diagram source comes from agents and the SVG Mermaid draws is assigned with
 * innerHTML, so the rendered markup is untrusted. Two layers keep it inert:
 *
 * 1. Mermaid draws every label as SVG text, so its output contains no HTML
 *    (no `<foreignObject>`), and a diagram's own directives can neither switch
 *    HTML labels back on nor inject CSS.
 * 2. The SVG is sanitized to an SVG-only allowlist in which every reference must
 *    point inside the document, so the browser never fetches a resource that a
 *    diagram names.
 *
 * Every Mermaid renderer goes through `renderMermaidSvg`. Mermaid and DOMPurify
 * are passed in rather than imported, so this module adds neither to a caller's
 * initial bundle.
 */
import type {
  Config as DOMPurifyConfig,
  DOMPurify,
  UponSanitizeAttributeHookEvent,
  UponSanitizeElementHookEvent,
} from 'dompurify';
import type { Mermaid, MermaidConfig } from 'mermaid';

const MERMAID_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MERMAID_TEXT_COLOR = '#e6f2ee';

/**
 * Config keys a diagram may not change through its own `%%{init}%%` directive or
 * front matter. Mermaid deletes them from directives at every nesting level.
 * Keys outside Mermaid's config schema (`altFontFamily`, `dompurifyConfig`)
 * never survive a directive, so they need no entry.
 */
const DIRECTIVE_LOCKED_KEYS = [
  // Mermaid's own defaults, listed so this list is complete on its own.
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  // Would bring back HTML labels. `flowchart.htmlLabels` is covered too, and
  // the top-level `htmlLabels: false` below outranks it anyway.
  'htmlLabels',
  // Raw CSS, and a font name that Mermaid pastes into CSS rules unvalidated.
  'themeCSS',
  'fontFamily',
  // Turns in-document marker references into absolute URLs.
  'arrowMarkerAbsolute',
];

/**
 * A few diagram types style their labels for the HTML-label layout. Restore
 * readable, centred SVG text.
 */
const SVG_LABEL_CSS = [
  // Journey section titles otherwise take the section's fill colour.
  `text.journey-section { fill: ${MERMAID_TEXT_COLOR}; }`,
  // The mindmap root circle places its label from the centre.
  '.mindmap-node.section-root text { text-anchor: middle; }',
].join(' ');

const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  logLevel: 5,
  theme: 'dark',
  fontFamily: MERMAID_FONT,
  themeVariables: {
    darkMode: true,
    background: '#13201d',
    primaryColor: '#1a3a32',
    primaryTextColor: MERMAID_TEXT_COLOR,
    primaryBorderColor: '#29423b',
    secondaryColor: '#1a2e3a',
    tertiaryColor: '#2a1a3a',
    lineColor: '#9fb7ae',
    textColor: MERMAID_TEXT_COLOR,
    mainBkg: '#1a3a32',
    nodeBorder: '#29423b',
    clusterBkg: '#13201d',
    clusterBorder: '#29423b',
    titleColor: MERMAID_TEXT_COLOR,
    edgeLabelBackground: '#13201d',
    nodeTextColor: MERMAID_TEXT_COLOR,
    // The dark theme otherwise labels section-coloured shapes (kanban columns,
    // mindmap and timeline nodes) in black.
    scaleLabelColor: MERMAID_TEXT_COLOR,
    fontFamily: MERMAID_FONT,
  },
  htmlLabels: false,
  // Both default to drawing text inside a <foreignObject>.
  journey: { textPlacement: 'tspan' },
  timeline: { textPlacement: 'tspan' },
  themeCSS: SVG_LABEL_CSS,
  secure: DIRECTIVE_LOCKED_KEYS,
};

/**
 * The SVG vocabulary Mermaid draws with. The lists are authoritative because
 * `USE_PROFILES` is not set: DOMPurify replaces explicit allowlists with a
 * profile's when both are given. `data-*` and `aria-*` attributes stay allowed
 * by DOMPurify's defaults.
 */
const MERMAID_SVG_SANITIZE_CONFIG: DOMPurifyConfig = {
  ALLOWED_NAMESPACES: ['http://www.w3.org/2000/svg'],
  ALLOWED_TAGS: [
    'svg',
    'g',
    'defs',
    'symbol',
    'title',
    'desc',
    'style',
    'path',
    'circle',
    'ellipse',
    'rect',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'textPath',
    'clipPath',
    'mask',
    'pattern',
    'marker',
    'linearGradient',
    'radialGradient',
    'stop',
    'filter',
    'feBlend',
    'feColorMatrix',
    'feComposite',
    'feDropShadow',
    'feFlood',
    'feGaussianBlur',
    'feMerge',
    'feMergeNode',
    'feOffset',
    'image',
  ],
  ALLOWED_ATTR: [
    'id',
    'class',
    'style',
    'xmlns',
    'xmlns:xlink',
    'xml:space',
    'viewBox',
    'width',
    'height',
    'x',
    'y',
    'x1',
    'y1',
    'x2',
    'y2',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'd',
    'points',
    'fill',
    'stroke',
    'stroke-width',
    'stroke-dasharray',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-opacity',
    'fill-opacity',
    'opacity',
    'fill-rule',
    'clip-rule',
    'transform',
    'transform-origin',
    'text-anchor',
    'dominant-baseline',
    'alignment-baseline',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'letter-spacing',
    'text-decoration',
    'dx',
    'dy',
    'textLength',
    'lengthAdjust',
    'href',
    'xlink:href',
    'clip-path',
    'marker-start',
    'marker-mid',
    'marker-end',
    'mask',
    'offset',
    'stop-color',
    'stop-opacity',
    'gradientTransform',
    'gradientUnits',
    'patternUnits',
    'patternTransform',
    'spreadMethod',
    'fx',
    'fy',
    'in',
    'in2',
    'result',
    'mode',
    'stdDeviation',
    'flood-color',
    'flood-opacity',
    'color-interpolation-filters',
    'markerWidth',
    'markerHeight',
    'refX',
    'refY',
    'orient',
    'markerUnits',
    'overflow',
    'preserveAspectRatio',
    'role',
    'color',
    'display',
    'visibility',
  ],
};

/** C4 diagrams embed their person and system icons as inline raster images. */
const INLINE_RASTER_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp);base64,/i;

/**
 * True when CSS could make the browser fetch something outside the SVG: a
 * `url()` that is not a same-document `#fragment`, `image-set()`, or `@import`.
 * CSS escapes can spell any of those and Mermaid never emits a backslash, so
 * CSS that contains one is refused outright.
 */
function cssReferencesExternalResource(css: string): boolean {
  if (css.includes('\\') || /@import|image-set\s*\(/i.test(css)) return true;
  return Array.from(css.matchAll(/url\s*\(\s*['"]?\s*([^'")\s]*)/gi)).some(
    ([, target = '']) => !target.startsWith('#')
  );
}

function isAllowedReference(element: Element, href: string): boolean {
  return element.nodeName.toLowerCase() === 'image'
    ? INLINE_RASTER_IMAGE.test(href)
    : href.startsWith('#');
}

function keepReferencesInsideTheDocument(element: Element, data: UponSanitizeAttributeHookEvent) {
  const { attrName, attrValue } = data;
  const allowed =
    attrName === 'href' || attrName === 'xlink:href'
      ? isAllowedReference(element, attrValue)
      : !cssReferencesExternalResource(attrValue);
  if (!allowed) data.keepAttr = false;
}

function emptyStyleSheetsThatFetch(node: Node, data: UponSanitizeElementHookEvent) {
  if (data.tagName === 'style' && cssReferencesExternalResource(node.textContent ?? '')) {
    node.textContent = '';
  }
}

/** One hooked instance per DOMPurify, so the hooks never touch its other uses. */
const mermaidPurifiers = new WeakMap<DOMPurify, DOMPurify>();

function mermaidPurifier(domPurify: DOMPurify): DOMPurify {
  let purifier = mermaidPurifiers.get(domPurify);
  if (!purifier) {
    purifier = domPurify();
    purifier.addHook('uponSanitizeElement', emptyStyleSheetsThatFetch);
    purifier.addHook('uponSanitizeAttribute', keepReferencesInsideTheDocument);
    mermaidPurifiers.set(domPurify, purifier);
  }
  return purifier;
}

/** Reduce Mermaid output to inert, self-contained SVG markup. */
export function sanitizeMermaidSvg(svg: string, domPurify: DOMPurify): string {
  return mermaidPurifier(domPurify).sanitize(svg, MERMAID_SVG_SANITIZE_CONFIG);
}

export interface MermaidRuntime {
  readonly mermaid: Mermaid;
  readonly domPurify: DOMPurify;
}

const configuredMermaids = new WeakSet<Mermaid>();

/**
 * Render agent-written Mermaid source to SVG markup that is safe to assign with
 * innerHTML. Rejects with Mermaid's error when the source does not parse.
 */
export async function renderMermaidSvg(
  { mermaid, domPurify }: MermaidRuntime,
  diagramId: string,
  source: string
): Promise<string> {
  if (!configuredMermaids.has(mermaid)) {
    mermaid.initialize(MERMAID_CONFIG);
    configuredMermaids.add(mermaid);
  }
  const { svg } = await mermaid.render(diagramId, source);
  return sanitizeMermaidSvg(svg, domPurify);
}
