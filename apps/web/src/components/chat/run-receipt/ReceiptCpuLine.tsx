/**
 * The receipt's CPU line, drawn from the per-minute rollups the session Resources timeline
 * already loads (`useResourceTimelineIndex`, same query cache), clipped to the run. Each minute
 * in which tool calls started gets a marker, so the peaks can be read against the work behind
 * them. Plain SVG: a static line needs no canvas chart library.
 */
import type { ResourceAggregate, ResourceTimelineIndex } from '../resource-timeline/types';

const WIDTH = 320;
const HEIGHT = 96;
const PAD_Y = 6;

export interface CpuPoint {
  t: number;
  cores: number;
  toolCalls: number;
}

/** Minute buckets inside [from, to], oldest first. */
export function cpuPointsForRun(
  index: ResourceTimelineIndex | undefined,
  from: number,
  to: number
): CpuPoint[] {
  if (!index) return [];
  const points: CpuPoint[] = [];
  for (const chunk of index.chunks) {
    if (chunk.endedAt < from || chunk.startedAt > to) continue;
    for (const aggregate of chunk.overview as ResourceAggregate[]) {
      if (aggregate.end < from || aggregate.start > to || aggregate.cpuMaxCores === null) continue;
      points.push({
        t: aggregate.start,
        cores: aggregate.cpuMaxCores,
        toolCalls: aggregate.toolCallStarts,
      });
    }
  }
  return points.sort((a, b) => a.t - b.t);
}

export function ReceiptCpuLine({
  points,
  reservedCores,
}: Readonly<{ points: CpuPoint[]; reservedCores: number | null }>) {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length < 2) return null;
  const span = Math.max(1, last.t - first.t);
  const peak = points.reduce((max, point) => Math.max(max, point.cores), 0);
  const top = Math.max(peak, reservedCores ?? 0, 0.1);
  const x = (t: number) => ((t - first.t) / span) * WIDTH;
  const y = (cores: number) => HEIGHT - PAD_Y - (cores / top) * (HEIGHT - 2 * PAD_Y);
  const path = points
    .map(
      (point, i) => `${i === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(point.cores).toFixed(1)}`
    )
    .join(' ');
  const withTools = points.filter((point) => point.toolCalls > 0);
  const peakPoint = points.reduce(
    (best, point) => (point.cores > best.cores ? point : best),
    first
  );
  const minutes = Math.round(span / 60_000);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="block h-24 w-full overflow-visible"
        role="img"
        aria-label={`CPU over ${minutes} minutes, peaking at ${peak.toFixed(1)} cores. Tool calls started in ${withTools.length} of ${points.length} minutes.`}
        data-testid="receipt-cpu-line"
      >
        {reservedCores !== null && reservedCores <= top && (
          <line
            x1={0}
            x2={WIDTH}
            y1={y(reservedCores)}
            y2={y(reservedCores)}
            stroke="var(--sam-color-border-default)"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path
          d={`${path} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`}
          fill="var(--sam-color-success)"
          fillOpacity={0.12}
          stroke="none"
        />
        <path
          d={path}
          fill="none"
          stroke="var(--sam-color-success)"
          strokeWidth={1.75}
          vectorEffect="non-scaling-stroke"
        />
        {withTools.map((point) => (
          <circle
            key={point.t}
            cx={x(point.t)}
            cy={y(point.cores)}
            r={point === peakPoint ? 3.5 : 2.25}
            fill="var(--sam-color-info)"
          >
            <title>{`${point.toolCalls} tool call${point.toolCalls === 1 ? '' : 's'} started`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="mt-1 flex justify-between text-[length:var(--sam-type-caption-size)] text-fg-muted">
        <span>0 min</span>
        <span>
          Peak {peak.toFixed(1)} cores
          {reservedCores !== null ? ` of ${reservedCores.toFixed(1)} requested` : ''}
        </span>
        <span>{minutes} min</span>
      </figcaption>
    </figure>
  );
}
