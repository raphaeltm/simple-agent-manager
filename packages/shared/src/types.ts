// =============================================================================
// User
// =============================================================================
export interface User {
  id: string;
  githubId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Credential
// =============================================================================
export type CredentialProvider = 'hetzner';

export interface Credential {
  id: string;
  userId: string;
  provider: CredentialProvider;
  encryptedToken: string;
  iv: string;
  createdAt: string;
  updatedAt: string;
}

/** API response (safe to expose - no encrypted data) */
export interface CredentialResponse {
  id: string;
  provider: CredentialProvider;
  connected: boolean;
  createdAt: string;
}

export interface CreateCredentialRequest {
  provider: CredentialProvider;
  token: string;
}

// =============================================================================
// GitHub Installation
// =============================================================================
export type AccountType = 'personal' | 'organization';

export interface GitHubInstallation {
  id: string;
  userId: string;
  installationId: string;
  accountType: AccountType;
  accountName: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repository {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  installationId: string;
}

export interface Branch {
  name: string;
  isDefault: boolean;
}

/** GitHub repository returned from GitHub API */
export interface GitHubRepository {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
}

/** GitHub installation token */
export interface GitHubInstallationToken {
  token: string;
  expiresAt: string;
  repositories: string[];
  permissions: {
    contents?: string;
  };
}

/** GitHub connection status */
export interface GitHubConnection {
  installationId: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  installedAt: string;
  repositories: string[];
  status: 'active' | 'suspended' | 'pending';
  lastTokenAt: string | null;
}

// =============================================================================
// Workspace
// =============================================================================
export type NodeStatus = 'pending' | 'creating' | 'running' | 'stopping' | 'stopped' | 'error';

export type NodeHealthStatus = 'healthy' | 'stale' | 'unhealthy';

export type WorkspaceStatus =
  | 'pending'
  | 'creating'
  | 'running'
  | 'recovery'
  | 'stopping'
  | 'stopped'
  | 'error';

export type VMSize = 'small' | 'medium' | 'large';

export type VMLocation = 'nbg1' | 'fsn1' | 'hel1';

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
    containerList: Array<{
      id: string;
      name: string;
      image: string;
      status: string;
      cpuPercent: number;
      memUsage: string;
      memPercent: number;
    }>;
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
}

export interface Workspace {
  id: string;
  nodeId?: string;
  userId: string;
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
  shutdownDeadline: string | null;
  idleTimeoutSeconds: number;
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
  name: string;
  displayName?: string;
  repository: string;
  branch: string;
  status: WorkspaceStatus;
  vmSize: VMSize;
  vmLocation: VMLocation;
  vmIp: string | null;
  lastActivityAt: string | null;
  errorMessage: string | null;
  shutdownDeadline: string | null;
  idleTimeoutSeconds: number;
  createdAt: string;
  updatedAt: string;
  url?: string;
  bootLogs?: BootLogEntry[];
}

export interface CreateWorkspaceRequest {
  name: string;
  nodeId?: string;
  repository: string;
  branch?: string;
  vmSize?: VMSize;
  vmLocation?: VMLocation;
  installationId: string;
  idleTimeoutSeconds?: number;
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

export type AgentSessionStatus = 'running' | 'stopped' | 'error';

export interface WorktreeInfo {
  path: string;
  branch: string;
  headCommit: string;
  isPrimary: boolean;
  isDirty: boolean;
  dirtyFileCount: number;
  isPrunable?: boolean;
}

export interface WorktreeListResponse {
  worktrees: WorktreeInfo[];
}

export interface CreateWorktreeRequest {
  branch: string;
  createBranch?: boolean;
  baseBranch?: string;
}

export interface RemoveWorktreeResponse {
  removed: string;
}

export interface AgentSession {
  id: string;
  workspaceId: string;
  status: AgentSessionStatus;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string | null;
  errorMessage?: string | null;
  label?: string | null;
  worktreePath?: string | null;
}

export interface CreateAgentSessionRequest {
  label?: string;
  worktreePath?: string;
}

export interface UpdateAgentSessionRequest {
  label: string;
}

// =============================================================================
// Heartbeat
// =============================================================================
export interface HeartbeatRequest {
  workspaceId?: string;
  idleSeconds: number;
  idle: boolean;
  lastActivityAt: string;
  shutdownDeadline?: string;
}

export interface HeartbeatResponse {
  action: 'continue' | 'shutdown';
  idleSeconds: number;
  maxIdleSeconds: number;
  shutdownDeadline: string | null;
}

// =============================================================================
// Terminal
// =============================================================================
export interface TerminalTokenRequest {
  workspaceId: string;
}

export interface TerminalTokenResponse {
  token: string;
  expiresAt: string;
  workspaceUrl?: string;
}

// =============================================================================
// Workspace Tabs (Persisted Session State)
// =============================================================================

/** A persisted workspace tab (terminal or chat session) from the VM agent. */
export interface WorkspaceTab {
  id: string;
  workspaceId: string;
  type: 'terminal' | 'chat';
  label: string;
  agentId: string;
  sortOrder: number;
  createdAt: string;
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
  controlPlaneUrl: string;
}

// =============================================================================
// API Error
// =============================================================================
export interface ApiError {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

// =============================================================================
// Agent Settings (per-user, per-agent configuration)
// =============================================================================

/** Valid permission modes for agent sessions */
export type AgentPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions';

/** Agent settings stored per-user, per-agent in D1 */
export interface AgentSettings {
  id: string;
  agentType: string;
  model: string | null;
  permissionMode: AgentPermissionMode | null;
  allowedTools: string[] | null;
  deniedTools: string[] | null;
  additionalEnv: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
}

/** API response for GET /api/agent-settings/:agentType */
export interface AgentSettingsResponse {
  agentType: string;
  model: string | null;
  permissionMode: AgentPermissionMode | null;
  allowedTools: string[] | null;
  deniedTools: string[] | null;
  additionalEnv: Record<string, string> | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Request body for PUT /api/agent-settings/:agentType */
export interface SaveAgentSettingsRequest {
  model?: string | null;
  permissionMode?: AgentPermissionMode | null;
  allowedTools?: string[] | null;
  deniedTools?: string[] | null;
  additionalEnv?: Record<string, string> | null;
}
