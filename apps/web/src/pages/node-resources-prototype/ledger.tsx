// PROTOTYPE — design exploration only. Never ships to production.
import type { FC } from 'react';

import {
  formatGb,
  formatWithUnit,
  HOST_MEMORY_RESERVE_MB,
  type NodeAllocation,
  overCommitOf,
  remainingOf,
  RESOURCE_KEYS,
  RESOURCE_LABELS,
  type ResourceKey,
  segmentColor,
} from './allocation';
import { CapacityUnknown, SegmentBar, StripFootnote } from './visualizations';

const COLUMNS = 'minmax(0,1fr) repeat(3, 56px)';

const Cell: FC<{
  allocation: NodeAllocation;
  resource: ResourceKey;
  value: number;
  color: string;
  label: string;
  valueText?: string;
  valueColor?: string;
}> = ({ allocation, resource, value, color, label, valueText, valueColor }) => (
  <div className="flex flex-col min-w-0" style={{ gap: 3 }}>
    <SegmentBar
      segments={[{ color, value, label }]}
      capacity={allocation.capacity?.[resource] ?? 0}
      height={4}
      ariaLabel={`${label}: ${formatWithUnit(resource, value)}`}
    />
    <span
      className="tabular-nums whitespace-nowrap"
      style={{ fontSize: '0.625rem', lineHeight: 1.2, color: valueColor ?? 'var(--sam-color-fg-muted)' }}
    >
      {valueText ?? formatWithUnit(resource, value)}
    </span>
  </div>
);

/** Concept D: one row per workspace, each showing its share of the node, then a Free row. */
export const Ledger: FC<{ allocation: NodeAllocation }> = ({ allocation }) => {
  if (!allocation.capacity) return <CapacityUnknown allocation={allocation} />;
  const capacity = allocation.capacity;
  return (
    <div className="flex flex-col" style={{ gap: 6 }}>
      <div className="sam-type-caption text-fg-muted" style={{ display: 'grid', gridTemplateColumns: COLUMNS, columnGap: 8 }}>
        <span>Reserved by</span>
        {RESOURCE_KEYS.map((key) => (
          <span key={key}>{RESOURCE_LABELS[key]}</span>
        ))}
      </div>
      {allocation.segments.map((segment) => (
        <div
          key={segment.workspaceId}
          style={{ display: 'grid', gridTemplateColumns: COLUMNS, columnGap: 8, alignItems: 'start' }}
        >
          <div className="flex items-center gap-2 min-w-0" style={{ paddingTop: 1 }}>
            <span
              aria-hidden="true"
              style={{ width: 8, height: 8, borderRadius: 999, background: segmentColor(segment.colorIndex), flexShrink: 0, opacity: segment.count > 1 ? 0.45 : 1 }}
            />
            <span className="sam-type-caption text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
              {segment.label}
            </span>
          </div>
          {RESOURCE_KEYS.map((key) => (
            <Cell
              key={key}
              allocation={allocation}
              resource={key}
              value={segment.amounts[key]}
              color={segmentColor(segment.colorIndex)}
              label={segment.label}
            />
          ))}
        </div>
      ))}
      <div
        className="border-t border-border-default"
        style={{ display: 'grid', gridTemplateColumns: COLUMNS, columnGap: 8, alignItems: 'start', paddingTop: 6 }}
      >
        <span className="sam-type-caption text-fg-primary font-medium" style={{ paddingTop: 1 }}>
          Free
        </span>
        {RESOURCE_KEYS.map((key) => {
          const remaining = remainingOf(allocation, key) ?? 0;
          const over = overCommitOf(allocation, key);
          return (
            <Cell
              key={key}
              allocation={allocation}
              resource={key}
              value={remaining}
              color="var(--sam-color-border-default)"
              label="Free"
              valueText={over > 0 ? `−${formatWithUnit(key, over)}` : formatWithUnit(key, remaining)}
              valueColor={over > 0 ? 'var(--sam-color-danger-fg)' : remaining === 0 ? 'var(--sam-color-warning-fg)' : 'var(--sam-color-fg-primary)'}
            />
          );
        })}
      </div>
      <span className="text-fg-muted" style={{ fontSize: '0.625rem', lineHeight: 1.3 }}>
        Capacity {formatWithUnit('cpu', capacity.cpu)} · {formatGb(capacity.memory)} · {formatGb(capacity.disk)} disk
        {' '}(after {formatGb(HOST_MEMORY_RESERVE_MB)} host reserve)
      </span>
      <StripFootnote allocation={allocation} />
    </div>
  );
};
