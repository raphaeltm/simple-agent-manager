/**
 * uPlot configuration for the stacked timeline panels.
 *
 * Every panel shares one x scale (axis milliseconds, see `time-axis.ts`) and one
 * cursor sync group, so a crosshair or zoom in one is a crosshair or zoom in all.
 * Draw hooks read `PanelState` through a ref: data and view changes redraw the
 * existing canvas instead of rebuilding it.
 */

import type { RefObject } from 'react';
import uPlot from 'uplot';

import { type ChartTheme, withAlpha } from './chart-theme';
import { formatBytes, formatClock, formatCoresAxis, formatElapsed, formatRate } from './format';
import type { TimelineSeries } from './series';
import { axisTicks, sleeps, tickStepMs, type TimeAxis, toAxis, toReal } from './time-axis';
import type { ResourceReservation, ResourceToolSpan } from './types';

export type PanelKind = 'cpu' | 'memory' | 'disk' | 'tools';

export interface PanelState {
  axis: TimeAxis;
  viewMin: number;
  viewMax: number;
  series: TimelineSeries;
  reservation: ResourceReservation | null;
  toolSpans: readonly ResourceToolSpan[];
  /** Whether the agent reports working-set memory (otherwise memory includes cache). */
  hasWorkingSet: boolean;
}

export interface PanelCallbacks {
  /**
   * uPlot moved its cursor: the axis position under it, or null when it left the
   * plot. uPlot also fires this on redraws with the old pixel position, so the
   * receiver must only trust it while a mouse is actually hovering.
   */
  onHover: (x: number | null) => void;
  /** A mouse drag selected `[min, max]` (axis units). */
  onSelectRange: (min: number, max: number) => void;
  onResetZoom: () => void;
}

/** Left gutter (y-axis labels) and right padding shared by every panel and the navigator. */
export const PLOT_LEFT_GUTTER_PX = 44;
export const PLOT_RIGHT_PADDING_PX = 6;
/** Clock labels ("09:55 PM") need about this much room each… */
const TICK_MIN_SPACING_PX = 58;
/** …and half of it to the right of their tick, which the right edge cannot give. */
const TICK_RIGHT_EDGE_CLEARANCE_PX = 22;
const TOOL_LANE_ROWS = 3;

function px(value: number): number {
  return Math.round(value * uPlot.pxRatio);
}

/** Canvas x (device pixels) for an axis position. */
function canvasX(u: uPlot, x: number): number {
  return u.valToPos(x, 'x', true);
}

const hatchCache = new WeakMap<uPlot, CanvasPattern | null>();

function hatchPattern(u: uPlot, color: string): CanvasPattern | null {
  if (hatchCache.has(u)) return hatchCache.get(u) ?? null;
  const size = px(6);
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const ctx = tile.getContext('2d');
  if (ctx) {
    ctx.strokeStyle = color;
    ctx.lineWidth = px(1);
    ctx.beginPath();
    ctx.moveTo(0, size);
    ctx.lineTo(size, 0);
    ctx.stroke();
  }
  const pattern = u.ctx.createPattern(tile, 'repeat');
  hatchCache.set(u, pattern);
  return pattern;
}

/** Hatches every sleep inside the view; the tool lane also labels how long it lasted. */
function drawSleeps(u: uPlot, state: PanelState, theme: ChartTheme, label: boolean) {
  const { ctx, bbox } = u;
  for (const sleep of sleeps(state.axis)) {
    if (sleep.axisEnd <= state.viewMin || sleep.axisStart >= state.viewMax) continue;
    const x0 = Math.max(bbox.left, canvasX(u, sleep.axisStart));
    const x1 = Math.min(bbox.left + bbox.width, canvasX(u, sleep.axisEnd));
    if (x1 - x0 < 1) continue;
    ctx.save();
    ctx.fillStyle = theme.sleep;
    ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height);
    ctx.fillStyle = hatchPattern(u, theme.sleep) ?? theme.sleep;
    ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height);
    if (label && x1 - x0 > px(40)) {
      ctx.fillStyle = theme.mutedText;
      ctx.font = `${px(10)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`asleep ${formatElapsed(sleep.realEnd - sleep.realStart)}`, (x0 + x1) / 2, bbox.top + bbox.height / 2);
    }
    ctx.restore();
  }
}

function drawReservation(u: uPlot, value: number | null, theme: ChartTheme, label: string) {
  if (value == null) return;
  const y = u.valToPos(value, 'y', true);
  const { ctx, bbox } = u;
  if (y < bbox.top || y > bbox.top + bbox.height) return;
  ctx.save();
  ctx.strokeStyle = theme.reservation;
  ctx.lineWidth = px(1);
  ctx.setLineDash([px(4), px(3)]);
  ctx.beginPath();
  ctx.moveTo(bbox.left, y);
  ctx.lineTo(bbox.left + bbox.width, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = theme.mutedText;
  ctx.font = `${px(10)}px system-ui, sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, bbox.left + bbox.width - px(4), y - px(2));
  ctx.restore();
}

function drawOomMarkers(u: uPlot, state: PanelState, theme: ChartTheme) {
  const { ctx, bbox } = u;
  state.series.oomKills.forEach((kills, index) => {
    if (kills <= 0) return;
    const x = canvasX(u, state.series.x[index] ?? 0);
    ctx.save();
    ctx.strokeStyle = theme.danger;
    ctx.lineWidth = px(1.5);
    ctx.setLineDash([px(3), px(2)]);
    ctx.beginPath();
    ctx.moveTo(x, bbox.top);
    ctx.lineTo(x, bbox.top + bbox.height);
    ctx.stroke();
    ctx.fillStyle = theme.danger;
    ctx.font = `bold ${px(10)}px system-ui, sans-serif`;
    ctx.textAlign = x > bbox.left + bbox.width - px(40) ? 'right' : 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(' OOM kill ', x, bbox.top + px(1));
    ctx.restore();
  });
}

/** Greedy interval packing so concurrent tool calls stack instead of hiding each other. */
function laneRows(spans: readonly ResourceToolSpan[]): number[] {
  const rowEnds: number[] = [];
  return spans.map((span) => {
    const row = rowEnds.findIndex((end) => end <= span.startedAt);
    const target = row === -1 ? Math.min(rowEnds.length, TOOL_LANE_ROWS - 1) : row;
    rowEnds[target] = Math.max(rowEnds[target] ?? 0, span.endedAt);
    return target;
  });
}

function drawToolLane(u: uPlot, state: PanelState, theme: ChartTheme) {
  const { ctx, bbox } = u;
  const rowHeight = bbox.height / TOOL_LANE_ROWS;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();

  // Where only the overview is loaded, show how busy each bucket was.
  const { series } = state;
  const densest = Math.max(1, ...series.toolStarts);
  series.toolStarts.forEach((count, index) => {
    if (count <= 0 || series.exact[index]) return;
    const x = canvasX(u, (series.x[index] ?? 0) - series.bucketMs / 2);
    const width = Math.max(px(1), canvasX(u, (series.x[index] ?? 0) + series.bucketMs / 2) - x);
    ctx.globalAlpha = 0.2 + 0.8 * Math.sqrt(count / densest);
    ctx.fillStyle = theme.tools.other;
    ctx.fillRect(x, bbox.top + rowHeight * 0.5, width, bbox.height - rowHeight);
  });
  ctx.globalAlpha = 1;

  const sorted = [...state.toolSpans].sort((a, b) => a.startedAt - b.startedAt);
  const rows = laneRows(sorted);
  sorted.forEach((span, index) => {
    const x0 = canvasX(u, toAxis(state.axis, span.startedAt));
    const x1 = canvasX(u, toAxis(state.axis, span.endedAt));
    if (x1 < bbox.left || x0 > bbox.left + bbox.width) return;
    const row = rows[index] ?? 0;
    ctx.fillStyle = theme.tools[span.kind];
    ctx.globalAlpha = span.approximateEnd ? 0.5 : 0.9;
    ctx.fillRect(x0, bbox.top + row * rowHeight + px(1), Math.max(px(2), x1 - x0), rowHeight - px(2));
  });
  ctx.restore();
  drawSleeps(u, state, theme, true);
}

function xAxis(stateRef: RefObject<PanelState>, theme: ChartTheme, showLabels: boolean): uPlot.Axis {
  let stepMs = 60_000;
  return {
    scale: 'x',
    show: true,
    size: showLabels ? 22 : 0,
    stroke: theme.mutedText,
    font: '10px system-ui, sans-serif',
    ticks: { show: false },
    grid: { stroke: theme.grid, width: 1 },
    splits: (u, _axisIdx, min, max) => {
      const state = stateRef.current;
      const widthPx = u.bbox.width / uPlot.pxRatio;
      stepMs = tickStepMs((max - min) / Math.max(1, widthPx), TICK_MIN_SPACING_PX);
      return axisTicks(state.axis, min, max, stepMs).map((tick) => tick.x);
    },
    values: (u, splits) => {
      const widthPx = u.bbox.width / uPlot.pxRatio;
      return splits.map((x) =>
        showLabels && u.valToPos(x, 'x') <= widthPx - TICK_RIGHT_EDGE_CLEARANCE_PX
          ? formatClock(toReal(stateRef.current.axis, x), stepMs)
          : ''
      );
    },
  };
}

function yAxis(theme: ChartTheme, format: (value: number) => string): uPlot.Axis {
  return {
    scale: 'y',
    size: PLOT_LEFT_GUTTER_PX,
    stroke: theme.mutedText,
    font: '10px system-ui, sans-serif',
    space: 24,
    ticks: { show: false },
    grid: { stroke: theme.grid, width: 1 },
    values: (_u, splits) => splits.map(format),
  };
}

function peak(values: ReadonlyArray<number | null>): number {
  return values.reduce<number>((max, value) => (value != null && value > max ? value : max), 0);
}

function commonOptions(
  kind: PanelKind,
  height: number,
  syncKey: string,
  stateRef: RefObject<PanelState>,
  callbacks: RefObject<PanelCallbacks>
): Pick<uPlot.Options, 'height' | 'legend' | 'padding' | 'cursor' | 'select' | 'scales'> & { hooks: uPlot.Hooks.Arrays } {
  return {
    height,
    legend: { show: false },
    padding: [kind === 'tools' ? 2 : 8, PLOT_RIGHT_PADDING_PX, 0, 0],
    select: { show: true, left: 0, top: 0, width: 0, height: 0 },
    cursor: {
      y: false,
      points: { show: false },
      sync: { key: syncKey, setSeries: false },
      drag: { x: true, y: false, setScale: false },
      bind: {
        dblclick: () => () => {
          callbacks.current.onResetZoom();
          return null;
        },
      },
    },
    scales: {
      x: { time: false, range: () => [stateRef.current.viewMin, stateRef.current.viewMax] },
    },
    hooks: {
      setSelect: [
        (u) => {
          if (u.select.width > 4) {
            const min = u.posToVal(u.select.left, 'x');
            const max = u.posToVal(u.select.left + u.select.width, 'x');
            callbacks.current.onSelectRange(min, max);
          }
          u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
        },
      ],
    },
  };
}

export function panelOptions(
  kind: PanelKind,
  theme: ChartTheme,
  height: number,
  syncKey: string,
  stateRef: RefObject<PanelState>,
  callbacks: RefObject<PanelCallbacks>
): Omit<uPlot.Options, 'width'> {
  const base = commonOptions(kind, height, syncKey, stateRef, callbacks);
  const drawClear: uPlot.Hooks.Arrays['drawClear'] =
    kind === 'tools' ? [] : [(u) => drawSleeps(u, stateRef.current, theme, false)];
  const hooks: uPlot.Hooks.Arrays = { ...base.hooks, drawClear };

  switch (kind) {
    case 'cpu':
      return {
        ...base,
        hooks: {
          ...hooks,
          setCursor: [
            (u) => {
              const left = u.cursor.left ?? -1;
              callbacks.current.onHover(left >= 0 ? u.posToVal(left, 'x') : null);
            },
          ],
          draw: [
            (u) => {
              const cores = stateRef.current.reservation?.cpuCores ?? null;
              drawReservation(u, cores, theme, cores == null ? '' : `reserved ${formatCoresAxis(cores)}`);
            },
          ],
        },
        scales: {
          ...base.scales,
          y: {
            range: () => {
              const state = stateRef.current;
              const top = Math.max(0.5, peak(state.series.cpuMax), state.reservation?.cpuCores ?? 0);
              return [0, top * 1.12];
            },
          },
        },
        axes: [xAxis(stateRef, theme, false), yAxis(theme, formatCoresAxis)],
        series: [
          {},
          { stroke: 'transparent', points: { show: false } },
          { stroke: theme.cpu, width: 1.5, fill: withAlpha(theme.cpu, 0.15), points: { show: false } },
        ],
        bands: [{ series: [1, 2], fill: withAlpha(theme.cpu, 0.25) }],
      };
    case 'memory':
      return {
        ...base,
        hooks: {
          ...hooks,
          draw: [
            (u) => {
              const state = stateRef.current;
              const bytes = state.reservation?.memoryBytes ?? null;
              drawReservation(u, bytes, theme, bytes == null ? '' : `reserved ${formatBytes(bytes)}`);
              drawOomMarkers(u, state, theme);
            },
          ],
        },
        scales: {
          ...base.scales,
          y: {
            range: () => {
              const state = stateRef.current;
              const top = Math.max(
                256 * 1024 ** 2,
                peak(state.series.memoryMax),
                state.reservation?.memoryBytes ?? 0
              );
              return [0, top * 1.1];
            },
          },
        },
        axes: [xAxis(stateRef, theme, false), yAxis(theme, (value) => formatBytes(value).replace(' ', ''))],
        series: [
          {},
          { stroke: theme.memory, width: 1, dash: [3, 3], points: { show: false } },
          { stroke: 'transparent', points: { show: false } },
          { stroke: theme.memory, width: 1.5, fill: withAlpha(theme.memory, 0.18), points: { show: false } },
        ],
        bands: [{ series: [2, 3], fill: withAlpha(theme.memory, 0.3) }],
      };
    case 'disk':
      return {
        ...base,
        hooks,
        scales: {
          ...base.scales,
          y: {
            range: () => {
              const { series } = stateRef.current;
              const write = Math.max(1024 ** 2, peak(series.ioWriteRate));
              const read = Math.max(1024 ** 2, peak(series.ioReadRate));
              return [-read * 1.1, write * 1.1];
            },
          },
        },
        axes: [
          xAxis(stateRef, theme, false),
          yAxis(theme, (value) => (value === 0 ? '0' : formatRate(Math.abs(value)).replace(' ', ''))),
        ],
        series: [
          {},
          { stroke: theme.ioWrite, width: 1.25, fill: withAlpha(theme.ioWrite, 0.2), points: { show: false } },
          { stroke: theme.ioRead, width: 1.25, fill: withAlpha(theme.ioRead, 0.2), points: { show: false } },
        ],
      };
    case 'tools':
      return {
        ...base,
        hooks: { ...hooks, draw: [(u) => drawToolLane(u, stateRef.current, theme)] },
        scales: { ...base.scales, y: { range: () => [0, 1] } },
        axes: [xAxis(stateRef, theme, true), { scale: 'y', size: PLOT_LEFT_GUTTER_PX, show: true, values: () => [], grid: { show: false }, ticks: { show: false } }],
        series: [{}],
      };
  }
}

/** Column-major data for a panel, in the series order `panelOptions` declares. */
export function panelData(kind: PanelKind, state: PanelState): uPlot.AlignedData {
  const { series, hasWorkingSet } = state;
  switch (kind) {
    case 'cpu':
      return [series.x, series.cpuMax, series.cpuMean];
    case 'memory': {
      // Working set is what the session needed; without it, memory.current stands in.
      const primaryMean = hasWorkingSet ? series.workingSetMean : series.memoryMean;
      const primaryMax = hasWorkingSet ? series.workingSetMax : series.memoryMax;
      const withCache = hasWorkingSet ? series.memoryMean : series.x.map(() => null);
      return [series.x, withCache, primaryMax, primaryMean];
    }
    case 'disk':
      return [series.x, series.ioWriteRate, series.ioReadRate.map((value) => (value == null ? null : -value))];
    case 'tools':
      return [series.x];
  }
}
