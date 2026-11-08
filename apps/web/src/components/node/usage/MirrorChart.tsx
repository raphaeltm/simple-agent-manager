import type { NodeResourceUsageSeries } from '@simple-agent-manager/shared';
import { memo, useMemo } from 'react';

/**
 * Memory and CPU on one time axis: memory rises above the centre line, CPU hangs below
 * it, each scaled to its own maximum and each with a dashed line at what was set aside.
 * Memory is green and CPU is blue; position says which is which without colour.
 *
 * Buckets are placed by timestamp across the window, so the minutes history has not
 * reached yet stay empty at the right. A live memory reading, when there is one, is a
 * dot on the right edge (HTML, so the stretched SVG cannot squash it into an ellipse).
 */
export const MEMORY_COLOR = 'var(--sam-status-success-fg)';
export const MEMORY_FILL = 'var(--sam-color-accent-primary)';
export const CPU_COLOR = 'var(--sam-status-info-fg)';
export const DANGER_COLOR = 'var(--sam-status-danger-fg)';

/** Each half leaves a little headroom so a full machine still shows its edge. */
const HALF = 47;

interface Point {
  x: number;
  y: number;
}

function yFor(value: number, max: number, up: boolean): number {
  const h = (Math.min(Math.max(value, 0), max) / max) * HALF;
  return up ? 50 - h : 50 + h;
}

/**
 * Contiguous runs of buckets with a value, so a gap in history draws as a gap. The API omits
 * minutes with no samples, so a run also ends where consecutive buckets are more than one
 * bucket apart (half a bucket of slack absorbs timer jitter).
 */
function runs(
  series: NodeResourceUsageSeries,
  values: Array<number | null>,
  xFor: (start: number) => number,
  bucketMs: number,
  max: number,
  up: boolean
): Point[][] {
  const result: Point[][] = [];
  let current: Point[] = [];
  let previousStart: number | null = null;
  series.start.forEach((start, i) => {
    const value = values[i];
    const gap = previousStart !== null && start - previousStart > bucketMs * 1.5;
    previousStart = start;
    if (value == null || gap) {
      if (current.length > 0) result.push(current);
      current = [];
    }
    if (value == null) return;
    current.push({ x: xFor(start), y: yFor(value, max, up) });
  });
  if (current.length > 0) result.push(current);
  return result;
}

function Half({
  points,
  stroke,
  fill,
  fillOpacity,
}: {
  points: Point[];
  stroke: string;
  fill: string;
  fillOpacity: number;
}) {
  const line = points.map((p) => `${p.x},${p.y}`).join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  return (
    <>
      <polygon
        points={`${first.x},50 ${line} ${last.x},50`}
        fill={fill}
        fillOpacity={fillOpacity}
      />
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </>
  );
}

function Dashed({ y }: { y: number }) {
  return (
    <line
      x1="0"
      x2="100"
      y1={y}
      y2={y}
      stroke="var(--sam-color-fg-muted)"
      strokeDasharray="4 3"
      strokeWidth={1}
      vectorEffect="non-scaling-stroke"
    />
  );
}

export interface MirrorChartProps {
  series: NodeResourceUsageSeries;
  windowStart: number;
  windowEnd: number;
  bucketMs: number;
  memoryMax: number;
  cpuMax: number;
  memoryReserved: number | null;
  cpuReserved: number | null;
  memoryDanger?: boolean;
  liveMemory?: number | null;
  className: string;
}

/**
 * Memoized: the page re-renders on every poll and clock tick, and these props are
 * primitives plus a series array that keeps its identity until new history arrives.
 */
export const MirrorChart = memo(function MirrorChart({
  series,
  windowStart,
  windowEnd,
  bucketMs,
  memoryMax,
  cpuMax,
  memoryReserved,
  cpuReserved,
  memoryDanger = false,
  liveMemory = null,
  className,
}: MirrorChartProps) {
  const memoryStroke = memoryDanger ? DANGER_COLOR : MEMORY_COLOR;
  const safeMemoryMax = memoryMax > 0 ? memoryMax : 1;
  const safeCpuMax = cpuMax > 0 ? cpuMax : 1;
  const { memoryRuns, cpuRuns } = useMemo(() => {
    const span = Math.max(1, windowEnd - windowStart);
    const xFor = (start: number) =>
      Math.min(100, Math.max(0, ((start + bucketMs / 2 - windowStart) / span) * 100));
    return {
      memoryRuns: runs(series, series.memoryBytes, xFor, bucketMs, safeMemoryMax, true),
      cpuRuns: runs(series, series.cpuMillis, xFor, bucketMs, safeCpuMax, false),
    };
  }, [series, windowStart, windowEnd, bucketMs, safeMemoryMax, safeCpuMax]);
  return (
    <div className={`relative ${className}`}>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        {memoryRuns.map((points, i) => (
          <Half
            key={`m${i}`}
            points={points}
            stroke={memoryStroke}
            fill={memoryDanger ? DANGER_COLOR : MEMORY_FILL}
            fillOpacity={0.4}
          />
        ))}
        {cpuRuns.map((points, i) => (
          <Half
            key={`c${i}`}
            points={points}
            stroke={CPU_COLOR}
            fill={CPU_COLOR}
            fillOpacity={0.28}
          />
        ))}
        <line
          x1="0"
          x2="100"
          y1="50"
          y2="50"
          stroke="var(--sam-chip-edge)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {memoryReserved != null && <Dashed y={yFor(memoryReserved, safeMemoryMax, true)} />}
        {cpuReserved != null && <Dashed y={yFor(cpuReserved, safeCpuMax, false)} />}
      </svg>
      {liveMemory != null && (
        <span
          aria-hidden="true"
          data-testid="live-memory-dot"
          className="absolute right-1 h-2 w-2 -translate-y-1/2 rounded-full shadow-[0_0_0_2px_var(--sam-separator)]"
          style={{
            top: `${yFor(liveMemory, safeMemoryMax, true)}%`,
            background: memoryStroke,
          }}
        />
      )}
    </div>
  );
});

export function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: color }}
    />
  );
}
