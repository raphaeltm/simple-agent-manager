/**
 * Explicit allowlists for DOMPurify SVG sanitization.
 * Mermaid output is generated from user/agent-controlled markdown, so keep the
 * policy narrow even though Mermaid itself is initialized in strict mode.
 */
export const MERMAID_SVG_SANITIZE_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ALLOWED_TAGS: [
    'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc',
    'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
    'text', 'tspan', 'textPath',
    'clipPath', 'mask', 'pattern', 'marker',
    'linearGradient', 'radialGradient', 'stop',
    'filter', 'feBlend', 'feColorMatrix', 'feComposite', 'feFlood',
    'feGaussianBlur', 'feMerge', 'feMergeNode', 'feOffset',
    'image', 'a',
    'style',
  ],
  ADD_TAGS: ['foreignObject', 'div', 'span', 'p', 'br'],
  // eslint-disable-next-line @typescript-eslint/naming-convention
  HTML_INTEGRATION_POINTS: { foreignobject: true, 'annotation-xml': true },
  ALLOWED_ATTR: [
    'id', 'class', 'style', 'xmlns', 'xmlns:xlink',
    'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
    'cx', 'cy', 'r', 'rx', 'ry',
    'd', 'points', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray',
    'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'fill-opacity',
    'opacity', 'fill-rule', 'clip-rule',
    'transform', 'transform-origin',
    'text-anchor', 'dominant-baseline', 'alignment-baseline',
    'font-family', 'font-size', 'font-weight', 'font-style',
    'letter-spacing', 'text-decoration', 'dx', 'dy',
    'href', 'xlink:href', 'clip-path', 'marker-start', 'marker-mid',
    'marker-end', 'mask',
    'offset', 'stop-color', 'stop-opacity', 'gradientTransform',
    'gradientUnits', 'patternUnits', 'patternTransform',
    'spreadMethod', 'fx', 'fy',
    'in', 'in2', 'result', 'mode', 'stdDeviation', 'flood-color',
    'flood-opacity', 'color-interpolation-filters',
    'markerWidth', 'markerHeight', 'refX', 'refY', 'orient',
    'markerUnits', 'overflow',
    'preserveAspectRatio', 'requiredExtensions', 'systemLanguage',
    'aria-hidden', 'role', 'tabindex', 'data-testid',
    'color', 'display', 'visibility',
  ],
};
