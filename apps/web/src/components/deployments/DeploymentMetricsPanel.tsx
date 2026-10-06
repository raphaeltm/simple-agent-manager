import type { NodeSystemInfo } from '@simple-agent-manager/shared';
import { Alert } from '@simple-agent-manager/ui';
import { RefreshCw } from 'lucide-react';

import { formatBytes, safePercent } from './deployment-card-format';

export type DeploymentMetricsState = {
  systemInfo: NodeSystemInfo | null;
  fallbackMetrics?: {
    cpuLoadAvg1?: number;
    memoryPercent?: number;
    diskPercent?: number;
  } | null;
  loading: boolean;
  error: string | null;
  unavailableReason?: string;
};

export function DeploymentMetricsPanel({ state }: { state: DeploymentMetricsState | undefined }) {
  if (!state) return null;

  const info = state.systemInfo;
  const fallback = state.fallbackMetrics;
  const containers = info?.docker?.containerList ?? [];

  return (
    <section className="rounded-md border border-border-default bg-inset px-3 py-3 grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-fg-primary font-semibold text-sm">
          <RefreshCw size={15} />
          Metrics
        </div>
        {state.loading && <span className="text-xs text-fg-muted">Refreshing...</span>}
      </div>

      {state.error && <Alert variant="error">{state.error}</Alert>}

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-sm border border-border-default px-2 py-1.5">
          <div className="text-[0.6875rem] uppercase text-fg-muted font-semibold">CPU</div>
          <div className="text-sm text-fg-primary truncate">
            {info ? info.cpu.loadAvg1.toFixed(2) : (fallback?.cpuLoadAvg1?.toFixed(2) ?? '-')}
          </div>
        </div>
        <div className="rounded-sm border border-border-default px-2 py-1.5">
          <div className="text-[0.6875rem] uppercase text-fg-muted font-semibold">Memory</div>
          <div className="text-sm text-fg-primary truncate">
            {info ? safePercent(info.memory.usedPercent) : safePercent(fallback?.memoryPercent)}
          </div>
        </div>
        <div className="rounded-sm border border-border-default px-2 py-1.5">
          <div className="text-[0.6875rem] uppercase text-fg-muted font-semibold">Disk</div>
          <div className="text-sm text-fg-primary truncate">
            {info ? safePercent(info.disk.usedPercent) : safePercent(fallback?.diskPercent)}
          </div>
        </div>
      </div>

      {!info && state.unavailableReason && (
        <div className="text-xs text-fg-muted">
          Live metrics unavailable: {state.unavailableReason.replace(/_/g, ' ')}.
        </div>
      )}

      <div className="grid gap-2">
        <div className="text-xs font-semibold uppercase text-fg-muted">Containers</div>
        {containers.length === 0 ? (
          <div className="text-xs text-fg-muted">No live container metrics available.</div>
        ) : (
          <div className="overflow-x-auto rounded-sm border border-border-default">
            <table className="w-full text-xs border-collapse">
              <thead className="text-fg-muted">
                <tr className="border-b border-border-default">
                  <th className="text-left font-semibold px-2 py-1">Name</th>
                  <th className="text-right font-semibold px-2 py-1">CPU</th>
                  <th className="text-right font-semibold px-2 py-1">Memory</th>
                  <th className="text-left font-semibold px-2 py-1">State</th>
                </tr>
              </thead>
              <tbody>
                {containers.map((container) => (
                  <tr
                    key={container.id || container.name}
                    className="border-b border-border-default last:border-b-0"
                  >
                    <td className="px-2 py-1 text-fg-primary max-w-[140px] truncate">
                      {container.name}
                    </td>
                    <td className="px-2 py-1 text-right text-fg-primary tabular-nums">
                      {safePercent(container.cpuPercent)}
                    </td>
                    <td className="px-2 py-1 text-right text-fg-primary tabular-nums">
                      {container.memUsage ? container.memUsage : safePercent(container.memPercent)}
                    </td>
                    <td className="px-2 py-1 text-fg-muted">{container.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {info && (
        <div className="text-[0.6875rem] text-fg-muted">
          Node memory {formatBytes(info.memory.usedBytes)} / {formatBytes(info.memory.totalBytes)}
        </div>
      )}
    </section>
  );
}
