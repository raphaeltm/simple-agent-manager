import { Button, Spinner } from '@simple-agent-manager/ui';
import { Activity, AlertTriangle, Cpu, Database, HardDrive, MemoryStick, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';

import {
  getSessionResourceHistory,
  type WorkspaceResourceChunk,
  type WorkspaceResourceSample,
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

function sampleY(sample: WorkspaceResourceSample): number {
  return Math.max(Number(sample.memoryBytes ?? 0) / (1024 * 1024), Number(sample.cpuMillis ?? 0));
}

function ResourceSparkline({
  samples,
  toolSpans,
}: Readonly<{ samples: WorkspaceResourceSample[]; toolSpans: WorkspaceResourceToolSpan[] }>) {
  const points = useMemo(() => {
    if (samples.length === 0) return '';
    const max = Math.max(1, ...samples.map(sampleY));
    return samples
      .map((sample, index) => {
        const x = samples.length === 1 ? 0 : (index / (samples.length - 1)) * 100;
        const y = 100 - (sampleY(sample) / max) * 88 - 6;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }, [samples]);

  if (samples.length === 0) {
    return (
      <div className="rounded-lg border border-border-default p-4 text-sm text-fg-muted">
        No samples in this chunk.
      </div>
    );
  }

  const start = samples[0]?.t ?? 0;
  const end = samples[samples.length - 1]?.t ?? start;
  const spanWidth = Math.max(1, end - start);

  return (
    <div className="rounded-lg border border-border-default bg-bg-subtle p-3">
      <svg
        viewBox="0 0 100 100"
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
              fill="var(--sam-color-accent-primary)"
              opacity={span.approximate ? 0.14 : 0.22}
            />
          );
        })}
        <polyline
          points={points}
          fill="none"
          stroke="var(--sam-color-success)"
          strokeWidth="2.2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-fg-muted">
        <span>Green line: CPU delta / memory level scale</span>
        <span>Blue bands: concurrent tool windows</span>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: Readonly<{ icon: typeof Cpu; label: string; value: string }>) {
  return (
    <div className="rounded-lg border border-border-default bg-bg-surface p-3">
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        <Icon size={14} />
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-fg-primary">{value}</div>
    </div>
  );
}

function ChunkButton({
  chunk,
  selected,
  onSelect,
}: Readonly<{ chunk: WorkspaceResourceChunk; selected: boolean; onSelect: () => void }>) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-lg border p-3 text-left transition-colors ${selected ? 'border-accent-primary bg-accent-primary/10' : 'border-border-default bg-bg-surface hover:bg-bg-hover'}`}
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

export function SessionResourceHistoryDrawer({
  projectId,
  sessionId,
  onClose,
}: SessionResourceHistoryDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(panelRef, onClose);
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['session-resource-history', projectId, sessionId, selectedChunkId],
    queryFn: () => getSessionResourceHistory(projectId, sessionId, { chunkId: selectedChunkId }),
    staleTime: 15_000,
  });

  const history = query.data;
  const summary = history?.summary;
  const latestChunk = history?.chunks[0] ?? null;
  const effectiveChunkId = selectedChunkId ?? latestChunk?.id ?? null;
  const detail = history?.detail;

  return createPortal(
    <>
      <div
        className="hidden md:block fixed inset-0 glass-backdrop-dim z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="glass-panel-container glass-composited fixed z-50 glass-modal rounded-l-[20px] rounded-r-none border-y-0 border-r-0 flex flex-col shadow-xl overflow-hidden inset-0 md:inset-y-0 md:left-auto md:right-0 md:w-[min(460px,55vw)] before:content-[''] before:absolute before:top-0 before:bottom-0 before:left-0 before:w-[3px] before:bg-[linear-gradient(to_bottom,transparent_0%,rgba(96,165,250,0.55)_50%,transparent_100%)] before:pointer-events-none before:blur-[1px]"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Session resources"
      >
        <header className="flex items-center gap-2 px-3 py-2 border-b border-border-default shrink-0 min-h-[44px]">
          <Activity size={16} className="text-fg-muted shrink-0" />
          <h2 className="text-sm font-medium text-fg-primary flex-1 min-w-0">Resources</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-bg-hover text-fg-muted hover:text-fg-primary transition-colors"
            aria-label="Close resources"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
          {query.isPending && !history ? (
            <div className="flex items-center justify-center py-8">
              <Spinner size="sm" />
            </div>
          ) : query.isError ? (
            <div className="rounded-lg border border-border-danger bg-danger-subtle p-3 text-sm text-danger-fg">
              Resource history could not be loaded.
            </div>
          ) : !summary ? (
            <div className="rounded-lg border border-border-default bg-bg-surface p-4 text-sm text-fg-muted">
              No retained resource history is available for this session yet.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <StatCard
                  icon={Cpu}
                  label="CPU peak"
                  value={
                    summary.cpuPeakMillis == null
                      ? '—'
                      : `${Math.round(summary.cpuPeakMillis)} ms/sample`
                  }
                />
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

              {summary.oomCount > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-border-warning bg-warning-subtle p-3 text-sm text-warning-fg">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  <span>
                    {summary.oomCount} OOM event{summary.oomCount === 1 ? '' : 's'} observed in
                    retained samples.
                  </span>
                </div>
              )}

              <div className="rounded-lg border border-border-default bg-bg-surface p-3 text-xs text-fg-muted">
                Correlation is based on concurrent tool windows and background resource usage. It is
                not per-process causal attribution. Disk space is not sampled on the hot loop.
              </div>

              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  Chunks
                </h3>
                {history?.chunks.map((chunk) => (
                  <ChunkButton
                    key={chunk.id}
                    chunk={chunk}
                    selected={effectiveChunkId === chunk.id}
                    onSelect={() => setSelectedChunkId(chunk.id)}
                  />
                ))}
              </section>

              {effectiveChunkId && !detail && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  onClick={() => setSelectedChunkId(effectiveChunkId)}
                  disabled={query.isFetching}
                >
                  {query.isFetching ? 'Loading detail…' : 'Load detail timeline'}
                </Button>
              )}

              {detail && (
                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                      Detail timeline
                    </h3>
                    <span className="text-xs text-fg-muted">
                      {detail.downsampled
                        ? `${detail.samples.length}/${detail.originalSampleCount} points`
                        : `${detail.samples.length} points`}
                    </span>
                  </div>
                  <ResourceSparkline samples={detail.samples} toolSpans={detail.toolSpans} />
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </>,
    document.body
  );
}
