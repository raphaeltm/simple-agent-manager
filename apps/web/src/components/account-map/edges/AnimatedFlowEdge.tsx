import { type FC, useMemo } from 'react';
import { getBezierPath, type EdgeProps } from '@xyflow/react';

const PARTICLE_COUNT = 4;
const CYCLE_DURATION = 3;

/**
 * Custom React Flow edge with animated SVG particles flowing along the path.
 * Configurable color and activity state.
 */
export const AnimatedFlowEdge: FC<EdgeProps> = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
}) => {
  const color = (data?.color as string) ?? '#00ff88';
  const active = (data?.active as boolean) ?? false;

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const particles = useMemo(() => {
    if (!active) return null;
    return Array.from({ length: PARTICLE_COUNT }, (_, i) => {
      const delay = (i / PARTICLE_COUNT) * CYCLE_DURATION;
      return (
        <circle key={i} r="3" fill={color} opacity="0.9">
          <animateMotion
            dur={`${CYCLE_DURATION}s`}
            repeatCount="indefinite"
            begin={`${delay}s`}
            path={edgePath}
          />
        </circle>
      );
    });
  }, [active, color, edgePath]);

  const glowParticle = useMemo(() => {
    if (!active) return null;
    return (
      <circle r="6" fill={color} opacity="0.3" filter="url(#particle-glow)">
        <animateMotion
          dur={`${CYCLE_DURATION}s`}
          repeatCount="indefinite"
          path={edgePath}
        />
      </circle>
    );
  }, [active, color, edgePath]);

  return (
    <>
      <defs>
        <filter id="particle-glow">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={active ? color : 'var(--sam-color-border-default)'}
        strokeWidth={active ? 1.5 : 1}
        strokeOpacity={active ? 0.6 : 0.3}
        strokeDasharray={active ? undefined : '4 4'}
        style={style}
      />
      {glowParticle}
      {particles}
    </>
  );
};
