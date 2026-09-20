/**
 * Variant C content — "Inspector".
 *
 * Today the most useful thing in the panel (the timeline chart) is last, under
 * a chunk list you have to scroll past on a phone. This reorders it: a pinned
 * summary strip, a segmented control, and the chart at the top of the default
 * segment.
 *
 * Formatting helpers are re-implemented locally because the production
 * equivalents are module-private in `SessionResourceHistoryDrawer.tsx` and this
 * prototype is only permitted to export the four rendering components from it.
 */
import { AlertTriangle, Cpu, Database, HardDrive, MemoryStick } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

import {
  ChunkButton,
  ResourceSparkline,
  StatCard,
} from '../../components/chat/SessionResourceHistoryDrawer';
import { useIsMobile } from '../../hooks/useIsMobile';
import type {
  WorkspaceResourceChunk,
  WorkspaceResourceHistoryResponse,
  WorkspaceResourceSummary,
  WorkspaceResourceToolSpan,
} from '../../lib/api/sessions';

export type InspectorSegment = 'timeline' | 'chunks' | 'about';

const SEGMENTS: ReadonlyArray<{ id: InspectorSegment; label: string }> = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'chunks', label: 'Chunks' },
  { id: 'about', label: 'About' },
];

const CORRELATION_COPY =
  'Correlation is based on concurrent tool windows and background resource usage. It is not per-process causal attribution. Disk space is not sampled on the hot loop.';

function formatBytes(value: number | null | undefined): string {
  if (!value || value <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let next = value;
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) {
    next /= 1024;
    unit += 1;
  }
  return `${next >= 10 ? next.toFixed(0) : next.toFixed(1)} ${units[unit]}`;
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatSpan(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

/**
 * True until the scroller is scrolled to its right end.
 *
 * Measured from the element rather than tracked as a snap index, because the
 * number of cards that fit depends on the panel width and the font size.
 */
function useHasMoreToTheRight(): [boolean, (el: HTMLElement | null) => void, () => void] {
  const [hasMore, setHasMore] = useState(false);
  const el = useRef<HTMLElement | null>(null);

  const measure = useCallback(() => {
    const node = el.current;
    if (!node) return;
    // +1 absorbs sub-pixel layout rounding.
    setHasMore(node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
  }, []);

  const setEl = useCallback(
    (node: HTMLElement | null) => {
      el.current = node;
      measure();
    },
    [measure]
  );

  return [hasMore, setEl, measure];
}

/**
 * Pinned strip under the header.
 *
 * Horizontal scroller rather than a 2x2 grid: four cards stacked two-high eat
 * ~140px of a 667px viewport before the chart gets any.
 */
export function SummaryStrip({
  summary,
}: Readonly<{ summary: WorkspaceResourceSummary | null | undefined }>) {
  const isMobile = useIsMobile();
  const [hasMore, setStripEl, remeasure] = useHasMoreToTheRight();
  if (!summary) return null;
  /*
   * A mask rather than a gradient overlay: the panel surface is glass, so an
   * opaque gradient would have to guess the composited colour behind it. The
   * mask fades the CONTENT instead, which is correct on any background — and it
   * adds no box, so it cannot widen the row.
   */
  const fadeMask =
    isMobile && hasMore
      ? 'linear-gradient(to right, black calc(100% - 28px), transparent 100%)'
      : undefined;
  return (
    <div className="shrink-0 border-b border-border-default px-3 py-2">
      <div
        data-testid="inspector-stat-strip"
        data-has-more={hasMore ? 'true' : 'false'}
        ref={setStripEl}
        onScroll={remeasure}
        style={{ maskImage: fadeMask, WebkitMaskImage: fadeMask }}
        className="-mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:grid md:grid-cols-2 md:overflow-x-visible"
      >
        {[
          {
            icon: Cpu,
            label: 'CPU peak',
            value:
              summary.cpuPeakMillis == null
                ? '—'
                : `${Math.round(summary.cpuPeakMillis)} ms/sample`,
          },
          { icon: MemoryStick, label: 'RAM peak', value: formatBytes(summary.memoryPeakBytes) },
          {
            icon: HardDrive,
            label: 'I/O',
            value: `${formatBytes(summary.ioReadBytes)} · ${formatBytes(summary.ioWriteBytes)}`,
          },
          {
            icon: Database,
            label: 'Samples',
            value: `${summary.sampleCount} · ${summary.gapCount} gaps`,
          },
        ].map((stat) => (
          // Scroller on a phone, 2x2 grid on the wider desktop rail, where a
          // horizontally-clipped fourth stat is just a stat you cannot see.
          <div key={stat.label} className="w-[9.5rem] shrink-0 snap-start md:w-auto">
            <StatCard icon={stat.icon} label={stat.label} value={stat.value} />
          </div>
        ))}
      </div>

      {summary.oomCount > 0 && (
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning-tint px-2.5 py-1 text-xs font-medium text-warning-fg">
          <AlertTriangle size={13} className="shrink-0" />
          {summary.oomCount} OOM event{summary.oomCount === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

export function SegmentedControl({
  value,
  onChange,
}: Readonly<{ value: InspectorSegment; onChange: (segment: InspectorSegment) => void }>) {
  return (
    <div
      role="group"
      aria-label="Resource view"
      className="flex shrink-0 gap-1 border-b border-border-default px-3 py-2"
    >
      {SEGMENTS.map((segment) => (
        <button
          key={segment.id}
          type="button"
          aria-pressed={value === segment.id}
          data-testid={`inspector-segment-${segment.id}`}
          onClick={() => onChange(segment.id)}
          className={`h-11 flex-1 cursor-pointer rounded-lg border-none text-xs font-semibold transition-colors ${
            value === segment.id
              ? 'bg-accent text-fg-on-accent'
              : 'bg-inset text-fg-muted hover:bg-surface-hover hover:text-fg-primary'
          }`}
        >
          {segment.label}
        </button>
      ))}
    </div>
  );
}

function ChunkChipRow({
  chunks,
  selectedId,
  onSelect,
}: Readonly<{
  chunks: WorkspaceResourceChunk[];
  selectedId: string | null;
  onSelect: (chunkId: string) => void;
}>) {
  if (chunks.length === 0) return null;
  return (
    <div
      data-testid="inspector-chunk-chips"
      className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {chunks.map((chunk) => {
        const selected = chunk.id === selectedId;
        return (
          <button
            key={chunk.id}
            type="button"
            onClick={() => onSelect(chunk.id)}
            aria-pressed={selected}
            className={`h-11 shrink-0 snap-start cursor-pointer rounded-full border px-3 text-xs font-medium transition-colors ${
              selected
                ? 'border-accent bg-accent/10 text-fg-primary'
                : 'border-border-default bg-surface text-fg-muted hover:bg-surface-hover'
            }`}
          >
            {formatClock(chunk.startedAt)} · {formatSpan(chunk.startedAt, chunk.endedAt)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The full tool-window list, expandable.
 *
 * Production truncates at 6 and tells you the rest were "omitted from the
 * compact list", which on the Huge dataset means 34 windows you cannot reach.
 * `ResourceSparkline`'s own compact list is suppressed here (see the wrapper in
 * `TimelineSegment`) so this is the single implementation on screen.
 */
function ToolWindowList({ spans }: Readonly<{ spans: WorkspaceResourceToolSpan[] }>) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? spans : spans.slice(0, 6);
  if (spans.length === 0) return null;

  return (
    <section className="rounded-lg border border-border-default bg-surface p-3">
      <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-fg-muted">
        Tool windows
      </h3>
      <ul className="m-0 mt-1.5 list-none space-y-1 p-0 text-xs text-fg-muted">
        {visible.map((span) => (
          <li
            key={`${span.id}-${span.startedAt}`}
            className="flex items-center justify-between gap-2"
          >
            <span className="min-w-0 truncate">
              {span.kind || 'tool'} · {formatClock(span.startedAt)}
              {span.approximate ? ' · approximate end' : ''}
            </span>
            <span className="shrink-0">
              {formatSpan(span.startedAt, span.endedAt ?? span.startedAt)}
              {span.concurrency ? ` · ${span.concurrency}×` : ''}
            </span>
          </li>
        ))}
      </ul>
      {spans.length > 6 && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          data-testid="inspector-toggle-windows"
          className="mt-2 h-11 w-full cursor-pointer rounded-lg border border-border-default bg-transparent text-xs font-medium text-fg-primary transition-colors hover:bg-surface-hover"
        >
          {expanded ? 'Show fewer windows' : `Show all ${spans.length} windows`}
        </button>
      )}
    </section>
  );
}

export function TimelineSegment({
  chunks,
  selectedChunkId,
  detail,
  isFetching,
  onSelectChunk,
}: Readonly<{
  chunks: WorkspaceResourceChunk[];
  selectedChunkId: string | null;
  detail: WorkspaceResourceHistoryResponse['detail'];
  isFetching: boolean;
  onSelectChunk: (chunkId: string) => void;
}>) {
  const spans = useMemo(() => detail?.toolSpans ?? [], [detail]);

  return (
    <>
      <ChunkChipRow chunks={chunks} selectedId={selectedChunkId} onSelect={onSelectChunk} />

      {/*
        Two consumer-side overrides of the reused `ResourceSparkline`, which this
        prototype is not allowed to fork:
          [&_svg]:h-56  — a 144px chart is the smallest element on the screen it
                          is supposed to be the point of.
          [&_.mt-3]:hidden — suppresses its built-in top-6 tool list so
                          `ToolWindowList` below is the only one on screen.
      */}
      <div data-testid="inspector-chart" className="[&_svg]:h-56 md:[&_svg]:h-64 [&_.mt-3]:hidden">
        {detail ? (
          <ResourceSparkline samples={detail.samples} toolSpans={detail.toolSpans} />
        ) : (
          <div className="rounded-lg border border-border-default bg-inset p-6 text-center text-sm text-fg-muted">
            {isFetching ? 'Loading detail…' : 'Select a window to load its timeline.'}
          </div>
        )}
      </div>

      <ToolWindowList spans={spans} />
    </>
  );
}

export function AboutSegment() {
  return (
    <div className="rounded-lg border border-border-default bg-surface p-3 text-xs leading-relaxed text-fg-muted">
      <p className="m-0">{CORRELATION_COPY}</p>
      <p className="m-0 mt-2">
        The chart legend under the timeline explains the two series and the marker types.
      </p>
    </div>
  );
}

export function ChunksSegment({
  chunks,
  selectedChunkId,
  onSelect,
}: Readonly<{
  chunks: WorkspaceResourceChunk[];
  selectedChunkId: string | null;
  onSelect: (chunkId: string) => void;
}>) {
  return (
    <section className="space-y-2">
      <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-fg-muted">
        Chunks ({chunks.length})
      </h3>
      {chunks.map((chunk) => (
        <ChunkButton
          key={chunk.id}
          chunk={chunk}
          selected={selectedChunkId === chunk.id}
          onSelect={() => onSelect(chunk.id)}
        />
      ))}
    </section>
  );
}

/** Same copy as the production component's terminal states. */
export function InspectorErrorState() {
  return (
    <div className="rounded-lg border border-danger/30 bg-danger-tint p-3 text-sm text-danger-fg">
      Resource history could not be loaded.
    </div>
  );
}

export function InspectorEmptyState() {
  return (
    <div className="rounded-lg border border-border-default bg-surface p-4 text-sm text-fg-muted">
      No retained resource history is available for this session yet.
    </div>
  );
}
