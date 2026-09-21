import { Spinner } from '@simple-agent-manager/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Cpu,
  Database,
  HardDrive,
  MemoryStick,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  getSessionResourceHistory,
  type WorkspaceResourceChunk,
  type WorkspaceResourceHistoryResponse,
  type WorkspaceResourceSample,
  type WorkspaceResourceSummary,
  type WorkspaceResourceToolSpan,
} from '../../lib/api';
import { useDialogFocusTrap } from './useDialogFocusTrap';

interface SessionResourceHistoryDrawerProps {
  projectId: string;
  sessionId: string;
  onClose: () => void;
}

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

function formatDuration(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sampleMemoryMiB(sample: WorkspaceResourceSample): number {
  return Number(sample.memoryBytes ?? 0) / (1024 * 1024);
}

function sampleCpuMillis(sample: WorkspaceResourceSample): number {
  return Number(sample.cpuMillis ?? 0);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function sampleX(samples: WorkspaceResourceSample[], sample: WorkspaceResourceSample): number {
  if (samples.length <= 1) return 0;
  const start = samples[0]?.t;
  const end = samples.at(-1)?.t;
  if (typeof start !== 'number' || typeof end !== 'number') return 0;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return clampPercent(((sample.t - start) / (end - start)) * 100);
}

function seriesPoints(
  samples: WorkspaceResourceSample[],
  valueForSample: (sample: WorkspaceResourceSample) => number
): string {
  const max = Math.max(1, ...samples.map(valueForSample));
  return samples
    .map((sample) => {
      const x = sampleX(samples, sample);
      const y = 100 - (valueForSample(sample) / max) * 84 - 8;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

export function ResourceSparkline({
  samples,
  toolSpans,
}: Readonly<{ samples: WorkspaceResourceSample[]; toolSpans: WorkspaceResourceToolSpan[] }>) {
  const cpuPoints = useMemo(() => seriesPoints(samples, sampleCpuMillis), [samples]);
  const memoryPoints = useMemo(() => seriesPoints(samples, sampleMemoryMiB), [samples]);
  const eventMarkers = useMemo(
    () =>
      samples
        .map((sample) => ({ sample, x: sampleX(samples, sample) }))
        .filter(({ sample }) => sample.gap || sample.oom || sample.oomKill || sample.counterReset),
    [samples]
  );
  const chunkIoRead = samples.reduce((total, sample) => total + Number(sample.ioReadBytes ?? 0), 0);
  const chunkIoWrite = samples.reduce(
    (total, sample) => total + Number(sample.ioWriteBytes ?? 0),
    0
  );

  if (samples.length === 0) {
    return (
      <div className="rounded-lg border border-border-default p-4 text-sm text-fg-muted">
        No samples in this chunk.
      </div>
    );
  }

  const start = samples[0]?.t ?? 0;
  const end = samples.at(-1)?.t ?? start;
  const spanWidth = Math.max(1, end - start);

  return (
    <div className="rounded-lg border border-border-default bg-inset p-3">
      {/*
        `preserveAspectRatio="none"`: without it the default `xMidYMid meet`
        letterboxes the 1:1 viewBox into a centred SQUARE — measured 224px of
        drawn width inside a 323px card (144px at this `h-36`), so a third of
        the chart area was empty and the timeline was compressed to a third of
        its width. Every polyline already carries
        `vectorEffect="non-scaling-stroke"`, which only matters under
        non-uniform scaling: stretching was always the intent.
      */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-36 w-full overflow-visible"
        role="img"
        aria-label="CPU and memory resource timeline"
      >
        {toolSpans.map((span) => {
          const x = ((span.startedAt - start) / spanWidth) * 100;
          const width =
            ((Math.max(span.endedAt ?? span.startedAt, span.startedAt + 1) - span.startedAt) /
              spanWidth) *
            100;
          return (
            <rect
              key={span.id + span.startedAt}
              x={Math.max(0, Math.min(100, x))}
              y="4"
              width={Math.max(1, Math.min(100, width))}
              height="92"
              rx="1"
              fill="var(--sam-color-info)"
              opacity={span.approximate ? 0.14 : 0.22}
            />
          );
        })}
        <polyline
          points={cpuPoints}
          fill="none"
          stroke="var(--sam-color-success)"
          strokeWidth="2.2"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={memoryPoints}
          fill="none"
          stroke="var(--sam-color-accent-secondary, #a78bfa)"
          strokeDasharray="4 3"
          strokeWidth="2.2"
          vectorEffect="non-scaling-stroke"
        />
        {eventMarkers.map(({ sample, x }) => (
          <g key={`${sample.t}-${x}`}>
            <line
              x1={x}
              x2={x}
              y1="5"
              y2="95"
              stroke={
                sample.oom || sample.oomKill
                  ? 'var(--sam-color-warning)'
                  : 'var(--sam-color-border-strong)'
              }
              strokeDasharray="2 2"
              strokeWidth="1.4"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={x}
              cy={sample.oom || sample.oomKill ? 12 : 88}
              r="2.4"
              fill={
                sample.oom || sample.oomKill
                  ? 'var(--sam-color-warning)'
                  : 'var(--sam-color-fg-muted)'
              }
            />
          </g>
        ))}
      </svg>
      <div className="mt-2 grid gap-1 text-xs text-fg-muted">
        <span>CPU: green solid line, normalized to the CPU peak for this chunk.</span>
        <span>RAM: purple dashed line, normalized to the RAM peak for this chunk.</span>
        <span>
          Blue bands: concurrent tool windows. Dashed markers: gaps, counter resets, or OOM samples.
        </span>
        <span>
          Chunk I/O deltas: {formatBytes(chunkIoRead)} read · {formatBytes(chunkIoWrite)} write.
        </span>
      </div>
      {toolSpans.length > 0 && (
        <div className="mt-3 rounded-md border border-border-default bg-surface p-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            Tool windows
          </div>
          <ul className="mt-1 space-y-1 text-xs text-fg-muted">
            {toolSpans.map((span) => (
              <li
                key={`${span.id}-${span.startedAt}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate">
                  {span.kind || 'tool'} · {formatTime(span.startedAt)}
                  {span.approximate ? ' · approximate end' : ''}
                </span>
                <span className="shrink-0">
                  {formatDuration(span.startedAt, span.endedAt ?? span.startedAt)}
                  {span.concurrency ? ` · ${span.concurrency} concurrent` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function StatCard({
  icon: Icon,
  label,
  value,
}: Readonly<{ icon: typeof Cpu; label: string; value: string }>) {
  return (
    <div className="rounded-lg border border-border-default bg-surface p-3">
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        <Icon size={14} />
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-fg-primary">{value}</div>
    </div>
  );
}

function formatCpuPeak(summary: WorkspaceResourceSummary): string {
  if (summary.cpuPeakMillis == null) return '—';
  return `${Math.round(summary.cpuPeakMillis)} ms/sample`;
}

function detailPointLabel(detail: WorkspaceResourceHistoryResponse['detail']): string {
  if (!detail) return '';
  if (detail.downsampled) return `${detail.samples.length}/${detail.originalSampleCount} points`;
  return `${detail.samples.length} points`;
}

export function ResourceHistoryContent({
  isLoading,
  isError,
  isFetching,
  history,
  summary,
  effectiveChunkId,
  detail,
  onSelectChunk,
}: Readonly<{
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  history: WorkspaceResourceHistoryResponse | undefined;
  summary: WorkspaceResourceSummary | null | undefined;
  effectiveChunkId: string | null;
  detail: WorkspaceResourceHistoryResponse['detail'];
  onSelectChunk: (chunkId: string) => void;
}>) {
  if (isLoading && !history) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner size="sm" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger-tint p-3 text-sm text-danger-fg">
        Resource history could not be loaded.
      </div>
    );
  }

  const chunks = history?.chunks ?? [];
  if (!summary && chunks.length === 0 && !detail) {
    return (
      <div className="rounded-lg border border-border-default bg-surface p-4 text-sm text-fg-muted">
        No retained resource history is available for this session yet.
      </div>
    );
  }

  return (
    <>
      {/* 1. Stat cards */}
      {summary && (
        <div className="grid grid-cols-2 gap-2">
          <StatCard icon={Cpu} label="CPU peak" value={formatCpuPeak(summary)} />
          <StatCard
            icon={MemoryStick}
            label="RAM peak"
            value={formatBytes(summary.memoryPeakBytes)}
          />
          <StatCard
            icon={HardDrive}
            label="I/O total"
            value={`${formatBytes(summary.ioReadBytes)} read · ${formatBytes(summary.ioWriteBytes)} write`}
          />
          <StatCard
            icon={Database}
            label="Samples"
            value={`${summary.sampleCount} · ${summary.gapCount} gaps`}
          />
        </div>
      )}

      {/* 2. OOM banner */}
      {summary && summary.oomCount > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-tint p-3 text-sm text-warning-fg">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            {summary.oomCount} OOM event{summary.oomCount === 1 ? '' : 's'} observed in retained
            samples.
          </span>
        </div>
      )}

      {/* 3. Chart (auto-loaded for newest chunk) */}
      {detail && (
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
              Detail timeline
            </h3>
            <span className="text-xs text-fg-muted">{detailPointLabel(detail)}</span>
          </div>
          <ResourceSparkline samples={detail.samples} toolSpans={detail.toolSpans} />
        </section>
      )}

      {effectiveChunkId && !detail && isFetching && (
        <div className="flex items-center justify-center py-4">
          <Spinner size="sm" />
        </div>
      )}

      {/* 4. Correlation disclaimer (contextual, after chart) */}
      {detail && (
        <div className="rounded-lg border border-border-default bg-surface p-3 text-xs text-fg-muted">
          Correlation is based on concurrent tool windows and background resource usage. It is not
          per-process causal attribution. Disk space is not sampled on the hot loop.
        </div>
      )}

      {/* 5. Chunks disclosure (collapsed by default) */}
      {chunks.length > 0 && (
        <ChunksDisclosure
          chunks={chunks}
          effectiveChunkId={effectiveChunkId}
          onSelectChunk={onSelectChunk}
        />
      )}
    </>
  );
}

export function ChunkButton({
  chunk,
  selected,
  onSelect,
}: Readonly<{ chunk: WorkspaceResourceChunk; selected: boolean; onSelect: () => void }>) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`w-full rounded-lg border p-3 text-left transition-colors ${selected ? 'border-accent bg-accent/10' : 'border-border-default bg-surface hover:bg-surface-hover'}`}
    >
      <div className="flex items-center justify-between gap-2 text-sm text-fg-primary">
        <span>
          {formatTime(chunk.startedAt)} · {formatDuration(chunk.startedAt, chunk.endedAt)}
        </span>
        <span className="text-xs text-fg-muted">{chunk.sampleCount} samples</span>
      </div>
      <div className="mt-1 text-xs text-fg-muted">
        {formatBytes(chunk.compressedBytes)} compressed · {chunk.toolSpanCount} tool windows ·{' '}
        {chunk.gapCount} gaps
      </div>
    </button>
  );
}

function ChunksDisclosure({
  chunks,
  effectiveChunkId,
  onSelectChunk,
}: Readonly<{
  chunks: WorkspaceResourceChunk[];
  effectiveChunkId: string | null;
  onSelectChunk: (chunkId: string) => void;
}>) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-2 text-xs font-semibold uppercase tracking-wide text-fg-muted"
      >
        <ChevronRight
          size={14}
          className={`transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {chunks.length} chunk{chunks.length !== 1 ? 's' : ''}
      </button>
      {open && (
        <div className="space-y-2">
          {chunks.map((chunk) => (
            <ChunkButton
              key={chunk.id}
              chunk={chunk}
              selected={effectiveChunkId === chunk.id}
              onSelect={() => onSelectChunk(chunk.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function SessionResourceHistoryDrawer({
  projectId,
  sessionId,
  onClose,
}: SessionResourceHistoryDrawerProps) {
  const panelRef = useRef<HTMLDialogElement>(null);
  useDialogFocusTrap(panelRef, onClose);
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['session-resource-history', projectId, sessionId, selectedChunkId],
    queryFn: () => getSessionResourceHistory(projectId, sessionId, { chunkId: selectedChunkId }),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  const history = query.data;
  const summary = history?.summary;
  const latestChunk = history?.chunks[0] ?? null;
  const effectiveChunkId = selectedChunkId ?? latestChunk?.id ?? null;
  const detail = query.isPlaceholderData ? undefined : history?.detail;

  useEffect(() => {
    setSelectedChunkId(null);
  }, [projectId, sessionId]);

  useEffect(() => {
    if (selectedChunkId === null && latestChunk?.id && !query.isPlaceholderData) {
      setSelectedChunkId(latestChunk.id);
    }
  }, [selectedChunkId, latestChunk?.id, query.isPlaceholderData]);

  return createPortal(
    <>
      <div
        className="hidden md:block fixed inset-0 glass-backdrop-dim z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      <dialog
        open
        className="glass-panel-container glass-composited fixed z-50 glass-modal m-0 box-border h-[100dvh] w-[100dvw] max-h-[100dvh] max-w-[100dvw] rounded-none border-0 p-0 text-inherit backdrop:bg-transparent flex flex-col shadow-xl overflow-hidden
          inset-0
          md:inset-y-0 md:left-auto md:right-0 md:h-auto md:w-[min(460px,55vw)] md:max-w-[min(460px,55vw)] md:rounded-l-[20px] md:rounded-r-none md:border-y-0 md:border-r-0 md:border-l
          before:content-[''] before:absolute before:top-0 before:bottom-0 before:left-0 before:w-[3px] before:bg-[linear-gradient(to_bottom,transparent_0%,rgba(96,165,250,0.55)_50%,transparent_100%)] before:pointer-events-none before:blur-[1px]"
        ref={panelRef}
        tabIndex={-1}
        aria-modal="true"
        aria-label="Session resources"
      >
        <header className="flex items-center gap-2 px-3 py-2 border-b border-border-default shrink-0 min-h-[44px]">
          <Activity size={16} className="text-fg-muted shrink-0" />
          <h2 className="text-sm font-medium text-fg-primary flex-1 min-w-0">Resources</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-surface-hover text-fg-muted hover:text-fg-primary transition-colors"
            aria-label="Close resources"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
          <ResourceHistoryContent
            isLoading={query.isPending}
            isError={query.isError}
            isFetching={query.isFetching}
            history={history}
            summary={summary}
            effectiveChunkId={effectiveChunkId}
            detail={detail}
            onSelectChunk={setSelectedChunkId}
          />
        </div>
      </dialog>
    </>,
    document.body
  );
}
