import { Button, Spinner } from '@simple-agent-manager/ui';
import { AlertTriangle } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';

import { formatBytes, formatDayTime, formatElapsed, formatMinutes } from './format';
import { type PanelState, PLOT_LEFT_GUTTER_PX, PLOT_RIGHT_PADDING_PX } from './panels';
import { readoutAtCursor, readoutForRange } from './readout';
import type { ResourceHistorySource } from './resource-source';
import { buildSeries, findPeaks, type UsagePeak } from './series';
import { sleeps, type TimeAxisMode, toAxis, toReal } from './time-axis';
import { useTimelineView } from './timeline-view';
import { PEAK_CONTEXT_MS, PeakList, RangeControls, ReadoutBar } from './TimelineControls';
import { TimelineNavigator } from './TimelineNavigator';
import { TimelinePanels } from './TimelinePanels';
import type { ResourceTimelineIndex } from './types';
import { useElementWidth } from './useElementWidth';
import {
  useResourceTimelineData,
  useResourceTimelineIndex,
  useTimelineAxis,
} from './useResourceTimelineData';

/** Peaks closer together than this count as one moment. */
const PEAK_SEPARATION_MS = 20 * 60_000;
const PEAKS_PER_METRIC = 3;
/** "Latest" shows this much of the newest data. */
const LATEST_SPAN_MS = 15 * 60_000;

/**
 * The whole-session resource timeline. The drawer loads this module lazily, so
 * the project chat route never downloads uPlot unless someone opens Resources.
 */
export function ResourceTimeline({ source }: Readonly<{ source: ResourceHistorySource }>) {
  const indexQuery = useResourceTimelineIndex(source);

  if (indexQuery.isPending) {
    return (
      <div className="flex items-center justify-center py-10">
        <Spinner size="sm" />
      </div>
    );
  }
  if (!indexQuery.data) {
    return (
      <div className="space-y-2 rounded-lg border border-danger/30 bg-danger-tint p-3 text-sm text-danger-fg">
        <p>Resource history could not be loaded.</p>
        <Button size="sm" variant="secondary" onClick={() => void indexQuery.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (indexQuery.data.chunks.length === 0) {
    switch (indexQuery.data.collection) {
      case 'unsupported':
        return (
          <EmptyNotice title="Not recorded for Instant sessions">
            Instant sessions run in a lightweight container that does not record CPU, memory or disk
            usage yet. Sessions on a VM workspace record the full timeline.
          </EmptyNotice>
        );
      case 'expired':
        return (
          <EmptyNotice title="Detailed history has expired">
            This session&apos;s CPU, memory and disk samples are older than the retention period and
            have been deleted.
          </EmptyNotice>
        );
      default:
        return (
          <EmptyNotice title="No resource samples yet">
            The workspace samples CPU, memory and disk every few seconds and uploads them every{' '}
            {formatMinutes(indexQuery.data.uploadIntervalMs)}, so the first data appears about{' '}
            {formatMinutes(indexQuery.data.uploadIntervalMs)} after the session starts.
          </EmptyNotice>
        );
    }
  }
  return <TimelineBody source={source} index={indexQuery.data} />;
}

function EmptyNotice({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <div className="rounded-lg border border-border-default bg-surface p-4 text-sm text-fg-muted">
      <p className="font-medium text-fg-primary">{title}</p>
      <p className="mt-1">{children}</p>
    </div>
  );
}

function SessionSummary({
  index,
  activeMs,
}: Readonly<{ index: ResourceTimelineIndex; activeMs: number }>) {
  const first = index.runs[0]?.startedAt ?? index.chunks[0]?.startedAt ?? 0;
  const last = index.chunks.at(-1)?.endedAt ?? first;
  const nodes = new Set(index.runs.map((run) => run.nodeId).filter(Boolean)).size;
  const highWater = Math.max(0, ...index.chunks.map((chunk) => chunk.memoryHighWaterBytes ?? 0));
  const wakes = index.runs.length;
  return (
    <div className="text-xs text-fg-muted">
      <p className="text-sm text-fg-primary">
        {formatElapsed(activeMs)} active
        {wakes > 1 && ` over ${formatElapsed(last - first)} · ${wakes} wake cycles`}
        {nodes > 1 && ` on ${nodes} nodes`}
      </p>
      <p>
        Data until {formatDayTime(last)} · uploaded every {formatMinutes(index.uploadIntervalMs)}
        {highWater > 0 && ` · kernel memory peak ${formatBytes(highWater)}`}
      </p>
      {index.completeness.kind === 'truncated' && (
        <p className="mt-1 flex items-start gap-1 text-warning-fg">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          {index.completeness.omitted == null
            ? 'Only the newest part of this session\u2019s history is shown. Older data exists but is not shown.'
            : `Only the newest part of this session\u2019s history is shown: ${index.completeness.omitted} older 15-minute ${
                index.completeness.omitted === 1 ? 'segment is' : 'segments are'
              } not shown.`}
        </p>
      )}
    </div>
  );
}

function TimelineBody({
  source,
  index,
}: Readonly<{ source: ResourceHistorySource; index: ResourceTimelineIndex }>) {
  const [axisMode, setAxisMode] = useState<TimeAxisMode>('active');
  const axis = useTimelineAxis(index, axisMode);
  const { view, intent, setRange, zoom, showSpan, showLatest, showAll } = useTimelineView(axis);
  /** The instant under the finger or pointer, as wall-clock time so it survives axis changes. */
  const [cursorT, setCursorT] = useState<number | null>(null);

  const measureRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(measureRef);
  const plotWidth = Math.max(1, width - PLOT_LEFT_GUTTER_PX - PLOT_RIGHT_PADDING_PX);

  const data = useResourceTimelineData(source, index, axis, {
    min: view.min,
    max: view.max,
    widthPx: plotWidth,
  });
  const series = useMemo(
    () => buildSeries(data.aggregates, axis, view.min, view.max, plotWidth, index.sampleIntervalMs),
    [data.aggregates, axis, view.min, view.max, plotWidth, index.sampleIntervalMs]
  );
  const hasWorkingSet = useMemo(
    () => data.overview.some((aggregate) => aggregate.workingSetMaxBytes != null),
    [data.overview]
  );
  const panelState = useMemo<PanelState>(
    () => ({
      axis,
      viewMin: view.min,
      viewMax: view.max,
      series,
      runs: index.runs,
      toolSpans: data.toolSpans,
      hasWorkingSet,
    }),
    [axis, view.min, view.max, series, index.runs, data.toolSpans, hasWorkingSet]
  );

  const cursorX = cursorT == null ? null : toAxis(axis, cursorT);
  const cursorInView = cursorX != null && cursorX >= view.min && cursorX <= view.max;
  const readout = cursorInView
    ? readoutAtCursor(cursorX, series, axis, index.runs, data.toolSpans, index.sampleIntervalMs)
    : readoutForRange(
        view.min,
        view.max,
        axis,
        data.aggregates,
        index.completeness.kind === 'truncated'
      );

  const peaks = useMemo(
    () =>
      [
        ...findPeaks(data.overview, 'memory', PEAKS_PER_METRIC, PEAK_SEPARATION_MS),
        ...findPeaks(data.overview, 'cpu', PEAKS_PER_METRIC, PEAK_SEPARATION_MS),
      ].sort((a, b) => a.at - b.at),
    [data.overview]
  );

  const onCursor = useCallback(
    (x: number | null) => setCursorT(x == null ? null : toReal(axis, x)),
    [axis]
  );
  const onAxisMode = useCallback((mode: TimeAxisMode) => setAxisMode(mode), []);
  const centre = cursorInView ? cursorX : (view.min + view.max) / 2;
  const runLabel = useCallback(
    (t: number) => {
      const position = index.runs.findIndex((run) => t >= run.startedAt && t <= run.endedAt);
      return position === -1 ? 'between runs' : `run ${position + 1} of ${index.runs.length}`;
    },
    [index.runs]
  );
  const onPeak = useCallback(
    (peak: UsagePeak) => {
      setCursorT(peak.at);
      showSpan(PEAK_CONTEXT_MS, toAxis(axis, peak.at));
    },
    [axis, showSpan]
  );

  return (
    <div className="space-y-2">
      <SessionSummary index={index} activeMs={axis.activeMs} />
      <ReadoutBar
        readout={readout}
        pendingChunks={data.pendingChunks}
        failedChunks={data.failedChunks}
        onClear={() => setCursorT(null)}
      />
      <div ref={measureRef}>
        <TimelinePanels
          state={panelState}
          readout={readout}
          cursorX={cursorInView ? cursorX : null}
          onCursor={onCursor}
          onRange={setRange}
          onZoom={zoom}
          onResetZoom={showAll}
        />
        <TimelineNavigator
          axis={axis}
          overview={data.sessionAggregates}
          view={view}
          sessionStart={index.runs[0]?.startedAt ?? null}
          sessionEnd={index.chunks.at(-1)?.endedAt ?? null}
          onRange={setRange}
        />
      </div>
      <RangeControls
        fullSpanMs={axis.max - axis.min}
        viewSpanMs={view.max - view.min}
        followingLatest={intent.kind === 'latest'}
        axisMode={axisMode}
        hasSleeps={sleeps(axis).length > 0}
        onAll={showAll}
        onSpan={(spanMs) => showSpan(spanMs, centre)}
        onLatest={() => showLatest(LATEST_SPAN_MS)}
        onAxisMode={onAxisMode}
      />
      <PeakList peaks={peaks} runLabel={runLabel} onSelect={onPeak} />
      <details className="mt-3 rounded-lg border border-border-default bg-surface p-3 text-xs text-fg-muted">
        <summary className="cursor-pointer font-medium text-fg-primary">About this data</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>
            Sampled every {formatElapsed(index.sampleIntervalMs)} from the workspace
            container&apos;s cgroup. It covers everything in the container, not one process.
          </li>
          <li>CPU is in cores: 1.0 means one core fully busy.</li>
          <li>
            Memory &ldquo;used&rdquo; is the working set the kernel cannot reclaim; &ldquo;incl.
            cache&rdquo; adds page cache it can drop under pressure. Size workspaces by
            &ldquo;used&rdquo;.
          </li>
          <li>
            Tool calls line up with usage by time only. A spike during a tool call is a correlation,
            not proof that the tool caused it.
          </li>
          <li>
            Zoomed out, each point is an average with its peak shaded; zoom in for individual
            samples.
          </li>
        </ul>
      </details>
    </div>
  );
}
