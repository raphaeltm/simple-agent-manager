import type { CredentialProvider } from './user';

// =============================================================================
// Workspace & Node Core Types
// =============================================================================
export type NodeStatus = 'pending' | 'creating' | 'running' | 'stopping' | 'stopped' | 'deleted' | 'error';

export type NodeHealthStatus = 'healthy' | 'stale' | 'unhealthy';

export type WorkspaceStatus =
  | 'pending'
  | 'creating'
  | 'running'
  | 'recovery'
  | 'stopping'
  | 'stopped'
  | 'deleted'
  | 'error';

export type VMSize = 'small' | 'medium' | 'large';

/**
 * VM location identifier. Widened to string to support all providers:
 * - Hetzner: 'fsn1', 'nbg1', 'hel1', 'ash', 'hil'
 * - Scaleway: 'fr-par-1', 'nl-ams-1', 'pl-waw-1', etc.
 */
export type VMLocation = string;

/**
 * Workspace provisioning profile.
 * - 'full': Standard devcontainer build (project's .devcontainer config)
 * - 'lightweight': Skip devcontainer build, use minimal base image with git clone.
 *   Much faster startup (~20s vs ~2min) but no project-specific tooling.
 */
export type WorkspaceProfile = 'full' | 'lightweight';

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

export interface Workspace {
  id: string;
  nodeId?: string;
  userId: string;
  projectId?: string | null;
  installationId: string | null;
  name: string;
  displayName?: string;
  repository: string;
  branch: string;
  status: WorkspaceStatus;
  vmSize: VMSize;
  vmLocation: VMLocation;
  hetznerServerId: string | null;
  vmIp: string | null;
  dnsRecordId: string | null;
  lastActivityAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Boot log entry for workspace provisioning/bootstrap progress */
export interface BootLogEntry {
  step: string;
  status: 'started' | 'completed' | 'failed';
  message: string;
  detail?: string;
  timestamp: string;
}

/** API response (includes computed URL) */
export interface WorkspaceResponse {
  id: string;
  nodeId?: string;
  projectId?: string | null;
  name: string;
  displayName?: string;
  repository: string;
  branch: string;
  status: WorkspaceStatus;
  vmSize: VMSize;
  vmLocation: VMLocation;
  workspaceProfile?: WorkspaceProfile | null;
  /** Selected devcontainer config name (subdirectory under .devcontainer/). null = auto-discover default. */
  devcontainerConfigName?: string | null;
  vmIp: string | null;
  lastActivityAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  url?: string;
  bootLogs?: BootLogEntry[];
  /** Linked project chat session ID (DO-managed) — present when workspace was created via project chat. */
  chatSessionId?: string | null;
}

export interface CreateWorkspaceRequest {
  name: string;
  projectId: string;
  nodeId?: string;
  repository?: string;
  branch?: string;
  vmSize?: VMSize;
  vmLocation?: VMLocation;
  installationId?: string;
  provider?: CredentialProvider;
  /** Devcontainer config name (subdirectory under .devcontainer/). null/undefined = auto-discover default. */
  devcontainerConfigName?: string | null;
}

export interface UpdateWorkspaceRequest {
  displayName: string;
}

export type EventLevel = 'info' | 'warn' | 'error';

export interface Event {
  id: string;
  nodeId?: string | null;
  workspaceId?: string | null;
  level: EventLevel;
  type: string;
  message: string;
  detail?: Record<string, unknown> | null;
  createdAt: string;
}

/** A port detected listening inside a workspace container. */
export interface DetectedPort {
  port: number;
  address: string;
  label: string;
  url: string;
  detectedAt: string;
}

/** Response from GET /workspaces/{id}/ports on the VM agent. */
export interface PortsResponse {
  ports: DetectedPort[];
}

// =============================================================================
// Browser Sidecar (Neko)
// =============================================================================

/**
 * Known sidecar aliases for named subdomain routing.
 * Used in ws-{id}--{alias}.{domain} patterns to route to sidecar containers
 * instead of DevContainer ports.
 */
export const SIDECAR_ALIASES = ['browser'] as const;
export type SidecarAlias = (typeof SIDECAR_ALIASES)[number];

/** Check if a string is a valid sidecar alias. */
export function isSidecarAlias(value: string): value is SidecarAlias {
  return (SIDECAR_ALIASES as readonly string[]).includes(value);
}

/** Status of the Neko browser sidecar container. */
export type BrowserSidecarStatus = 'off' | 'starting' | 'running' | 'stopping' | 'error';

/** Request body for POST /workspaces/{id}/browser — start browser sidecar. */
export interface StartBrowserSidecarRequest {
  /** Viewport width in pixels (e.g. 1920). Overrides NEKO_SCREEN_RESOLUTION. */
  viewportWidth?: number;
  /** Viewport height in pixels (e.g. 1080). Overrides NEKO_SCREEN_RESOLUTION. */
  viewportHeight?: number;
  /** Device pixel ratio for mobile emulation (e.g. 2 for Retina). */
  devicePixelRatio?: number;
  /** Whether the client is a touch device — enables Chrome mobile emulation flags. */
  isTouchDevice?: boolean;
  /** Enable audio streaming (overrides NEKO_ENABLE_AUDIO). */
  enableAudio?: boolean;
}

/** Response from GET /workspaces/{id}/browser — sidecar status. */
export interface BrowserSidecarResponse {
  status: BrowserSidecarStatus;
  /** Neko WebRTC HTTP port on the workspace network (typically 8080). */
  nekoPort?: number;
  /** Full URL for accessing the Neko client via SAM port proxy. */
  url?: string;
  /** Neko container name for diagnostics. */
  containerName?: string;
  /** Error message if status is 'error'. */
  error?: string;
  /** Active socat forwarders. */
  ports?: BrowserSidecarPortInfo[];
}

/** Info about a single socat port forwarder running inside the Neko container. */
export interface BrowserSidecarPortInfo {
  /** Port number being forwarded (e.g. 3000). */
  port: number;
  /** Target host inside the Docker network (the DevContainer name). */
  targetHost: string;
  /** Whether the socat process is currently active. */
  active: boolean;
}

/** Response from GET /workspaces/{id}/browser/ports — list active forwarders. */
export interface BrowserSidecarPortsResponse {
  ports: BrowserSidecarPortInfo[];
}

// =============================================================================
// Bootstrap Token (Secure Credential Delivery)
// =============================================================================

/** Internal: Bootstrap token data stored in KV */
export interface BootstrapTokenData {
  workspaceId: string;
  encryptedHetznerToken: string;
  hetznerTokenIv: string;
  callbackToken: string;
  encryptedGithubToken: string | null;
  githubTokenIv: string | null;
  gitUserName?: string | null;
  gitUserEmail?: string | null;
  githubId?: string | null;
  createdAt: string;
}

/** API response when VM redeems bootstrap token */
export interface BootstrapResponse {
  workspaceId: string;
  hetznerToken: string;
  callbackToken: string;
  githubToken: string | null;
  gitUserName?: string | null;
  gitUserEmail?: string | null;
  githubId?: string | null;
  controlPlaneUrl: string;
}

export interface WorkspaceRuntimeEnvVar {
  key: string;
  value: string;
  isSecret: boolean;
}

export interface WorkspaceRuntimeFile {
  path: string;
  content: string;
  isSecret: boolean;
}

export interface WorkspaceRuntimeAssetsResponse {
  workspaceId: string;
  envVars: WorkspaceRuntimeEnvVar[];
  files: WorkspaceRuntimeFile[];
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
