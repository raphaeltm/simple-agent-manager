import type { CSSProperties, FC } from 'react';

import { clampPercent, GAP, TRACK } from './viz-tokens';

export interface RailSegment {
  id: string;
  /** Share of the rail, 0–100. */
  percent: number;
  color: string;
  title: string;
}

/**
 * A segmented part-to-whole track.
 *
 * The 2px separation between fills is real air in the surface colour (flex `gap`),
 * not a stroke drawn around each mark. Because a raw `gap` would push the total
 * fill past its true share, every segment after the first is width
 * `max(3px, calc(P% - 2px))`, so `ΣP% - (n-1)·2px + (n-1)·2px gap` lands back on
 * exactly `ΣP%` for every segment above the floor.
 *
 * The 3px floor exists because a sub-1% tenant otherwise renders as a 1px hairline
 * that reads as a divider rather than as data (the cx53's disk rail has three
 * tenants at 0.56% each). It over-draws those segments by a pixel or two; the
 * numeric readout beside the rail, not the rail, is the authoritative value.
 */
export const RailTrack: FC<{
  segments: RailSegment[];
  height: number;
  ariaLabel: string;
  ariaValue?: number;
  /** Optional marker at a percentage, e.g. a threshold or a measured peak. */
  marker?: { percent: number; color: string; label: string } | null;
  style?: CSSProperties;
}> = ({ segments, height, ariaLabel, ariaValue, marker = null, style }) => (
  <div
    className="relative flex-1 min-w-0 rounded-full overflow-hidden flex"
    style={{ height, backgroundColor: TRACK, gap: 2, ...style }}
    role="meter"
    aria-valuenow={ariaValue === undefined ? undefined : Math.round(ariaValue)}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-label={ariaLabel}
  >
    {segments.map((segment, index) => (
      <span
        key={segment.id}
        title={segment.title}
        style={{
          flex: '0 0 auto',
          width:
            index === 0
              ? `max(3px, ${clampPercent(segment.percent)}%)`
              : `max(3px, calc(${clampPercent(segment.percent)}% - 2px))`,
          backgroundColor: segment.color,
        }}
      />
    ))}
    {marker && (
      <span
        aria-label={marker.label}
        title={marker.label}
        style={{
          position: 'absolute',
          left: `${clampPercent(marker.percent)}%`,
          top: 0,
          bottom: 0,
          width: 2,
          marginLeft: -1,
          backgroundColor: marker.color,
          // A 1px surface halo keeps the tick legible where it lands on a fill.
          boxShadow: `0 0 0 1px ${GAP}`,
        }}
      />
    )}
  </div>
);
