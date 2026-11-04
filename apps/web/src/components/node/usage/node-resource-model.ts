/**
 * Pure helpers behind the Nodes page's CPU and memory view.
 *
 * Two sources meet here. History (`GET /api/nodes/resource-usage`) is per-minute and
 * arrives from the VM agent in batches, so its newest minutes are missing for up to the
 * agent's upload interval. Live memory rides on each heartbeat in
 * `node.lastMetrics.workspaceMemory` and is at most about a minute old. "Now" for memory
 * prefers the live value; "now" for CPU is the newest history minute, because no live
 * per-workspace CPU exists.
 */
import type {
  NodeResourceUsageSeries,
  NodeResponse,
  NodeWorkspaceResourceUsage,
} from '@simple-agent-manager/shared';
import {
  DEFAULT_NODE_HEARTBEAT_STALE_SECONDS,
  PROVIDER_LABELS,
  VM_LOCATIONS,
} from '@simple-agent-manager/shared';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** `providerInstanceType` of an Instant (Cloudflare container) node. */
const INSTANT_CONTAINER_TYPE = 'cf-container';

export interface MachineSpec {
  title: string;
  location: string;
  vcpu: number | null;
  memoryMb: number | null;
  diskGb: number | null;
}

/** A machine is named for what it is (provider, type, location), never for the task that started it. */
export function machineSpec(node: NodeResponse): MachineSpec {
  const provider = node.cloudProvider
    ? (PROVIDER_LABELS[node.cloudProvider] ?? node.cloudProvider)
    : null;
  const type = node.observedProviderInstanceType || node.providerInstanceType || null;
  const location = VM_LOCATIONS[node.vmLocation];
  // Instant sessions run in a Cloudflare container, not a VM with a provider type.
  const instant = type === INSTANT_CONTAINER_TYPE;
  return {
    title: instant ? 'Instant container' : [provider, type].filter(Boolean).join(' ') || node.name,
    location: instant
      ? 'Cloudflare'
      : location
        ? `${location.name}, ${location.country}`
        : node.vmLocation,
    vcpu: node.observedProviderInstanceVcpuCount ?? node.providerInstanceVcpuCount ?? null,
    memoryMb: node.observedProviderInstanceMemoryMb ?? node.providerInstanceMemoryMb ?? null,
    diskGb: node.observedProviderInstanceDiskGb ?? node.providerInstanceDiskGb ?? null,
  };
}

export function specLine(spec: MachineSpec): string {
  return [
    spec.vcpu ? `${spec.vcpu} vCPU` : null,
    spec.memoryMb ? `${Math.round(spec.memoryMb / 1024)} GB` : null,
    spec.diskGb ? `${spec.diskGb} GB disk` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Live memory per workspace from the node's last heartbeat, dropped once the heartbeat is
 * stale so a dead node does not keep showing its last reading as "now".
 */
export function liveMemoryByWorkspace(node: NodeResponse, now: number): Map<string, number> {
  const result = new Map<string, number>();
  const staleMs = (node.heartbeatStaleAfterSeconds ?? DEFAULT_NODE_HEARTBEAT_STALE_SECONDS) * 1000;
  const heartbeatAt = timestampMs(node.lastHeartbeatAt);
  for (const entry of node.lastMetrics?.workspaceMemory ?? []) {
    const at = timestampMs(entry.collectedAt) ?? heartbeatAt;
    if (at === null || now - at > staleMs) continue;
    if (Number.isFinite(entry.memoryUsageBytes) && entry.memoryUsageBytes >= 0) {
      result.set(entry.workspaceId, entry.memoryUsageBytes);
    }
  }
  return result;
}

export interface LatestValue {
  value: number;
  /** Bucket start, epoch ms. */
  at: number;
}

export function latest(start: number[], values: Array<number | null>): LatestValue | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    const at = start[i];
    if (value != null && at != null) return { value, at };
  }
  return null;
}

/** Sums sessions' per-minute series into one machine series, aligned on bucket start. */
export function sumSeries(series: NodeResourceUsageSeries[]): NodeResourceUsageSeries {
  const byStart = new Map<number, { cpu: number | null; memory: number | null }>();
  for (const s of series) {
    s.start.forEach((start, i) => {
      const bucket = byStart.get(start) ?? { cpu: null, memory: null };
      const cpu = s.cpuMillis[i];
      const memory = s.memoryBytes[i];
      if (cpu != null) bucket.cpu = (bucket.cpu ?? 0) + cpu;
      if (memory != null) bucket.memory = (bucket.memory ?? 0) + memory;
      byStart.set(start, bucket);
    });
  }
  const starts = [...byStart.keys()].sort((a, b) => a - b);
  return {
    start: starts,
    cpuMillis: starts.map((s) => byStart.get(s)?.cpu ?? null),
    memoryBytes: starts.map((s) => byStart.get(s)?.memory ?? null),
  };
}

export interface SessionNow {
  memoryBytes: number | null;
  memoryIsLive: boolean;
  cpuMillis: number | null;
  /** When the CPU reading was taken (bucket start), epoch ms. */
  cpuAt: number | null;
  reservedMemoryBytes: number | null;
  reservedCpuMillis: number | null;
  /** Memory is not compressible: going over the reservation is how an OOM kill starts. */
  memoryOver: boolean;
  /** CPU is compressible: going over makes work slower, not broken. */
  cpuOver: boolean;
}

export function sessionNow(
  usage: Pick<NodeWorkspaceResourceUsage, 'series' | 'reservation'>,
  liveMemory: number | undefined
): SessionNow {
  const memoryHistory = latest(usage.series.start, usage.series.memoryBytes);
  const cpuHistory = latest(usage.series.start, usage.series.cpuMillis);
  const memoryBytes = liveMemory ?? memoryHistory?.value ?? null;
  const reservedMemoryBytes = usage.reservation ? usage.reservation.memoryMb * MB : null;
  const reservedCpuMillis = usage.reservation ? usage.reservation.cpuMillis : null;
  const cpuMillis = cpuHistory?.value ?? null;
  return {
    memoryBytes,
    memoryIsLive: liveMemory !== undefined,
    cpuMillis,
    cpuAt: cpuHistory?.at ?? null,
    reservedMemoryBytes,
    reservedCpuMillis,
    memoryOver:
      memoryBytes != null && reservedMemoryBytes != null && memoryBytes > reservedMemoryBytes,
    cpuOver: cpuMillis != null && reservedCpuMillis != null && cpuMillis > reservedCpuMillis,
  };
}

export function formatGb(bytes: number): string {
  const gb = bytes / GB;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  return `${(Math.round(gb * 10) / 10).toFixed(1)} GB`;
}

export function formatGbBare(bytes: number): string {
  return formatGb(bytes).replace(' GB', '');
}

export function formatVcpu(millis: number): string {
  if (millis > 0 && millis < 100) return '<0.1 vCPU';
  const v = millis / 1000;
  if (v >= 10) return `${Math.round(v)} vCPU`;
  return `${(Math.round(v * 10) / 10).toFixed(1)} vCPU`;
}

export function formatVcpuBare(millis: number): string {
  return formatVcpu(millis).replace(' vCPU', '');
}

export function formatAge(fromMs: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - fromMs) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}
