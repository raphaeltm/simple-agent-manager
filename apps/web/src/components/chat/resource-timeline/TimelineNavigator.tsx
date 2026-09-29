import { type PointerEvent, useLayoutEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';

import { type ChartTheme, useChartTheme, withAlpha } from './chart-theme';
import { formatCompactDuration, formatDayTime } from './format';
import { PLOT_LEFT_GUTTER_PX, PLOT_RIGHT_PADDING_PX } from './panels';
import { buildSeries } from './series';
import { sleeps, type TimeAxis } from './time-axis';
import type { ViewRange } from './timeline-view';
import type { ResourceAggregate } from './types';
import { useElementWidth } from './useElementWidth';
import { useUplot } from './useUplot';

const HEIGHT = 40;
/** Sleeps at least this long get their length written on the strip. */
const LABELLED_SLEEP_MS = 60 * 60_000;
/** Grips are thin to look at but wide to touch. */
const GRIP_HIT_PX = 44;

type Drag =
  | { kind: 'move'; startX: number; view: ViewRange }
  | { kind: 'min' | 'max'; view: ViewRange }
  | { kind: 'draw'; anchor: number };

interface TimelineNavigatorProps {
  axis: TimeAxis;
  overview: readonly ResourceAggregate[];
  view: ViewRange;
  sessionStart: number | null;
  sessionEnd: number | null;
  onRange: (min: number, max: number) => void;
}

function navigatorOptions(theme: ChartTheme, axisRef: { current: TimeAxis }): Omit<uPlot.Options, 'width'> {
  return {
    height: HEIGHT,
    legend: { show: false },
    cursor: { show: false },
    select: { show: false, left: 0, top: 0, width: 0, height: 0 },
    padding: [2, PLOT_RIGHT_PADDING_PX, 2, 0],
    scales: {
      x: { time: false, range: () => [axisRef.current.min, axisRef.current.max] },
      cpu: { range: (_u, _min, max) => [0, Math.max(0.5, max ?? 0) * 1.1] },
      memory: { range: (_u, _min, max) => [0, Math.max(1, max ?? 0) * 1.1] },
    },
    axes: [
      { show: false },
      { scale: 'cpu', size: PLOT_LEFT_GUTTER_PX, show: true, values: () => [], grid: { show: false }, ticks: { show: false } },
    ],
    series: [
      {},
      { scale: 'cpu', stroke: theme.cpu, width: 1, fill: withAlpha(theme.cpu, 0.22), points: { show: false } },
      { scale: 'memory', stroke: withAlpha(theme.memory, 0.8), width: 1, points: { show: false } },
    ],
    hooks: {
      drawClear: [
        (u) => {
          const { ctx, bbox } = u;
          const px = uPlot.pxRatio;
          ctx.save();
          ctx.font = `${10 * px}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          for (const sleep of sleeps(axisRef.current)) {
            const x0 = u.valToPos(sleep.axisStart, 'x', true);
            const x1 = u.valToPos(sleep.axisEnd, 'x', true);
            ctx.fillStyle = theme.sleep;
            ctx.fillRect(x0, bbox.top, Math.max(px, x1 - x0), bbox.height);
            const label = formatCompactDuration(sleep.realEnd - sleep.realStart);
            if (sleep.realEnd - sleep.realStart >= LABELLED_SLEEP_MS && x1 - x0 >= ctx.measureText(label).width + 4 * px) {
              ctx.fillStyle = theme.mutedText;
              ctx.fillText(label, (x0 + x1) / 2, bbox.top + 2 * px);
            }
          }
          ctx.restore();
        },
      ],
    },
  };
}

export function TimelineNavigator({
  axis,
  overview,
  view,
  sessionStart,
  sessionEnd,
  onRange,
}: Readonly<TimelineNavigatorProps>) {
  const theme = useChartTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const axisRef = useRef(axis);
  const trackWidth = useElementWidth(trackRef);
  const drag = useRef<Drag | null>(null);

  useLayoutEffect(() => {
    axisRef.current = axis;
  }, [axis]);

  const options = useMemo(() => navigatorOptions(theme, axisRef), [theme]);
  const data = useMemo((): uPlot.AlignedData => {
    const series = buildSeries(overview, axis, axis.min, axis.max, Math.max(1, trackWidth), 0);
    return [series.x, series.cpuMax, series.memoryMax];
  }, [overview, axis, trackWidth]);
  useUplot(containerRef, options, data);

  const span = Math.max(1, axis.max - axis.min);
  const toPx = (x: number) => ((x - axis.min) / span) * trackWidth;
  const toAxisX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return axis.min;
    return axis.min + ((clientX - rect.left) / Math.max(1, rect.width)) * span;
  };
  const left = toPx(view.min);
  const width = Math.max(2, toPx(view.max) - left);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const x = event.clientX - (trackRef.current?.getBoundingClientRect().left ?? 0);
    const nearMin = Math.abs(x - left) <= GRIP_HIT_PX / 2;
    const nearMax = Math.abs(x - (left + width)) <= GRIP_HIT_PX / 2;
    if (nearMin || nearMax) {
      // Prefer the grip the pointer is closer to when the window is narrow.
      drag.current = { kind: Math.abs(x - left) < Math.abs(x - left - width) ? 'min' : 'max', view };
    } else if (x > left && x < left + width) {
      drag.current = { kind: 'move', startX: event.clientX, view };
    } else {
      drag.current = { kind: 'draw', anchor: toAxisX(event.clientX) };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const at = toAxisX(event.clientX);
    switch (current.kind) {
      case 'move': {
        const shift = ((event.clientX - current.startX) / Math.max(1, trackWidth)) * span;
        onRange(current.view.min + shift, current.view.max + shift);
        break;
      }
      case 'min':
        onRange(Math.min(at, current.view.max - 1), current.view.max);
        break;
      case 'max':
        onRange(current.view.min, Math.max(at, current.view.min + 1));
        break;
      case 'draw':
        if (Math.abs(toPx(at) - toPx(current.anchor)) > 6) onRange(Math.min(at, current.anchor), Math.max(at, current.anchor));
        break;
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    drag.current = null;
    // A tap outside the window recentres it there.
    if (current?.kind === 'draw' && Math.abs(toPx(toAxisX(event.clientX)) - toPx(current.anchor)) <= 6) {
      const half = (view.max - view.min) / 2;
      onRange(current.anchor - half, current.anchor + half);
    }
  };

  return (
    <div className="mt-2">
      <div className="relative">
        <div ref={containerRef} aria-hidden="true" />
        {/* Pointer shortcut only: the timeline slider and range buttons offer the same moves by keyboard. */}
        <div
          ref={trackRef}
          aria-hidden="true"
          className="absolute inset-y-0 touch-none"
          style={{ left: PLOT_LEFT_GUTTER_PX, right: PLOT_RIGHT_PADDING_PX }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (drag.current = null)}
        >
          <div className="pointer-events-none absolute inset-y-0 left-0 bg-canvas/55" style={{ width: left }} />
          <div
            className="pointer-events-none absolute inset-y-0 right-0 bg-canvas/55"
            style={{ left: left + width }}
          />
          <div
            className="pointer-events-none absolute inset-y-0 rounded-sm border border-accent bg-accent/10"
            style={{ left, width }}
          >
            <span className="absolute inset-y-2 -left-[3px] w-[5px] rounded-full bg-accent" />
            <span className="absolute inset-y-2 -right-[3px] w-[5px] rounded-full bg-accent" />
          </div>
        </div>
      </div>
      {sessionStart != null && sessionEnd != null && (
        <div
          className="mt-0.5 flex justify-between text-[10px] text-fg-muted"
          style={{ paddingLeft: PLOT_LEFT_GUTTER_PX, paddingRight: PLOT_RIGHT_PADDING_PX }}
        >
          <span>{formatDayTime(sessionStart)}</span>
          <span>{formatDayTime(sessionEnd)}</span>
        </div>
      )}
    </div>
  );
}
