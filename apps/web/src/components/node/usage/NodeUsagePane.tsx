import type {
  NodeResponse,
  NodeStatus,
  NodeWorkspaceResourceUsage,
} from '@simple-agent-manager/shared';
import {
  Chip,
  type ChipTone,
  DropdownMenu,
  type DropdownMenuItem,
  Pane,
} from '@simple-agent-manager/ui';
import { ChevronRight, Rocket, Server } from 'lucide-react';
import { Link } from 'react-router';

import { HardwareDetails } from '../../hardware/HardwareDetails';
import { CPU_COLOR, MEMORY_COLOR, MirrorChart, Swatch } from './MirrorChart';
import {
  formatGb,
  formatVcpu,
  formatVcpuBare,
  liveMemoryByWorkspace,
  machineSpec,
  sessionNow,
  specLine,
  sumSeries,
} from './node-resource-model';
import { NodeSessionRow } from './NodeSessionRow';

const MB = 1024 * 1024;

export interface UsageWindow {
  windowStart: number;
  windowEnd: number;
  bucketMs: number;
}

const STATUS_CHIP: Record<NodeStatus, { label: string; tone: ChipTone; dot?: boolean }> = {
  running: { label: 'Running', tone: 'success', dot: true },
  pending: { label: 'Pending', tone: 'info', dot: true },
  creating: { label: 'Starting', tone: 'info', dot: true },
  recovery: { label: 'Recovering', tone: 'info', dot: true },
  sleeping: { label: 'Sleeping', tone: 'muted' },
  stopping: { label: 'Stopping', tone: 'muted' },
  stopped: { label: 'Stopped', tone: 'muted' },
  deleted: { label: 'Deleted', tone: 'muted' },
  error: { label: 'Error', tone: 'danger' },
};

function nodeActions(
  node: NodeResponse,
  handlers: { onStop: (id: string) => void; onDelete: (id: string) => void }
): DropdownMenuItem[] {
  const items: DropdownMenuItem[] = [];
  if (node.status === 'running') {
    items.push({ id: 'stop', label: 'Stop', onClick: () => handlers.onStop(node.id) });
  }
  items.push({
    id: 'delete',
    label: 'Delete',
    variant: 'danger',
    onClick: () => handlers.onDelete(node.id),
    disabled: node.status === 'creating' || node.status === 'stopping',
    disabledReason: 'Cannot delete while node is transitioning',
  });
  return items;
}

function emptyNote(node: NodeResponse): string {
  switch (node.status) {
    case 'pending':
    case 'creating':
      return 'Starting up. New sessions can run here once it is ready.';
    case 'stopping':
    case 'stopped':
      return 'Stopped. Nothing runs here.';
    case 'error':
      return 'Nothing running.';
    default:
      return 'Nothing running. SAM keeps an idle machine warm for a while so the next session starts fast.';
  }
}

export interface NodeUsagePaneProps {
  node: NodeResponse;
  /** Sessions on this node; undefined while the usage request has not answered. */
  sessions: NodeWorkspaceResourceUsage[] | undefined;
  usageWindow: UsageWindow | null;
  clock: number;
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
}

export function NodeUsagePane({
  node,
  sessions,
  usageWindow,
  clock,
  onStop,
  onDelete,
}: NodeUsagePaneProps) {
  const spec = machineSpec(node);
  const status = STATUS_CHIP[node.status] ?? STATUS_CHIP.running;
  const isDeployment = node.nodeRole === 'deployment';
  const live = liveMemoryByWorkspace(node, clock);
  const rows = (sessions ?? []).map((usage) => ({
    usage,
    live: live.get(usage.workspaceId),
    now: sessionNow(usage, live.get(usage.workspaceId)),
  }));

  // Machine totals: capacity from the hardware, set aside from reservations, "now" from
  // live memory where the heartbeat has it and the newest history minute otherwise.
  const exclusive = rows.some((r) => r.usage.reservation?.exclusiveNode);
  const memoryCapacity = spec.memoryMb ? spec.memoryMb * MB : null;
  const cpuCapacity = spec.vcpu ? spec.vcpu * 1000 : null;
  const reservedMemory = rows.reduce((t, r) => t + (r.now.reservedMemoryBytes ?? 0), 0);
  const reservedCpu = rows.reduce((t, r) => t + (r.now.reservedCpuMillis ?? 0), 0);
  const memoryNow = rows.reduce((t, r) => t + (r.now.memoryBytes ?? 0), 0);
  const cpuNow = rows.reduce((t, r) => t + (r.now.cpuMillis ?? 0), 0);
  const total = sumSeries(rows.map((r) => r.usage.series));
  const liveTotal = rows.some((r) => r.live !== undefined) ? memoryNow : null;
  const memoryMax =
    memoryCapacity ??
    Math.max(reservedMemory, memoryNow, ...total.memoryBytes.map((v) => v ?? 0)) * 1.1;
  const cpuMax = cpuCapacity ?? Math.max(reservedCpu, ...total.cpuMillis.map((v) => v ?? 0)) * 1.1;
  const memorySetAside = exclusive && memoryCapacity ? memoryCapacity : reservedMemory;
  const cpuSetAside = exclusive && cpuCapacity ? cpuCapacity : reservedCpu;

  return (
    <Pane
      as="article"
      aria-label={`${spec.title}, ${spec.location}`}
      className="flex min-w-0 flex-col gap-3 p-4"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="sam-raised mt-0.5 hidden h-9 w-9 shrink-0 place-items-center rounded-[var(--sam-radius-control)] md:grid">
          {isDeployment ? (
            <Rocket size={18} strokeWidth={1.75} className="text-fg-muted" aria-hidden="true" />
          ) : (
            <Server size={18} strokeWidth={1.75} className="text-fg-muted" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="m-0 min-w-0 truncate text-[15px] font-semibold text-fg-primary">
              {spec.title}
            </h2>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <Chip tone={status.tone} size="sm" dot={status.dot}>
                {status.label}
              </Chip>
              {node.status === 'running' &&
                node.healthStatus &&
                node.healthStatus !== 'healthy' && (
                  <Chip tone={node.healthStatus === 'unhealthy' ? 'danger' : 'muted'} size="sm">
                    {node.healthStatus === 'unhealthy' ? 'Unhealthy' : 'No heartbeat'}
                  </Chip>
                )}
              <span role="presentation" onClick={(e) => e.stopPropagation()}>
                <DropdownMenu
                  items={nodeActions(node, { onStop, onDelete })}
                  aria-label={`Actions for ${spec.title}`}
                />
              </span>
            </span>
          </div>
          <p className="m-0 mt-0.5 truncate text-[12.5px] text-fg-muted">
            {[spec.location, specLine(spec), isDeployment ? 'Deployment' : null]
              .filter(Boolean)
              .join(' · ')}
            {node.providerInstancePriceDisplay ? ` · ${node.providerInstancePriceDisplay}` : ''}
          </p>
        </div>
      </div>

      {node.errorMessage && (
        <div className="rounded-[10px] bg-danger-tint p-2">
          <span className="text-[12px] text-danger [overflow-wrap:anywhere]">
            {node.errorMessage}
          </span>
        </div>
      )}

      {isDeployment ? (
        <div className="flex flex-col gap-1 text-[12.5px]">
          {(node.deploymentEnvironments ?? []).length > 0 ? (
            (node.deploymentEnvironments ?? []).map((env) => (
              <span key={env.id} className="truncate text-fg-primary">
                {env.name}
              </span>
            ))
          ) : (
            <span className="text-fg-muted">No deployment environments</span>
          )}
          <span className="text-fg-muted">Managed from the project deployment environment.</span>
        </div>
      ) : sessions === undefined ? null : rows.length === 0 ? (
        <p className="m-0 text-[13px] text-fg-muted">{emptyNote(node)}</p>
      ) : (
        <>
          {usageWindow && (
            <div className="flex flex-col gap-1.5" data-testid="machine-chart">
              <div className="flex items-center justify-between gap-2 font-mono text-[10.5px]">
                <span className="flex min-w-0 items-center gap-1.5 text-fg-primary">
                  <Swatch color={MEMORY_COLOR} />
                  memory {formatGb(memoryNow)}
                  {memoryCapacity && (
                    <span className="text-fg-muted">of {formatGb(memoryCapacity)}</span>
                  )}
                </span>
                <span className="shrink-0 text-fg-muted">set aside {formatGb(memorySetAside)}</span>
              </div>
              <div className="sam-well overflow-hidden rounded-[12px]">
                <MirrorChart
                  series={total}
                  windowStart={usageWindow.windowStart}
                  windowEnd={usageWindow.windowEnd}
                  bucketMs={usageWindow.bucketMs}
                  memoryMax={memoryMax}
                  cpuMax={cpuMax}
                  memoryReserved={memorySetAside || null}
                  cpuReserved={cpuSetAside || null}
                  liveMemory={liveTotal}
                  className="h-[120px] md:h-[150px]"
                />
              </div>
              <div className="flex items-center justify-between gap-2 font-mono text-[10.5px]">
                <span className="flex min-w-0 items-center gap-1.5 text-fg-primary">
                  <Swatch color={CPU_COLOR} />
                  cpu {formatVcpuBare(cpuNow)}
                  {cpuCapacity && (
                    <span className="text-fg-muted">of {formatVcpu(cpuCapacity)}</span>
                  )}
                </span>
                <span className="shrink-0 text-fg-muted">set aside {formatVcpu(cpuSetAside)}</span>
              </div>
            </div>
          )}
          <ul className="m-0 flex list-none flex-col divide-y divide-[var(--sam-hairline)] p-0">
            {rows.map((r) => (
              <NodeSessionRow
                key={r.usage.workspaceId}
                usage={r.usage}
                now={r.now}
                liveMemory={r.live}
                windowStart={usageWindow?.windowStart ?? clock}
                windowEnd={usageWindow?.windowEnd ?? clock}
                bucketMs={usageWindow?.bucketMs ?? 60_000}
                clock={clock}
              />
            ))}
          </ul>
        </>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <details className="min-w-0 text-[11.5px] text-fg-muted">
          <summary className="cursor-pointer select-none">Advanced</summary>
          <div className="mt-2 flex flex-col gap-2">
            {rows.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {rows.map((r) => (
                  <li key={r.usage.workspaceId} className="min-w-0 truncate">
                    <Link
                      to={`/workspaces/${r.usage.workspaceId}`}
                      className="text-fg-muted underline decoration-dotted underline-offset-2 hover:text-fg-primary"
                    >
                      Workspace {r.usage.workspaceId.slice(-6).toLowerCase()}
                    </Link>{' '}
                    <span className="font-mono">{r.usage.workspaceId}</span>
                  </li>
                ))}
              </ul>
            )}
            <span className="[overflow-wrap:anywhere]">
              Node <span className="text-fg-primary">{node.name}</span> ·{' '}
              <span className="font-mono">{node.id}</span>
            </span>
            <HardwareDetails hardware={node} />
          </div>
        </details>
        <Link
          to={`/nodes/${node.id}`}
          className="inline-flex min-h-9 items-center gap-1 rounded-[var(--sam-radius-control)] px-2 text-[12.5px] text-fg-muted no-underline hover:text-fg-primary"
        >
          Details
          <ChevronRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </Pane>
  );
}
