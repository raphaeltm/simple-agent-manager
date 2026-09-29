/**
 * What the readout says for a cursor position or, without a cursor, for the
 * visible range. Every value is labelled with what it is: a single 5-second
 * measurement, or an average/peak over a wider window.
 */

import {
  formatBytes,
  formatClock,
  formatCores,
  formatElapsed,
  formatRange,
  formatRate,
  formatToolName,
} from './format';
import { summarizeUsage, type TimelineSeries } from './series';
import { activeMsInView, sleepAt, type TimeAxis, toReal } from './time-axis';
import type { ResourceAggregate, ResourceRun, ResourceToolSpan } from './types';

export interface Readout {
  /** Whether this describes one instant under the cursor or the whole visible range. */
  mode: 'cursor' | 'range';
  time: string;
  context: string;
  cpu: string;
  memory: string;
  disk: string;
  tools: string;
  /** Out-of-memory kills in scope, called out separately because they are the one causal event. */
  oomKills: number;
}

const DASH = '—';

/** Index of the bucket whose centre is nearest to `x`. */
export function nearestBucket(series: TimelineSeries, x: number): number {
  let lo = 0;
  let hi = series.x.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((series.x[mid] ?? 0) < x) lo = mid + 1;
    else hi = mid;
  }
  const previous = lo - 1;
  if (previous >= 0 && Math.abs((series.x[previous] ?? 0) - x) <= Math.abs((series.x[lo] ?? 0) - x)) {
    return previous;
  }
  return lo;
}

function runLabel(runs: readonly ResourceRun[], t: number): string {
  const index = runs.findIndex((run) => t >= run.startedAt && t <= run.endedAt);
  const run = runs[index];
  if (!run) return 'No workspace running';
  const node = run.nodeId ? ` · ${run.nodeId}` : '';
  const problem = run.unsupportedReason ? ' · not observed' : '';
  return runs.length > 1 ? `Run ${index + 1} of ${runs.length}${node}${problem}` : `Workspace${node}${problem}`;
}

/** Kept short enough to sit beside the panel's title and legend on a phone. */
function memoryText(used: number | null, total: number | null): string {
  if (used == null) return total == null ? DASH : `${formatBytes(total)} incl. cache`;
  const cache = total == null ? null : Math.max(0, total - used);
  return cache == null ? `${formatBytes(used)} used` : `${formatBytes(used)} + ${formatBytes(cache)} cache`;
}

function activeToolsText(spans: readonly ResourceToolSpan[], from: number, to: number, instant: number): string | null {
  const running = spans.filter((span) => span.startedAt <= instant && span.endedAt >= instant);
  const inWindow = running.length ? running : spans.filter((span) => span.startedAt < to && span.endedAt > from);
  if (inWindow.length === 0) return null;
  const longest = [...inWindow].sort((a, b) => b.endedAt - b.startedAt - (a.endedAt - a.startedAt))[0];
  if (!longest) return null;
  const label = formatToolName(longest.name);
  const more = inWindow.length > 1 ? ` +${inWindow.length - 1} more` : '';
  const verb = running.length ? 'running' : 'ran';
  return `${label} ${verb} ${formatElapsed(longest.endedAt - longest.startedAt)}${more}`;
}

export function readoutAtCursor(
  x: number,
  series: TimelineSeries,
  axis: TimeAxis,
  runs: readonly ResourceRun[],
  toolSpans: readonly ResourceToolSpan[],
  sampleIntervalMs: number
): Readout {
  const sleep = sleepAt(axis, x);
  const t = toReal(axis, x);
  if (sleep) {
    return {
      mode: 'cursor',
      time: formatClock(t, 60_000),
      context: `Session asleep for ${formatElapsed(sleep.realEnd - sleep.realStart)} — no workspace was running`,
      cpu: DASH,
      memory: DASH,
      disk: DASH,
      tools: DASH,
      oomKills: 0,
    };
  }
  const i = nearestBucket(series, x);
  const measured = series.exact[i] === true && series.bucketMs <= sampleIntervalMs * 1.5;
  const from = toReal(axis, (series.x[i] ?? x) - series.bucketMs / 2);
  const to = toReal(axis, (series.x[i] ?? x) + series.bucketMs / 2);
  const cpuMean = series.cpuMean[i] ?? null;
  const cpuMax = series.cpuMax[i] ?? null;
  const used = series.workingSetMean[i] ?? null;
  const total = series.memoryMean[i] ?? null;
  const write = series.ioWriteRate[i] ?? null;
  const read = series.ioReadRate[i] ?? null;
  const overview = Math.round(series.toolStarts[i] ?? 0);

  return {
    mode: 'cursor',
    // The instant under the cursor stays put while zooming; the averaging window says how wide the reading is.
    time: measured ? formatClock(t, 1_000) : `${formatClock(t, series.bucketMs)} · ${formatElapsed(to - from)} avg`,
    context: runLabel(runs, t),
    cpu: measured || cpuMax == null ? formatCores(cpuMean) : `${formatCores(cpuMean)} · peak ${formatCores(cpuMax)}`,
    memory: memoryText(used, total),
    disk: write == null && read == null ? DASH : `↑ ${formatRate(write)} write · ↓ ${formatRate(read)} read`,
    tools:
      activeToolsText(toolSpans, from, to, t) ??
      (overview > 0 ? `~${overview} call${overview === 1 ? '' : 's'} in this window` : 'No tool calls'),
    oomKills: series.oomKills[i] ?? 0,
  };
}

export function readoutForRange(
  viewMin: number,
  viewMax: number,
  axis: TimeAxis,
  aggregates: readonly ResourceAggregate[],
  /** Older history exists that the index left out, so "everything shown" is not the whole session. */
  truncated = false
): Readout {
  const from = toReal(axis, viewMin);
  const to = toReal(axis, viewMax);
  const usage = summarizeUsage(aggregates, from, to);
  const whole = viewMin <= axis.min && viewMax >= axis.max;
  const scope = whole ? (truncated ? 'Everything shown' : 'Whole session') : formatRange(from, to, viewMax - viewMin < 30 * 60_000 ? 1_000 : 60_000);
  const activeTotal = formatElapsed(axis.activeMs);
  return {
    mode: 'range',
    time: scope,
    context: whole
      ? `All ${activeTotal} of ${truncated ? 'shown ' : ''}active time`
      : `${formatElapsed(activeMsInView(axis, viewMin, viewMax))} of ${activeTotal} active time in view`,
    cpu: usage.cpuMaxCores == null ? DASH : `avg ${formatCores(usage.cpuMeanCores)} · peak ${formatCores(usage.cpuMaxCores)}`,
    memory:
      usage.workingSetMaxBytes != null
        ? `peak ${formatBytes(usage.workingSetMaxBytes)} (${formatBytes(usage.memoryMaxBytes)} w/ cache)`
        : usage.memoryMaxBytes == null
          ? DASH
          : `peak ${formatBytes(usage.memoryMaxBytes)} incl. cache`,
    disk: `${formatBytes(usage.ioWriteBytes)} written · ${formatBytes(usage.ioReadBytes)} read`,
    tools: `${usage.toolCallStarts} tool call${usage.toolCallStarts === 1 ? '' : 's'}`,
    oomKills: usage.oomKills,
  };
}
