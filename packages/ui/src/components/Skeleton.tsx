import type { CSSProperties, FC } from 'react';

interface SkeletonProps {
  /** Width of the skeleton. Accepts CSS value (e.g., '100%', '200px'). Default: '100%'. */
  width?: CSSProperties['width'];
  /** Height of the skeleton. Accepts CSS value (e.g., '20px', '2rem'). Default: '1rem'. */
  height?: CSSProperties['height'];
  /** Border radius. Default: 'var(--sam-radius-sm)'. */
  borderRadius?: CSSProperties['borderRadius'];
  /** Additional inline styles. */
  style?: CSSProperties;
  /** Additional class name. */
  className?: string;
}

/**
 * Skeleton placeholder for content that is loading.
 * Renders an animated pulsing bar that matches the layout of expected content.
 * Keyframes defined in packages/ui/src/styles.css (sam-skeleton-pulse).
 */
export const Skeleton: FC<SkeletonProps> = ({
  width = '100%',
  height = '1rem',
  borderRadius = 'var(--sam-radius-sm)',
  style,
  className,
}) => {
  return (
    <div
      className={`bg-surface ${className ?? ''}`}
      aria-hidden="true"
      style={{
        width,
        height,
        borderRadius,
        animation: 'sam-skeleton-pulse 1.5s ease-in-out infinite',
        ...style,
      }}
    />
  );
};

// ── Pre-built skeleton patterns ──

interface SkeletonCardProps {
  /** Number of text lines to show in the card body. Default: 3. */
  lines?: number;
  /** Additional inline styles for the card container. */
  style?: CSSProperties;
}

/**
 * A skeleton card matching the typical workspace/node card layout.
 */
export const SkeletonCard: FC<SkeletonCardProps> = ({ lines = 3, style }) => {
  return (
    <div
      className="border border-border-default rounded-md p-4 bg-surface flex flex-col gap-3"
      aria-hidden="true"
      style={style}
    >
      {/* Title row */}
      <div className="flex justify-between items-center">
        <Skeleton width="60%" height="1.25rem" />
        <Skeleton width="60px" height="1.25rem" borderRadius="9999px" />
      </div>
      {/* Body lines */}
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          width={i === lines - 1 ? '40%' : '80%'}
          height="0.875rem"
        />
      ))}
    </div>
  );
};

interface SkeletonListProps {
  /** Number of skeleton cards/rows to render. Default: 3. */
  count?: number;
  /** Variant: 'card' renders SkeletonCard, 'row' renders a single-line row. Default: 'card'. */
  variant?: 'card' | 'row';
  /** Additional inline styles for the container. */
  style?: CSSProperties;
}

/**
 * Render multiple skeleton items as a list.
 */
export const SkeletonList: FC<SkeletonListProps> = ({
  count = 3,
  variant = 'card',
  style,
}) => {
  return (
    <div
      className="flex flex-col gap-4"
      aria-hidden="true"
      aria-label="Loading content"
      style={style}
    >
      {Array.from({ length: count }, (_, i) =>
        variant === 'card' ? (
          <SkeletonCard key={i} />
        ) : (
          <Skeleton key={i} height="2.5rem" />
        )
      )}
    </div>
  );
};
