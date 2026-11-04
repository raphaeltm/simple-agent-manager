import type { WorkspaceStatus } from './workspace';

/**
 * Per-workspace CPU and memory for the Nodes page (`GET /api/nodes/resource-usage`).
 *
 * History comes from the VM agent's resource chunks, which arrive in batches (every 15
 * minutes by default), so the newest minutes of `series` fill in later. Live memory is
 * in each node's `lastMetrics.workspaceMemory` from the heartbeat.
 */
export interface NodeResourceReservation {
  cpuMillis: number;
  memoryMb: number;
  diskMb: number;
  exclusiveNode: boolean;
}

/** Per-minute buckets, ascending. `null` means the bucket had no samples for that metric. */
export interface NodeResourceUsageSeries {
  /** Bucket start, epoch milliseconds. */
  start: number[];
  cpuMillis: Array<number | null>;
  memoryBytes: Array<number | null>;
}

export interface NodeWorkspaceResourceUsage {
  workspaceId: string;
  nodeId: string;
  projectId: string | null;
  projectName: string | null;
  chatSessionId: string | null;
  /** Chat topic, then task title, then the workspace's display name. */
  title: string;
  ownerUserId: string | null;
  ownerName: string | null;
  isMine: boolean;
  status: WorkspaceStatus;
  createdAt: string;
  reservation: NodeResourceReservation | null;
  series: NodeResourceUsageSeries;
  /** End of the newest history bucket, epoch milliseconds; null when there is no history. */
  historyEndsAt: number | null;
  /** True when this workspace's history was left out because the request hit its cap. */
  historyOmitted: boolean;
}

export interface NodeResourceUsageResponse {
  windowMinutes: number;
  /** Epoch milliseconds. */
  windowStart: number;
  windowEnd: number;
  bucketMs: number;
  /** Workspaces whose history was left out because the request hit its cap. */
  historyOmittedCount: number;
  workspaces: NodeWorkspaceResourceUsage[];
}
