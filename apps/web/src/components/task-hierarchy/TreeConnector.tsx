/** Width of the connector column in px. */
const CONNECTOR_W = 16;
/** Radius of the quarter-circle curve. */
const CURVE_R = 6;
/** Stroke width for connector lines. */
const LINE_W = 1.5;
/** X position of the vertical trunk line center. */
const TRUNK_X = 1;

/**
 * SVG connector column drawn to the left of each child node.
 * Stretches the full height of the child (including its sub-tree).
 *
 * Uses CSS custom property `--sam-color-tree-connector` for the stroke color.
 */
export function TreeConnector({ isLast, branchY }: { isLast: boolean; branchY: number }) {
  const curvePath = [
    `M${TRUNK_X},${branchY - CURVE_R}`,
    `Q${TRUNK_X},${branchY} ${TRUNK_X + CURVE_R},${branchY}`,
    `H${CONNECTOR_W}`,
  ].join(' ');

  return (
    <div
      style={{
        width: CONNECTOR_W,
        flexShrink: 0,
        alignSelf: 'stretch',
        position: 'relative',
        minHeight: branchY + 4,
      }}
    >
      <svg
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: CONNECTOR_W,
          height: '100%',
          overflow: 'visible',
        }}
        aria-hidden="true"
      >
        <line
          x1={TRUNK_X}
          y1={0}
          x2={TRUNK_X}
          y2={isLast ? branchY - CURVE_R : '100%'}
          stroke="var(--sam-color-tree-connector)"
          strokeWidth={LINE_W}
        />
        <path d={curvePath} fill="none" stroke="var(--sam-color-tree-connector)" strokeWidth={LINE_W} />
      </svg>
    </div>
  );
}

export { CONNECTOR_W };
