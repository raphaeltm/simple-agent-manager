import type { CSSProperties, ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Timeline — vertical stem + colored dot nodes
// ---------------------------------------------------------------------------

const DEFAULT_STEM_COLOR = 'rgba(34,197,94,0.2)';
const DEFAULT_DOT_COLOR = '#22c55e';

export interface TimelineProps {
  /** CSS color for the stem line gradient. Defaults to SAM green. */
  stemColor?: string;
  /** Extra className for the outer container */
  className?: string;
  /** Content shown when there are no children */
  emptyContent?: ReactNode;
  children?: ReactNode;
}

/**
 * The vertical stem line on its own, so a virtualized timeline can draw the same
 * line around a windowed item list instead of re-implementing it. Absolutely
 * positioned — the caller owns the `relative` container.
 */
export function TimelineStem({ stemColor = DEFAULT_STEM_COLOR }: { stemColor?: string }) {
  return (
    <div
      className="absolute left-[9px] top-0 bottom-0 w-[2px] rounded-full pointer-events-none"
      style={{
        background: `linear-gradient(to bottom, transparent 0%, ${stemColor} 6%, ${stemColor} 94%, transparent 100%)`,
      }}
    />
  );
}

export function Timeline({
  stemColor = DEFAULT_STEM_COLOR,
  className = '',
  emptyContent,
  children,
}: TimelineProps) {
  // Check if children is empty
  const hasChildren =
    children !== null && children !== undefined && children !== false;

  if (!hasChildren && emptyContent) {
    return <div className={className}>{emptyContent}</div>;
  }

  return (
    <div className={`relative ${className}`}>
      <TimelineStem stemColor={stemColor} />
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimelineItem — single entry with dot marker
// ---------------------------------------------------------------------------

export interface TimelineDotProps {
  /** CSS color for the dot fill. Defaults to green. */
  color?: string;
  /** Reduce opacity for muted/lazy entries */
  muted?: boolean;
}

export interface TimelineItemProps {
  /** Dot appearance overrides */
  dot?: TimelineDotProps;
  /** Extra className on the outer wrapper */
  className?: string;
  children?: ReactNode;
}

export function TimelineItem({
  dot,
  className = '',
  children,
}: TimelineItemProps) {
  const dotColor = dot?.color ?? DEFAULT_DOT_COLOR;
  const muted = dot?.muted ?? false;

  const dotStyle: CSSProperties = {
    backgroundColor: dotColor,
    borderColor: 'rgba(0,0,0,0.35)',
    boxShadow: `0 0 6px ${dotColor}30`,
    opacity: muted ? 0.3 : 1,
  };

  return (
    <div className={`flex items-stretch ${className}`}>
      {/* Dot column */}
      <div className="w-5 shrink-0 flex justify-center relative">
        <div
          className="absolute top-[14px] w-[10px] h-[10px] rounded-full border-2"
          style={dotStyle}
        />
      </div>
      {/* Content */}
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimelineSeparator — divider between entry groups
// ---------------------------------------------------------------------------

export interface TimelineSeparatorProps {
  /** Text label shown in the center of the divider */
  label?: string;
  /** Extra className */
  className?: string;
  children?: ReactNode;
}

export function TimelineSeparator({
  label,
  className = '',
  children,
}: TimelineSeparatorProps) {
  return (
    <div className={`flex items-center gap-2 pl-5 pr-1 py-2 my-1 ${className}`}>
      <div className="flex-1 h-px bg-border-default" />
      {label && !children && (
        <span className="text-[10px] text-fg-muted hover:text-fg-primary bg-transparent border border-border-default rounded-full px-2.5 py-0.5 transition-colors">
          {label}
        </span>
      )}
      {children}
      <div className="flex-1 h-px bg-border-default" />
    </div>
  );
}
