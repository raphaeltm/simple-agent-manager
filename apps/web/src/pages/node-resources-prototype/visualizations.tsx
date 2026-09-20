// PROTOTYPE — design exploration only. Never ships to production.
import type { CSSProperties, FC } from 'react';

import {
  fillFraction,
  formatAmount,
  formatWithUnit,
  headlineNumber,
  type NodeAllocation,
  overCommitOf,
  remainingOf,
  RESOURCE_KEYS,
  RESOURCE_LABELS,
  type ResourceKey,
  segmentColor,
  severityColor,
  unitOf,
} from './allocation';

const TRACK = 'var(--sam-color-bg-inset)';
const SURFACE_GAP = 2;

export interface BarSegment {
  color: string;
  value: number;
  label: string;
}

function segmentsFor(allocation: NodeAllocation, key: ResourceKey): BarSegment[] {
  return allocation.segments.map((segment) => ({
    color: segmentColor(segment.colorIndex),
    value: segment.amounts[key],
    label: `${segment.label}: ${formatWithUnit(key, segment.amounts[key])}`,
  }));
}

function ariaFor(allocation: NodeAllocation, key: ResourceKey): string {
  const capacity = allocation.capacity?.[key] ?? 0;
  return `${RESOURCE_LABELS[key]}: ${formatAmount(key, allocation.reserved[key])} of ${formatWithUnit(key, capacity)} reserved`;
}

/**
 * Horizontal stacked meter. Segments scale against max(capacity, reserved) so an
 * over-committed node never overflows the track; a danger hairline marks capacity instead.
 * A 2px surface gap separates segments; the last segment carries the rounded data-end.
 */
export const SegmentBar: FC<{
  segments: BarSegment[];
  capacity: number;
  live?: number | null;
  height?: number;
  ariaLabel: string;
}> = ({ segments, capacity, live, height = 8, ariaLabel }) => {
  const visible = segments.filter((segment) => segment.value > 0);
  const total = visible.reduce((sum, segment) => sum + segment.value, 0);
  const scale = Math.max(capacity, total, 1);
  const over = total > capacity;
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      style={{
        position: 'relative',
        height,
        borderRadius: 999,
        background: TRACK,
        overflow: 'hidden',
        minWidth: 0,
      }}
    >
      <div style={{ position: 'absolute', inset: 0, display: 'flex', gap: SURFACE_GAP }}>
        {visible.map((segment, index) => (
          <div
            key={`${segment.label}-${index}`}
            title={segment.label}
            style={{
              width: `${(segment.value / scale) * 100}%`,
              background: segment.color,
              opacity: segment.color.includes('fg-muted') ? 0.45 : 1,
              borderRadius: index === visible.length - 1 ? '0 999px 999px 0' : 0,
              flexShrink: 0,
            }}
          />
        ))}
      </div>
      {over && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `calc(${(capacity / scale) * 100}% - 1px)`,
            width: 2,
            background: 'var(--sam-color-danger)',
          }}
        />
      )}
      {live != null && (
        <div
          aria-hidden="true"
          title="Live usage"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `calc(${Math.min(live, 1) * 100}% - 1px)`,
            width: 2,
            background: 'var(--sam-color-fg-primary)',
            boxShadow: '0 0 0 1px var(--sam-color-bg-surface)',
          }}
        />
      )}
    </div>
  );
};

function remainingLabel(allocation: NodeAllocation, key: ResourceKey) {
  const remaining = remainingOf(allocation, key);
  const over = overCommitOf(allocation, key);
  if (remaining == null) return <span className="text-fg-muted">unknown</span>;
  if (over > 0) {
    return (
      <span style={{ color: 'var(--sam-color-danger-fg)' }}>over by {formatWithUnit(key, over)}</span>
    );
  }
  if (remaining === 0) return <span style={{ color: 'var(--sam-color-warning-fg)' }}>Full</span>;
  return (
    <span className="text-fg-primary">
      {formatWithUnit(key, remaining)} <span className="text-fg-muted">left</span>
    </span>
  );
}

/** Concept A row: label · stacked bar · remaining. */
export const MeterRow: FC<{ allocation: NodeAllocation; resource: ResourceKey; height?: number }> = ({
  allocation,
  resource,
  height = 8,
}) => (
  <div
    className="sam-type-caption"
    style={{ display: 'grid', gridTemplateColumns: '34px minmax(0,1fr) auto', alignItems: 'center', columnGap: 8 }}
  >
    <span className="text-fg-muted">{RESOURCE_LABELS[resource]}</span>
    <SegmentBar
      segments={segmentsFor(allocation, resource)}
      capacity={allocation.capacity?.[resource] ?? 0}
      live={allocation.live[resource]}
      height={height}
      ariaLabel={ariaFor(allocation, resource)}
    />
    <span className="tabular-nums whitespace-nowrap" style={{ minWidth: 64, textAlign: 'right' }}>
      {remainingLabel(allocation, resource)}
    </span>
  </div>
);

export const CapacityUnknown: FC<{ allocation: NodeAllocation }> = ({ allocation }) => (
  <span className="sam-type-caption text-fg-muted italic">
    Capacity unknown — no hardware report.
    {allocation.segments.length > 0 &&
      ` ${allocation.segments.length} reservation${allocation.segments.length === 1 ? '' : 's'} recorded.`}
  </span>
);

const hasLive = (allocation: NodeAllocation) =>
  RESOURCE_KEYS.some((key) => allocation.live[key] != null);

/** Concept A: three horizontal meters with per-workspace segments. */
export const AllocationStrip: FC<{ allocation: NodeAllocation; compact?: boolean }> = ({
  allocation,
  compact = false,
}) => {
  if (!allocation.capacity) return <CapacityUnknown allocation={allocation} />;
  return (
    <div className="flex flex-col" style={{ gap: compact ? 4 : 6 }}>
      {RESOURCE_KEYS.map((key) => (
        <MeterRow key={key} allocation={allocation} resource={key} height={compact ? 6 : 8} />
      ))}
      <StripFootnote allocation={allocation} />
    </div>
  );
};

export const StripFootnote: FC<{ allocation: NodeAllocation }> = ({ allocation }) => {
  const notes: string[] = [];
  if (hasLive(allocation)) notes.push('▎ live usage');
  if (allocation.unknownReservationCount > 0)
    notes.push(`${allocation.unknownReservationCount} reservation unknown`);
  if (notes.length === 0) return null;
  return (
    <span className="text-fg-muted" style={{ fontSize: '0.625rem', lineHeight: 1.2 }}>
      {notes.join(' · ')}
    </span>
  );
};

/** Concept B: a vertical rail that lives in the card's edge padding. */
export const RailMeter: FC<{
  allocation: NodeAllocation;
  resource: ResourceKey;
  orientation: 'vertical' | 'horizontal';
  style?: CSSProperties;
}> = ({ allocation, resource, orientation, style }) => {
  const fraction = fillFraction(allocation, resource);
  const fill = Math.min(fraction ?? 0, 1);
  const color = fraction == null ? 'var(--sam-color-border-default)' : severityColor(fraction);
  const live = allocation.live[resource];
  const vertical = orientation === 'vertical';
  return (
    <div
      role="img"
      aria-label={ariaFor(allocation, resource)}
      title={ariaFor(allocation, resource)}
      style={{
        position: 'absolute',
        background: TRACK,
        borderRadius: 999,
        overflow: 'hidden',
        ...(vertical ? { width: 5 } : { height: 5 }),
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          background: color,
          borderRadius: 999,
          ...(vertical
            ? { left: 0, right: 0, bottom: 0, height: `${fill * 100}%` }
            : { top: 0, bottom: 0, left: 0, width: `${fill * 100}%` }),
        }}
      />
      {live != null && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            background: 'var(--sam-color-fg-primary)',
            ...(vertical
              ? { left: 0, right: 0, bottom: `calc(${Math.min(live, 1) * 100}% - 1px)`, height: 2 }
              : { top: 0, bottom: 0, left: `calc(${Math.min(live, 1) * 100}% - 1px)`, width: 2 }),
          }}
        />
      )}
    </div>
  );
};

/** Concept C: one stat tile per resource, headline = what is left. */
export const StatTile: FC<{ allocation: NodeAllocation; resource: ResourceKey }> = ({
  allocation,
  resource,
}) => {
  const remaining = remainingOf(allocation, resource);
  const over = overCommitOf(allocation, resource);
  const capacity = allocation.capacity?.[resource];
  return (
    <div className="bg-inset rounded-sm min-w-0 flex flex-col" style={{ padding: '8px 10px', gap: 4 }}>
      <span className="text-fg-muted" style={{ fontSize: '0.625rem', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {RESOURCE_LABELS[resource]} free
      </span>
      <div className="flex items-baseline gap-1 min-w-0" style={{ lineHeight: 1.1 }}>
        <span
          className="text-fg-primary font-semibold"
          style={{
            fontSize: '1.125rem',
            color: over > 0 ? 'var(--sam-color-danger-fg)' : remaining === 0 ? 'var(--sam-color-warning-fg)' : undefined,
          }}
        >
          {remaining == null ? '—' : over > 0 ? `−${headlineNumber(resource, over)}` : headlineNumber(resource, remaining)}
        </span>
        <span className="sam-type-caption text-fg-muted">{unitOf(resource)}</span>
      </div>
      <span className="text-fg-muted whitespace-nowrap overflow-hidden text-ellipsis" style={{ fontSize: '0.625rem' }}>
        {capacity == null ? 'capacity unknown' : `of ${formatWithUnit(resource, capacity)}`}
      </span>
      <SegmentBar
        segments={segmentsFor(allocation, resource)}
        capacity={capacity ?? 0}
        live={allocation.live[resource]}
        height={4}
        ariaLabel={ariaFor(allocation, resource)}
      />
    </div>
  );
};

/** Concept E: three 4×16px bars in the header; severity-colored, numbers in the tooltip. */
export const HeaderGlyph: FC<{ allocation: NodeAllocation; expanded: boolean; onToggle: () => void }> = ({
  allocation,
  expanded,
  onToggle,
}) => {
  const label = allocation.capacity
    ? RESOURCE_KEYS.map((key) => ariaFor(allocation, key)).join('. ')
    : 'Capacity unknown';
  return (
    <button
      type="button"
      aria-label={`${label}. ${expanded ? 'Hide' : 'Show'} details`}
      aria-expanded={expanded}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="flex items-end shrink-0 rounded-sm"
      style={{
        gap: 3,
        height: 20,
        padding: '2px 4px',
        background: expanded ? 'var(--sam-color-bg-surface-hover)' : 'transparent',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      {RESOURCE_KEYS.map((key) => {
        const fraction = fillFraction(allocation, key);
        return (
          <span
            key={key}
            aria-hidden="true"
            style={{ position: 'relative', width: 4, height: 16, borderRadius: 999, background: TRACK, overflow: 'hidden', display: 'block' }}
          >
            <span
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: `${Math.min(fraction ?? 0, 1) * 100}%`,
                background: fraction == null ? 'var(--sam-color-border-default)' : severityColor(fraction),
                borderRadius: 999,
                display: 'block',
              }}
            />
          </span>
        );
      })}
    </button>
  );
};
