import type { VMSize, VMLocation } from './common';
import type { CredentialProvider } from './credential';

// =============================================================================
// Node
// =============================================================================
export type NodeStatus = 'pending' | 'creating' | 'running' | 'stopping' | 'stopped' | 'deleted' | 'error';

export type NodeHealthStatus = 'healthy' | 'stale' | 'unhealthy';

export interface Node {
  id: string;
  userId: string;
  name: string;
  status: NodeStatus;
  healthStatus?: NodeHealthStatus;
  vmSize: VMSize;
  vmLocation: VMLocation;
  providerInstanceId: string | null;
  ipAddress: string | null;
  lastHeartbeatAt: string | null;
  heartbeatStaleAfterSeconds?: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Lightweight metrics from node heartbeat (stored in D1) */
export interface NodeMetrics {
  cpuLoadAvg1?: number;
  memoryPercent?: number;
  diskPercent?: number;
}

export interface NodeResponse {
  id: string;
  name: string;
  status: NodeStatus;
  healthStatus?: NodeHealthStatus;
  cloudProvider?: CredentialProvider | null;
  vmSize: VMSize;
  vmLocation: VMLocation;
  ipAddress: string | null;
  lastHeartbeatAt: string | null;
  heartbeatStaleAfterSeconds?: number;
  lastMetrics?: NodeMetrics | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Full system info from on-demand VM Agent endpoint */
export interface NodeSystemInfo {
  cpu: {
    loadAvg1: number;
    loadAvg5: number;
    loadAvg15: number;
    numCpu: number;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
  };
  disk: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
    mountPath: string;
  };
  network: {
    interface: string;
    rxBytes: number;
    txBytes: number;
  };
  uptime: {
    seconds: number;
    humanFormat: string;
  };
  docker: {
    version: string;
    containers: number;
    containerList: ContainerInfo[];
    error?: string | null;
  };
  software: {
    goVersion: string;
    nodeVersion: string;
    dockerVersion: string;
    devcontainerCliVersion: string;
  };
  agent: {
    version: string;
    buildDate: string;
    goRuntime: string;
    goroutines: number;
    heapBytes: number;
  };
}

export interface CreateNodeRequest {
  name: string;
  vmSize?: VMSize;
  vmLocation?: VMLocation;
  provider?: CredentialProvider;
}

// =============================================================================
// Node Lifecycle (Warm Node Pooling)
// =============================================================================

export type NodeLifecycleStatus = 'active' | 'warm' | 'destroying';

export interface NodeLifecycleState {
  nodeId: string;
  status: NodeLifecycleStatus;
  warmSince: string | null;
  claimedByTask: string | null;
}

// =============================================================================
// Node Observability — Log Types
// =============================================================================

/** Log entry from any source on the node */
export interface NodeLogEntry {
  timestamp: string; // ISO 8601
  level: NodeLogLevel;
  source: string; // e.g., "agent", "docker:ws-abc", "cloud-init"
  message: string;
  metadata?: Record<string, unknown>;
}

/** Log source filter values */
export type NodeLogSource = 'all' | 'agent' | 'cloud-init' | 'docker' | 'systemd';

/** Log level filter values */
export type NodeLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Parameters for log retrieval */
export interface NodeLogFilter {
  source?: NodeLogSource;
  level?: NodeLogLevel;
  container?: string;
  since?: string;
  until?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}

/** Response from log retrieval endpoint */
export interface NodeLogResponse {
  entries: NodeLogEntry[];
  nextCursor?: string | null;
  hasMore: boolean;
}

// =============================================================================
// Node Observability — Container Types
// =============================================================================

/** Machine-readable container state */
export type ContainerState =
  | 'running'
  | 'exited'
  | 'paused'
  | 'created'
  | 'restarting'
  | 'removing'
  | 'dead';

/** Container info with full state and metrics */
export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string; // Human-readable (e.g., "Up 2 hours")
  state: ContainerState; // Machine-readable enum
  cpuPercent: number;
  memUsage: string;
  memPercent: number;
  createdAt: string;
}
