/**
 * The receipt's CPU line, drawn from the per-minute rollups the session Resources timeline
 * already loads (`useResourceTimelineIndex`, same query cache), on the run's own time axis. Each
 * minute in which tool calls started gets a marker, so the peaks can be read against the work
 * behind them. Plain SVG for the line; the markers are HTML so they stay round however wide the
 * panel stretches the chart.
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
  from,
  to,
}: Readonly<{ points: CpuPoint[]; reservedCores: number | null; from: number; to: number }>) {
  const first = points[0];
  if (!first || points.length < 2) return null;
  const span = Math.max(1, to - from);
  const peak = points.reduce((max, point) => Math.max(max, point.cores), 0);
  const top = Math.max(peak, reservedCores ?? 0, 0.1);
  const xPct = (t: number) => Math.min(100, Math.max(0, ((t - from) / span) * 100));
  const yOf = (cores: number) => HEIGHT - PAD_Y - (cores / top) * (HEIGHT - 2 * PAD_Y);
  const path = points
    .map(
      (point, i) =>
        `${i === 0 ? 'M' : 'L'}${((xPct(point.t) / 100) * WIDTH).toFixed(1)},${yOf(point.cores).toFixed(1)}`
    )
    .join(' ');
  const withTools = points.filter((point) => point.toolCalls > 0);
  const minutes = Math.round(span / 60_000);
  const reservedY = reservedCores !== null && reservedCores <= top ? yOf(reservedCores) : null;

  return (
    <figure className="m-0">
      <div className="relative h-24 w-full">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="absolute inset-0 block h-full w-full overflow-visible"
          role="img"
          aria-label={`CPU over ${minutes} minutes, peaking at ${peak.toFixed(1)} cores${reservedCores !== null ? ` of ${reservedCores.toFixed(1)} requested` : ''}. Tool calls started in ${withTools.length} of ${points.length} minutes.`}
          data-testid="receipt-cpu-line"
        >
          {reservedY !== null && (
            <line
              x1={0}
              x2={WIDTH}
              y1={reservedY}
              y2={reservedY}
              stroke="var(--sam-color-border-default)"
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <path
            d={`${path} L${((xPct(points.at(-1)?.t ?? to) / 100) * WIDTH).toFixed(1)},${HEIGHT} L${((xPct(first.t) / 100) * WIDTH).toFixed(1)},${HEIGHT} Z`}
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
        </svg>
        {withTools.map((point) => (
          <span
            key={point.t}
            aria-hidden="true"
            data-testid="receipt-cpu-marker"
            className="absolute h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--sam-color-info)]"
            style={{ left: `${xPct(point.t)}%`, top: `${(yOf(point.cores) / HEIGHT) * 100}%` }}
          />
        ))}
        {reservedY !== null && (
          <span
            aria-hidden="true"
            className="absolute right-0 -translate-y-full pb-0.5 text-[10px] leading-none text-fg-muted"
            style={{ top: `${(reservedY / HEIGHT) * 100}%` }}
          >
            requested
          </span>
        )}
      </div>
      <figcaption className="mt-1.5 text-[length:var(--sam-type-caption-size)] text-fg-muted">
        <span className="flex justify-between">
          <span>0 min</span>
          <span>
            Peak {peak.toFixed(1)} cores
            {reservedCores !== null ? ` of ${reservedCores.toFixed(1)} requested` : ''}
          </span>
          <span>{minutes} min</span>
        </span>
        <span className="mt-1 flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-[7px] w-[7px] rounded-full bg-[var(--sam-color-info)]"
          />
          A minute in which the agent started tool calls
        </span>
      </figcaption>
    </figure>
  );
}
